import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/analyse";
import { show } from "../src/commands";
import { buildPacket } from "../src/curate";
import { actionKey } from "../src/eval";
import { init } from "../src/init";
import { today } from "../src/model";
import { DIR, loadProject } from "../src/project";
import { apply } from "../src/proposals";
import packetSchema from "../schema/packet.json";
import { check } from "./jsonschema";

let root: string;
let n = 0;
const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const entry = async (id: string) => (await loadProject(root)).byId.get(id)?.[0];
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const run = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
async function proposals(actions: object[], mode = "insight") {
  const path = join(root, `p${n++}.json`);
  await Bun.write(path, JSON.stringify({ mode, made: "2026-10-07", by: "test", actions }));
  return path;
}

const done = (id: string, title: string, body: string, meta = "") => `## ${id} · ${title}\ndone: 2026-09-01${meta}\n\n${body}\n`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-insight-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
  await write("config.json", '{"owner": "shaun"}\n');
  await write("todo.md", "# Todo\n\n## T004 · Use the memo\npriority: P2 · added: 2026-09-01 · refs: T002\n");
  await write(
    "done.md",
    "# Done\n\n" +
      [
        done("T001", "Jacobian reuse", "Columns share the base reading: 40% faster.", " · tags: c-reuse"),
        done("T002", "Integrator memo", "Dropped: no hits at all.\n\n**Why:** inputs never repeat exactly.", " · tags: c-reuse, perf"),
        done("T003", "Declared reads", "Every leg declares its reads.", " · tags: c-reuse"),
      ].join("\n"),
  );
  await write("answers.md", "# Answers\n\n## A001 · old way\nanswered: 2026-08-01 · superseded-by: A002\n\n**Question** ?\n\n## A002 · new way\nanswered: 2026-09-01 · supersedes: A001\n\n**Question** ?\n");
  await write("log/curation.md", '# Curation log\n\n- 2026-10-01T06:40Z cluster T001: c-reuse on T001, T002, T003 ("reuse") (gather by tiny, curate x): all reuse earlier evaluations\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const THEME = {
  kind: "T",
  title: "Reusing evaluations",
  body: "- Jacobian columns share the base reading: 40% faster (T001).\n- Every leg declares its reads (T003).\n- The integrator memo was dropped (T002): no hits.\n\n**Why:** inputs never repeat exactly (T002).",
};
const CONDENSE = { action: "condense", from: ["T001", "T002", "T003"], into: THEME, importance: "low", why: "one line of work" };

describe("the insight packet", () => {
  test("a gather cluster becomes a case carrying its label and reason; every action is allowed", async () => {
    const log = await Bun.file(join(root, DIR, "log/curation.md")).text();
    const packet = buildPacket(await loadProject(root), { mode: "insight", log });
    expect(check(packetSchema, packet)).toEqual([]);
    const c = packet.cases.find((x) => x.kind === "cluster")!;
    expect(c.entries.map((e) => e.id)).toEqual(["T001", "T002", "T003"]);
    expect(c.evidence).toBe('gather cluster c-reuse: "reuse" (gather by tiny, curate x): all reuse earlier evaluations');
    expect(c.allowed).toContain("condense");
    expect(packet.mode).toBe("insight");
  });
});

describe("condense", () => {
  test("writes a theme entry and moves its sources at once, clearing their cluster tag; old IDs lead to the theme", async () => {
    const applied = await apply(root, await proposals([CONDENSE]));
    expect(applied[0].result).toBe('T005 "Reusing evaluations" in done.md, from T001, T002, T003');
    const theme = (await entry("T005"))!;
    expect(theme.file).toBe("done.md");
    expect(theme.meta).toEqual({ kind: "theme", done: today(), "condensed-from": "T001, T002, T003", refs: "T001, T002, T003" });
    expect(theme.body).toContain("**Why:** inputs never repeat exactly (T002).");
    for (const id of ["T001", "T002", "T003"]) {
      const e = (await entry(id))!;
      expect(e.file).toBe("archive/done-2026.md");
      expect(e.meta["condensed-into"]).toBe("T005");
      expect(e.meta.importance).toBe("low");
      expect(e.meta.tags ?? "").not.toContain("c-reuse");
    }
    expect((await entry("T002"))!.meta.tags).toBe("perf");
    const project = await loadProject(root);
    expect(show(project, "T002", { links: true }).current).toBe("T005");
    expect(lint(project)).toEqual([]);
  });

  test("refused: a body naming no source, a dropped reason, a chain cut, and condense in a gather run", async () => {
    const before = await Bun.file(join(root, DIR, "done.md")).text();
    const nameless = await proposals([{ ...CONDENSE, into: { ...THEME, body: "Reuse made it faster.\n\n**Why:** inputs never repeat." } }]);
    await expect(apply(root, nameless)).rejects.toThrow(/names none of its sources/);
    const reasonless = await proposals([{ ...CONDENSE, into: { ...THEME, body: "T001, T002 and T003 reused evaluations." } }]);
    await expect(apply(root, reasonless)).rejects.toThrow(/T002 gives a reason \(\*\*Why\*\*\); the theme must keep it/);
    const chain = await proposals([{ action: "condense", from: ["A002", "T004"], into: { kind: "A", title: "x", body: "A002 and T004." }, why: "w" }]);
    await expect(apply(root, chain)).rejects.toThrow(/A002 supersedes A001: condensing A002 alone would leave A001's chain ending in the archive/);
    await expect(apply(root, await proposals([CONDENSE], "gather"))).rejects.toThrow(/a gather run may not condense/);
    expect(await Bun.file(join(root, DIR, "done.md")).text()).toBe(before);
  });

  test("an insight archive is a real move", async () => {
    await apply(root, await proposals([{ action: "archive", id: "T003", why: "old" }]));
    expect((await entry("T003"))!.file).toBe("archive/done-2026.md");
  });

  test("the evaluation compares a condense by its sources only", () => {
    const a = actionKey(CONDENSE as any);
    expect(a).toBe("condense T001,T002,T003");
    expect(actionKey({ ...CONDENSE, into: { ...THEME, title: "other" } } as any)).toBe(a);
  });
});

describe("an insight run", () => {
  test("is always queued, and never applied directly", async () => {
    const curator = join(root, "c.ts");
    await Bun.write(curator, `const p = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ mode: "insight", packet: p.packet, made: "2026-10-07", by: "c", actions: [${JSON.stringify(CONDENSE)}] }));`);
    expect(run("curate", "--mode", "insight", "--curator", `bun ${curator}`, "--apply").code).toBe(2);
    const r = run("curate", "--mode", "insight", "--curator", `bun ${curator}`);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/queued 1 action as \S+-insight\.json/);
    expect((await entry("T001"))!.file).toBe("done.md");
    const name = readdirSync(join(root, DIR, "proposals")).find((f) => f.endsWith("-insight.json"))!;
    expect(run("proposals", "show", name).out).toContain('condense into T "Reusing evaluations" (active)');
    expect(run("apply", name).code).toBe(0);
    expect((await entry("T001"))!.meta["condensed-into"]).toBe("T005");
    expect(existsSync(join(root, DIR, "proposals", "applied", name))).toBe(true);
  });
});

test("proposals add queues a hand-written file after a dry run, and refuses one that would fail", async () => {
  const good = await proposals([CONDENSE]);
  const r = run("proposals", "add", good);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/queued 1 action as \S+-insight\.json/);
  expect((await entry("T001"))!.file).toBe("done.md");
  const bad = await proposals([{ ...CONDENSE, into: { ...THEME, body: "nothing named" } }]);
  expect(run("proposals", "add", bad).code).toBe(2);
});
