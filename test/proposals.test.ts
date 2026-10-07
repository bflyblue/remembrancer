import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/analyse";
import { show } from "../src/commands";
import { init } from "../src/init";
import { today } from "../src/model";
import { ACTIONS, MODES, apply, validate } from "../src/proposals";
import { DIR, listFiles, loadProject } from "../src/project";
import { serve } from "../src/server";
import { stale } from "../src/signals";
import actionSchema from "../schema/action.json";
import proposalsSchema from "../schema/proposals.json";

let root: string;

const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const read = (rel: string) => Bun.file(join(root, DIR, rel)).text();
const entry = async (id: string) => (await loadProject(root)).byId.get(id)?.[0];
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const cli = (args: string[]) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

let n = 0;
async function proposals(actions: object[], mode = "manual") {
  const path = join(root, `proposals-${n++}.json`);
  await Bun.write(path, JSON.stringify({ mode, packet: null, made: "2026-10-07", by: "test", actions }));
  return path;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-apply-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
  await write("config.json", '{"owner": "shaun"}\n');
  await write("todo.md", "# Todo\n\n## T001 · keep me\npriority: P1 · added: 2026-01-01\n\n## T002 · drop me\npriority: P3 · added: 2026-01-01\n\nOld idea.\n\n## T003 · tag me\npriority: P2 · added: 2026-10-01 · tags: old\n");
  await write("done.md", "# Done\n\n## T004 · long done\ndone: 2025-06-01\n");
  await write("questions.md", "# Questions\n\n## Q001 · Settled already?\nasked: 2026-09-01\n\n## Q002 · Needs Shaun\nasked: 2026-09-01\n");
  await write("answers.md", "# Answers\n\n## A003 · old\nanswered: 2026-01-01\n\n**Question** ?\n\n## A004 · new\nanswered: 2026-10-01\n\n**Question** ?\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the schema", () => {
  test("the published schema and the validator agree on actions and modes", () => {
    expect(actionSchema.oneOf.map((s: any) => s.properties.action.const)).toEqual([...ACTIONS]);
    expect(proposalsSchema.properties.mode.enum).toEqual(Object.keys(MODES));
    for (const rule of proposalsSchema.allOf as any[]) {
      const mode = rule.if.properties.mode.const as keyof typeof MODES;
      expect(rule.then.properties.actions.items.properties.action.enum.sort()).toEqual([...MODES[mode]].sort());
    }
  });

  test("validate names each bad action: unknown, not yet defined, outside the mode, missing fields", () => {
    const problems = validate({
      mode: "gather",
      made: "2026-10-07",
      by: "test",
      actions: [
        { action: "explode", id: "T001", why: "x" },
        { action: "condense", id: "T001", why: "x" },
        { action: "drop", id: "T002", reason: "old", why: "x" },
        { action: "retag", id: "T003", why: "x" },
        { action: "flag", id: "T1", note: "x" },
      ],
    });
    expect(problems).toEqual([
      'action 1 (explode T001): unknown action "explode" (one of keep, archive, drop, set, retag, link, flag, cluster)',
      'action 2 (condense T001): "condense" is not defined yet (it arrives with insight curation)',
      "action 3 (drop T002): a gather run may not drop (allowed: retag, link, flag, archive, cluster)",
      'action 4 (retag T003): needs "add" or "remove"',
      'action 5 (flag T1): needs "why", one line',
      'action 5 (flag T1): id "T1" is not an ID',
    ]);
  });
});

describe("apply", () => {
  const mixed = async () => [
    { action: "keep", id: "T001", if: (await entry("T001"))!.hash, why: "still the next step" },
    { action: "drop", id: "T002", reason: "overtaken", why: "nobody wants it" },
    { action: "retag", id: "T003", add: ["crossing"], remove: ["old"], why: "it is about the crossing" },
    { action: "archive", id: "T004", importance: "low", why: "done long ago" },
    { action: "link", from: "A004", rel: "supersedes", to: "A003", why: "A004 replaces it" },
    { action: "link", from: "A004", rel: "closes", to: "Q001", why: "A004 settles it" },
    { action: "flag", id: "Q002", note: "only Shaun can say", why: "a policy call" },
    { action: "set", id: "T003", fields: { priority: "P1" }, why: "urgent now" },
  ];

  test("mixed actions over several files land at once, lint clean, with one log line each", async () => {
    const path = await proposals(await mixed());
    const r = cli(["apply", path]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("archive T004: → archive/done-2025.md");
    expect((await entry("T001"))!.meta.touched).toBe(today());
    expect((await entry("T002"))!).toMatchObject({ file: "done.md", meta: expect.objectContaining({ dropped: "yes" }) });
    expect((await entry("T003"))!.meta).toMatchObject({ tags: "crossing", priority: "P1" });
    expect((await entry("T004"))!).toMatchObject({ file: "archive/done-2025.md", meta: expect.objectContaining({ importance: "low" }) });
    expect((await entry("A003"))!.meta["superseded-by"]).toBe("A004");
    expect((await entry("A004"))!.meta).toMatchObject({ supersedes: "A003", closes: "Q001" });
    expect(await entry("Q001")).toBeUndefined();
    const q6 = (await entry("Q002"))!;
    expect(q6.meta["waiting-on"]).toBe("shaun");
    expect(q6.body).toBe(`**History:**\n- ${today()}: flagged: only Shaun can say`);
    expect(lint(await loadProject(root))).toEqual([]);
    const log = (await read("log/curation.md")).split("\n").filter((l) => l.startsWith("- "));
    expect(log).toHaveLength(8);
    expect(log[3]).toMatch(/^- \S+ archive T004: → archive\/done-2025.md \(manual by test, proposals-\d+\.json\): done long ago$/);
  });

  test("--dry-run says what it would do and writes nothing", async () => {
    const before = await Promise.all(["todo.md", "done.md", "questions.md", "answers.md"].map(read));
    const r = cli(["apply", await proposals(await mixed()), "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ ok: true, dryRun: true });
    expect(out.applied).toHaveLength(8);
    expect(await Promise.all(["todo.md", "done.md", "questions.md", "answers.md"].map(read))).toEqual(before);
    expect(await Bun.file(join(root, DIR, "log/curation.md")).exists()).toBe(false);
  });

  test("a stale if, an unknown ID or a second move of one entry refuses the whole file, naming each", async () => {
    const before = await read("todo.md");
    const r = cli([
      "apply",
      await proposals([
        { action: "keep", id: "T003", why: "fine" },
        { action: "keep", id: "T001", if: "0000", why: "stale" },
        { action: "archive", id: "T404", why: "no such entry" },
        { action: "drop", id: "T002", reason: "x", why: "once" },
        { action: "archive", id: "T002", why: "twice" },
      ]),
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("action 2 (keep T001): stale if: T001 has changed since the proposals were made");
    expect(r.err).toContain("action 3 (archive T404): no entry T404");
    expect(r.err).toContain("action 5 (archive T002): T002 was already moved by action 4");
    expect(await read("todo.md")).toBe(before);
  });

  test("a gather run's archive is a suggestion; its drop is refused by name", async () => {
    const refused = cli(["apply", await proposals([{ action: "drop", id: "T002", reason: "x", why: "y" }], "gather")]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("a gather run may not drop");
    expect(cli(["apply", await proposals([{ action: "archive", id: "T004", why: "old" }], "gather")]).code).toBe(0);
    expect((await entry("T004"))!).toMatchObject({ file: "done.md", meta: expect.objectContaining({ suggest: "archive" }) });
  });

  test("a change that would add a lint problem is refused, in a dry run too", async () => {
    const path = await proposals([{ action: "set", id: "T001", fields: { refs: "T999" }, why: "bad" }]);
    const dry = cli(["apply", path, "--dry-run"]);
    expect(dry.code).toBe(2);
    expect(dry.err).toContain("refers to T999");
    expect(cli(["apply", path]).code).toBe(2);
    expect((await entry("T001"))!.meta.refs).toBeUndefined();
  });

  test("flag needs an owner", async () => {
    await write("config.json", "{}\n");
    const r = cli(["apply", await proposals([{ action: "flag", id: "Q002", note: "x", why: "y" }])]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("name one in .remembrancer/config.json");
  });
});

describe("the knowledge base", () => {
  test("on: archive writes kb/<stem>.md, and show, lint and the server read it", async () => {
    await write("config.json", '{"owner": "shaun", "knowledge-base": true}\n');
    await apply(root, await proposals([{ action: "archive", id: "A003", why: "old" }]));
    expect(await read("kb/answers.md")).toContain("## A003 · old");
    const project = await loadProject(root);
    expect(show(project, "A003").file).toBe("kb/answers.md");
    expect(lint(project)).toEqual([]);
    await write("kb/answers.md", (await read("kb/answers.md")) + "\n## T009 · wrong kind\ndone: 2026-01-01\n");
    expect(lint(await loadProject(root)).map((p) => p.message)).toContain("T009 does not belong in kb/answers.md (expected A###)");
    expect(cli(["move", "A004", "--to", "archive"]).out).toStartWith("A004 → kb/answers.md");
    const server = serve([root], 0);
    try {
      const data = await (await fetch(`http://127.0.0.1:${server.port}/api/p/0`)).json();
      expect(data.entries.find((e: any) => e.id === "A003").file).toBe("kb/answers.md");
    } finally {
      server.stop(true);
    }
  });

  test("off: kb/ is ignored even when present", async () => {
    await write("kb/answers.md", "# Knowledge base: answers\n\n## A005 · in kb\nanswered: 2026-01-01\n\n**Question** ?\n");
    expect(listFiles(root).some((f) => f.startsWith("kb/"))).toBe(false);
    expect(await entry("A005")).toBeUndefined();
    await apply(root, await proposals([{ action: "archive", id: "A003", why: "old" }]));
    expect((await entry("A003"))!.file).toBe("archive/answers-2026.md");
  });
});

test("config.json's stale thresholds override the defaults", async () => {
  expect(stale(await loadProject(root), { now: new Date("2026-10-07") }).map((s) => s.id)).toContain("T004");
  await write("config.json", '{"stale": {"T": 1000, "A": 1000, "Q": 1000}}\n');
  expect(stale(await loadProject(root), { now: new Date("2026-10-07") })).toEqual([]);
  await write("config.json", '{"stale": {"T": "soon"}}\n');
  expect(lint(await loadProject(root)).map((p) => p.message)).toContain('config.json stale must map T, Q, A, R or K to a whole number of days, like {"T": 30}');
});
