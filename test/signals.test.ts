import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/analyse";
import { brief, briefData } from "../src/brief";
import { doctor, init } from "../src/init";
import { today } from "../src/model";
import { DIR, loadProject } from "../src/project";
import { currentPhase, planTree, stale, tagsOf, waiting } from "../src/signals";

let root: string;

const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const cli = (args: string[]) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const NOW = new Date("2026-10-07T12:00:00Z");

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-sig-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stale", () => {
  test("old, uncited entries are stale; one an open todo cites is not; touched counts", async () => {
    await write("todo.md", "# Todo\n\n## T001 · open, cites A001\npriority: P1 · added: 2026-10-01 · refs: A001\n\n## T002 · old todo\npriority: P2 · added: 2026-01-01 · touched: 2026-10-01\n");
    await write("done.md", "# Done\n\n## T003 · long done\ndone: 2026-06-01\n");
    await write(
      "answers.md",
      "# Answers\n\n## A001 · cited\nanswered: 2026-01-01\n\n**Question** ?\n\n## A004 · forgotten\nanswered: 2026-01-01 · area: planner\n\n**Question** ?\n",
    );
    const project = await loadProject(root);
    expect(stale(project, { now: NOW }).map((s) => `${s.id} ${s.age}`)).toEqual(["A004 279", "T003 128"]);
    expect(stale(project, { now: NOW, kind: "T" }).map((s) => s.id)).toEqual(["T003"]);
    expect(stale(project, { now: NOW, days: 5 }).map((s) => s.id)).toEqual(["A004", "T003", "T001", "T002"]);
    expect(tagsOf((await loadProject(root)).byId.get("A004")![0])).toEqual(["planner"]);
  });
});

describe("waiting and the owner", () => {
  test("waiting groups by who; the brief lists the owner's first, and answer and done clear it", async () => {
    await write("config.json", '{"owner": "shaun"}\n');
    await write("todo.md", "# Todo\n\n## T001 · ship it\npriority: P1 · added: 2026-10-01 · waiting-on: shaun\n\n## T002 · other\npriority: P2 · added: 2026-10-01 · waiting-on: fable\n");
    await write("questions.md", "# Questions\n\n## Q003 · Which way?\nasked: 2026-10-01 · waiting-on: Shaun\n");
    const project = await loadProject(root);
    expect([...waiting(project)].map(([who, l]) => `${who}: ${l.map((e) => e.id).join(" ")}`)).toEqual(["shaun: T001 Q003", "fable: T002"]);
    expect([...waiting(project, "fable").keys()]).toEqual(["fable"]);
    const text = brief(project, NOW, "private");
    const lines = text.split("\n");
    expect(lines[3]).toBe("Waiting on you (shaun):");
    expect(lines.slice(4, 7)).toEqual(["  T001 ship it", "  Q003 Which way?", "  and 1 entry waiting on others (remembrancer waiting --all)"]);
    expect(text.indexOf("Waiting on you")).toBeLessThan(text.indexOf("Next up"));
    expect(cli(["waiting"]).out).toBe("shaun:\n  T001 ship it  (todo.md)\n  Q003 Which way?  (questions.md)\n");

    expect(cli(["new", "Q", "Ask him", "--waiting-on", "shaun"]).code).toBe(0);
    expect((await loadProject(root)).byId.get("Q004")![0].meta["waiting-on"]).toBe("shaun");
    const body = "**Answer:** a **Why:** b **Alternatives considered:** c";
    expect(cli(["answer", "Q003", "This way", "--body", body]).code).toBe(0);
    expect(cli(["done", "T001"]).code).toBe(0);
    const after = await loadProject(root);
    expect(after.byId.get("A003")![0].meta["waiting-on"]).toBeUndefined();
    expect(after.byId.get("T001")![0].meta["waiting-on"]).toBeUndefined();
    expect([...waiting(after, "shaun").values()].flat().map((e) => e.id)).toEqual(["Q004"]);
  });

  test("lint checks waiting-on, tags and config.json only when present", async () => {
    await write("todo.md", "# Todo\n\n## T001 · a\npriority: P1 · added: 2026-10-01 · waiting-on: two words · tags: ok, Not OK\n\n## T002 · b\npriority: P1 · added: 2026-10-01 · tags: planner, re-seed · phase: B\n");
    await write("config.json", "{ owner: shaun }");
    const messages = lint(await loadProject(root)).map((p) => `${p.id}: ${p.message}`);
    expect(messages.some((m) => m.startsWith("T001: waiting-on"))).toBe(true);
    expect(messages.some((m) => m.startsWith("T001: tags"))).toBe(true);
    expect(messages.some((m) => m.startsWith("T002"))).toBe(false);
    expect(messages.some((m) => /config.json is not valid JSON/.test(m))).toBe(true);
    expect(cli(["set", "T002", "waiting-on=two words"]).code).toBe(2);
  });
});

describe("plans and the phase", () => {
  const TODO =
    "# Todo\n\n" +
    [
      "## T010 · Plan: the crossing\npriority: P1 · added: 2026-10-01 · after: T011, T012, T013, T020 · phase: B · tags: crossing · done-when: every crossing solves",
      "## T012 · second\npriority: P1 · added: 2026-10-01 · after: T011",
      "## T013 · third\npriority: P2 · added: 2026-10-01",
      "## T020 · Plan: nested\npriority: P2 · added: 2026-10-01 · after: T021",
      "## T021 · loops back\npriority: P2 · added: 2026-10-01 · after: T020",
      "## T030 · Plan: other\npriority: P1 · added: 2026-10-01 · after: T013",
    ].join("\n\n") +
    "\n";

  test("plan shows each child's state and open blockers, recurses into a nested plan, and marks a cycle", async () => {
    await write("todo.md", TODO);
    await write("done.md", "# Done\n\n## T011 · first\ndone: 2026-10-02\n");
    const tree = planTree(await loadProject(root), "T010");
    expect(tree.children.map((c) => `${c.id} ${c.state} [${c.blockers}]`)).toEqual(["T011 done []", "T012 open []", "T013 open []", "T020 open [T021]"]);
    const nested = tree.children[3];
    expect(nested.children[0].id).toBe("T021");
    expect(nested.children[0].children[0]).toMatchObject({ id: "T020", cycle: true, children: [] });
    const out = cli(["plan", "T010"]).out;
    expect(out).toContain("  T011 done    first");
    expect(out).toContain("(cycle: already above)");
    expect(out).toEndWith("done when: every crossing solves\n");
  });

  test("the current phase is the phased plan; the brief names it, its next tasks and matching resources", async () => {
    await write("todo.md", TODO);
    await write("done.md", "# Done\n\n## T011 · first\ndone: 2026-10-02\n");
    await write("resources.md", "# Resources\n\n## K001 · Crossing paper\nlink: https://x.dev · consult-when: crossing seeds · added: 2026-10-01\n\n## K002 · Unrelated\nlink: https://y.dev · consult-when: rendering · added: 2026-10-01\n");
    const project = await loadProject(root);
    const phase = currentPhase(project)!;
    expect(phase.plan.id).toBe("T010");
    expect([phase.done, phase.total, phase.next.map((e) => e.id)]).toEqual([1, 4, ["T012", "T013"]]);
    const text = brief(project, NOW);
    expect(text).toContain("Current phase B: T010 Plan: the crossing  (1 of 4 done)\n  done when: every crossing solves\n  next: T012 second\n  next: T013 third\n  read: K001 Crossing paper");
    const data = JSON.parse(cli(["brief", "--json"]).out);
    expect(data.phase.plan.id).toBe("T010");
    expect(Object.keys(data)).toEqual(expect.arrayContaining(["project", "visibility", "waiting", "phase", "inbox", "rules", "stale", "checks"]));
    expect(briefData(project, NOW).phase!.resources.map((k) => k.id)).toEqual(["K001"]);
  });

  test("without a phased plan, the first P1 plan is the phase; the inbox is counted, not listed", async () => {
    await write("todo.md", TODO.replace(" · phase: B", "") + "\n## T040 · idea\nstatus: inbox · added: 2026-10-01\n");
    const project = await loadProject(root);
    expect(currentPhase(project)!.plan.id).toBe("T010");
    const text = brief(project, NOW);
    expect(text).toContain("To decide:\n  1 inbox task to triage");
    expect(text).not.toContain("T040");
  });
});

describe("invalid UTF-8", () => {
  test("lint and doctor name the file and line", async () => {
    const bytes = Buffer.concat([Buffer.from("# Todo\n\n## T001 · a\npriority: P1 · added: 2026-10-01\n\nabout 0.2"), Buffer.from([0xb0]), Buffer.from(" wide\n")]);
    await Bun.write(join(root, DIR, "todo.md"), bytes);
    const message = "line 6 is not valid UTF-8 (a stray byte, shown as �): retype that character by hand";
    expect(lint(await loadProject(root), { ids: true })).toContainEqual({ file: "todo.md", id: null, message });
    expect((await doctor(root)).problems.map((p) => p.message)).toContain(`${DIR}/todo.md line 6 is not valid UTF-8: retype that character by hand`);
    expect((await doctor(root, { fix: true })).problems).toHaveLength(1);
    expect(today()).toMatch(/^\d{4}/);
  });
});

test("a plan with every task done is passed over for the phase and offered for closing", async () => {
  await write(
    "todo.md",
    "# Todo\n\n## T001 · Plan: finished\npriority: P1 · added: 2026-10-01 · after: T002\n\n## T003 · Plan: under way\npriority: P1 · added: 2026-10-01 · after: T004, T005\n\n## T005 · left\npriority: P1 · added: 2026-10-01\n",
  );
  await write("done.md", "# Done\n\n## T002 · a\ndone: 2026-10-02\n\n## T004 · b\ndone: 2026-10-02\n");
  const project = await loadProject(root);
  expect(currentPhase(project)!.plan.id).toBe("T003");
  expect(brief(project, NOW)).toContain('  T001 Plan: finished: every task done (remembrancer done T001 --outcome "…")');
});
