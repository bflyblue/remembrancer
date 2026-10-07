import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/analyse";
import { buildPacket, similarGroups } from "../src/curate";
import { init } from "../src/init";
import { DIR, loadProject } from "../src/project";
import { apply, clusterTag } from "../src/proposals";
import actionSchema from "../schema/action.json";
import packetSchema from "../schema/packet.json";
import proposalsSchema from "../schema/proposals.json";
import { check } from "./jsonschema";

let root: string;
const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const CURATOR = join(import.meta.dir, "..", "curators", "openai-compatible.ts");
const run = (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root, env: { ...process.env, ...env } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
// Async, so a stub server in this process can answer the curator.
const runAsync = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(["bun", CLI, ...args], { cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};
const todo = (id: string, title: string, meta = "") => `## ${id} · ${title}\npriority: P2 · added: 2026-10-01${meta}\n\nAbout ${title.toLowerCase()}.\n`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-curate-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
  await write("config.json", '{"owner": "shaun"}\n');
  await write(
    "todo.md",
    "# Todo\n\n" +
      [
        todo("T001", "Radiator panel sizing", " · tags: radiators"),
        todo("T002", "Radiator mass budget", " · tags: radiators"),
        todo("T003", "Heat pipe layout", " · tags: radiators"),
        todo("T004", "Render the rings"),
        "## T005 · a quick thought\nstatus: inbox · added: 2026-10-01\n",
      ].join("\n"),
  );
  await write("answers.md", "# Answers\n\n## A001 · Rings are a texture\nanswered: 2026-10-01\n\n**Question** How to draw rings?\n\nA texture.\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the packet", () => {
  test("validates against its schema; no entry is in two cases; shared tags make a similar case", async () => {
    const packet = buildPacket(await loadProject(root));
    expect(check(packetSchema, packet)).toEqual([]);
    const ids = packet.cases.flatMap((c) => c.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    const radiators = packet.cases.find((c) => c.kind === "similar" && c.entries.some((e) => e.id === "T001"))!;
    expect(radiators.entries.map((e) => e.id).sort()).toEqual(["T001", "T002", "T003"]);
    expect(radiators.evidence).toContain("shared tag radiators");
    expect(radiators.allowed).toContain("cluster");
    expect(packet.cases.find((c) => c.kind === "inbox")!.entries.map((e) => e.id)).toEqual(["T005"]);
    expect(packet.packet).toMatch(/^[0-9a-f]+$/);
  });

  test("a group never passes twelve members", async () => {
    await write("todo.md", "# Todo\n\n" + Array.from({ length: 30 }, (_, i) => todo(`T${String(i + 1).padStart(3, "0")}`, "Radiator sizing", " · tags: radiators")).join("\n"));
    const groups = similarGroups((await loadProject(root)).entries.filter((e) => e.file === "todo.md"));
    expect(Math.max(...groups.map((g) => g.members.length))).toBeLessThanOrEqual(12);
  });
});

describe("cluster", () => {
  test("tags every member c-<label>, lints clean, and logs the group", async () => {
    const path = join(root, "p.json");
    const p = { mode: "gather", packet: null, made: "2026-10-07", by: "test", actions: [{ action: "cluster", case: "c1", label: "Radiator sizing!", members: ["T001", "T002", "T003"], why: "all about radiators" }] };
    expect(check(proposalsSchema, p, { "action.json": actionSchema })).toEqual([]);
    await Bun.write(path, JSON.stringify(p));
    expect(clusterTag("Radiator sizing!")).toBe("c-radiator-sizing");
    const applied = await apply(root, path);
    expect(applied[0].result).toBe('c-radiator-sizing on T001, T002, T003 ("Radiator sizing!")');
    const project = await loadProject(root);
    for (const id of ["T001", "T002", "T003"]) expect(project.byId.get(id)![0].meta.tags).toBe("radiators, c-radiator-sizing");
    expect(lint(project)).toEqual([]);
    expect(await Bun.file(join(root, DIR, "log/curation.md")).text()).toContain("cluster T001: c-radiator-sizing on T001, T002, T003");
  });

  test("a gather file with condense is refused by name", async () => {
    await Bun.write(join(root, "p.json"), JSON.stringify({ mode: "gather", made: "2026-10-07", by: "x", actions: [{ action: "condense", id: "T001", why: "x" }] }));
    const r = run(["apply", "p.json"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("a gather run may not condense");
  });
});

describe("curators", () => {
  test("--curator pipes the packet to a script and dry-runs what it returns, applying nothing", async () => {
    const fake = join(root, "fake.ts");
    await Bun.write(
      fake,
      `const p = JSON.parse(await Bun.stdin.text());
       console.log(JSON.stringify({ mode: "gather", packet: p.packet, made: "2026-10-07", by: "fake",
         actions: [ { action: "cluster", label: "radiators", members: ["T001", "T002"], why: "both size radiators" },
                    { action: "flag", id: "T005", note: "needs a priority", why: "inbox" } ] }));`,
    );
    const before = await Bun.file(join(root, DIR, "todo.md")).text();
    const r = run(["curate", "--mode", "gather", "--curator", `bun ${fake}`, "--save", "saved.json"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("cluster T001: c-radiators on T001, T002");
    expect(r.out).toContain("dry run: 2 actions would apply; nothing written. To apply: remembrancer apply saved.json");
    expect(await Bun.file(join(root, DIR, "todo.md")).text()).toBe(before);
    expect(run(["apply", "saved.json"]).code).toBe(0);

    await Bun.write(fake, `await Bun.stdin.text(); console.log(JSON.stringify({ mode: "gather", packet: "other", made: "2026-10-07", by: "f", actions: [ { action: "flag", id: "T005", note: "n", why: "w" } ] }));`);
    const stale = run(["curate", "--mode", "gather", "--curator", `bun ${fake}`]);
    expect(stale.code).toBe(2);
    expect(stale.err).toContain("the proposals answer packet other");
  });

  test("the OpenAI-compatible curator sends chat-completions requests with a JSON schema, retries once, and its output dry-runs", { timeout: 30_000 }, async () => {
    const requests: any[] = [];
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        requests.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body });
        const c = JSON.parse(body.messages[1].content);
        calls++;
        // The first answer is wrong (an ID outside the case); the retry is right.
        const actions =
          calls === 1
            ? [{ action: "flag", id: "T999", note: "n", why: "w" }]
            : c.kind === "similar"
              ? [{ action: "cluster", label: "radiators", members: c.entries.map((e: any) => e.id), why: "they share radiators" }]
              : [];
        return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ actions }) } }] });
      },
    });
    try {
      const env = { REMEMBRANCER_LLM_URL: `http://127.0.0.1:${server.port}/v1/`, REMEMBRANCER_LLM_MODEL: "tiny", REMEMBRANCER_LLM_KEY: "sekrit" };
      const r = await runAsync(["curate", "--mode", "gather", "--curator", `bun ${CURATOR}`, "--save", "out.json"], env);
      expect(r.err).toContain("c1 (1/");
      expect(r.code).toBe(0);
      expect(r.out).toContain("cluster T001: c-radiators on T001, T002, T003");
      const first = requests[0];
      expect(first.path).toBe("/v1/chat/completions");
      expect(first.auth).toBe("Bearer sekrit");
      expect(first.body).toMatchObject({ model: "tiny", temperature: 0, response_format: { type: "json_schema", json_schema: { name: "gather_actions", strict: false } } });
      expect(first.body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
      expect(first.body.messages[0].content).toContain("You curate a project's working memory");
      // The similar case's schema allows a cluster of its own entries, and nothing outside it.
      const similar = requests.find((q) => JSON.parse(q.body.messages[1].content).kind === "similar")!;
      const schema = similar.body.response_format.json_schema.schema;
      expect(JSON.stringify(schema)).not.toContain("$ref");
      expect(check(schema, { actions: [{ action: "cluster", label: "x", members: ["T001", "T002"], why: "w" }] })).toEqual([]);
      expect(check(schema, { actions: [{ action: "flag", id: "T999", note: "n", why: "w" }] }).length).toBeGreaterThan(0);
      // The retry carries the wrong answer and its problems.
      expect(requests[1].body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
      expect(requests[1].body.messages[3].content).toContain("T999 is not one of this case's entries");
      const saved = await Bun.file(join(root, "out.json")).json();
      expect(saved).toMatchObject({ mode: "gather", by: "openai-compatible:tiny" });
      expect(check(proposalsSchema, saved, { "action.json": actionSchema })).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
