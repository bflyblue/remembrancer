import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/analyse";
import { doctor, init } from "../src/init";
import { today } from "../src/model";
import { DIR, loadProject, readParsed } from "../src/project";

let root: string;

const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const read = (rel: string) => Bun.file(join(root, DIR, rel)).text();
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const cli = (args: string[], stdin?: string) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const entry = async (id: string) => (await loadProject(root)).byId.get(id)?.[0];
const BODY = "**Answer:** yes.\n\n**Why:** it measured better.\n\n**Alternatives considered:** no.";

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-ans-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
  await write("todo.md", "# Todo\n\n## T001 · one\npriority: P1 · added: 2026-09-01\n");
  await write(
    "questions.md",
    "# Questions\n\n## Q002 · Is it fast enough?\nasked: 2026-09-01 · context: T001\n\nMeasure first.\n\n" +
      "## Q003 · Same thing, asked again\nasked: 2026-09-02\n\n## Q004 · Does R001 hold?\nasked: 2026-09-02\n\n## Q005 · Unrelated\nasked: 2026-09-02\n",
  );
  await write("answers.md", "# Answers\n\n## A001 · Old answer\nanswered: 2026-08-01\n\n**Question** ?\n");
  await write(
    "rules.md",
    "# Rules\n\n## R001 · Keep it small\nscope: code · form: heuristic · status: proposed · added: 2026-09-01\n\n**Why:** reading.\n\n" +
      "## R002 · Keep it smaller\nscope: code · form: heuristic · status: active · added: 2026-09-02\n",
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("answer", () => {
  test("writes A with the question's number, removes the question and those it closes, and lints clean", async () => {
    const r = cli(["answer", "Q002", "Fast enough", "--body", "-", "--revisit-if", "load doubles", "--closes", "Q003", "--supersedes", "A001", "--area=perf"], BODY);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("A002 answers Q002");
    const a = (await entry("A002"))!;
    expect(a.meta).toEqual({ answered: today(), context: "T001", area: "perf", "revisit-if": "load doubles", closes: "Q003", supersedes: "A001" });
    expect(a.body).toBe(`**Question** Is it fast enough? (Q002)\n\nMeasure first.\n\n${BODY}`);
    expect((await readParsed(root, "questions.md")).entries.map((e) => e.id)).toEqual(["Q004", "Q005"]);
    expect((await entry("A001"))!.meta["superseded-by"]).toBe("A002");
    expect(lint(await loadProject(root))).toEqual([]);
  });

  test("a body without **Why** exits 2 and changes nothing", async () => {
    const q = await read("questions.md");
    const r = cli(["answer", "Q002", "Fast enough", "--body", "**Answer** yes. **Alternatives considered** none."]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Why");
    expect(await read("questions.md")).toBe(q);
    expect(cli(["answer", "Q002", "x", "--body", BODY, "--if", "stale"]).code).toBe(2);
    expect(cli(["answer", "Q404", "x", "--body", BODY]).code).toBe(1);
  });

  test("--partial takes a fresh number and leaves the question with a History line", async () => {
    const r = cli(["answer", "Q002", "Part of it", "--partial", "--body", BODY]);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("A006");
    const q = (await entry("Q002"))!;
    expect(q.body).toBe(`Measure first.\n\n**History:**\n- ${today()}: A006 settles part of this`);
    expect(cli(["answer", "Q002", "x", "--partial", "--closes", "Q003", "--body", BODY]).code).toBe(2);
    // The rest of the question is answered later, under its own number.
    expect(cli(["answer", "Q002", "All of it", "--body", BODY, "--refs=A006"]).code).toBe(0);
    expect(lint(await loadProject(root))).toEqual([]);
  });

  test("decide takes a fresh number and says no question was asked", async () => {
    const r = cli(["decide", "Use tabs", "--body", BODY, "--amends", "A001"]);
    expect(r.code).toBe(0);
    const a = (await entry("A006"))!;
    expect(a.body).toStartWith("**Question** (a decision; no question asked)\n\n**Answer:** yes.");
    expect((await entry("A001"))!.meta["amended-by"]).toBe("A006");
    expect(lint(await loadProject(root))).toEqual([]);
  });
});

describe("supersede, amend, rule, move", () => {
  test("supersede sets both ends and retires a rule", async () => {
    expect(cli(["supersede", "R001", "--by", "R002"]).code).toBe(0);
    const [r1, r2] = [(await entry("R001"))!, (await entry("R002"))!];
    expect(r1.meta).toMatchObject({ status: "retired", "superseded-by": "R002", touched: today() });
    expect(r1.body).toContain(`**History:**\n- ${today()}: retired: superseded by R002`);
    expect(r2.meta.supersedes).toBe("R001");
    expect(cli(["supersede", "R002", "--by", "A001"]).code).toBe(2);
    expect(lint(await loadProject(root))).toEqual([]);
  });

  test("amend extends both lists", async () => {
    await write("answers.md", (await read("answers.md")) + "\n## A006 · b\nanswered: 2026-09-01 · amends: A001\n\n**Question** ?\n\n## A007 · c\nanswered: 2026-09-01\n\n**Question** ?\n");
    expect(cli(["amend", "A001", "--by", "A007"]).code).toBe(0);
    expect((await entry("A001"))!.meta["amended-by"]).toBe("A007");
    expect((await entry("A007"))!.meta.amends).toBe("A001");
  });

  test("rule activate, challenge, reviewed and retire", async () => {
    expect(cli(["rule", "R001", "activate"]).code).toBe(0);
    expect((await entry("R001"))!.meta.status).toBe("active");
    const noMention = cli(["rule", "R001", "challenge", "--question", "Q005"]);
    expect(noMention.code).toBe(2);
    expect(noMention.err).toContain("Q005 does not mention R001");
    expect(cli(["rule", "R001", "challenge"]).code).toBe(2);
    expect(cli(["rule", "R001", "challenge", "--question", "Q004"]).code).toBe(0);
    const r = (await entry("R001"))!;
    expect(r.meta.status).toBe("challenged");
    expect(r.body).toBe(`**Why:** reading.\n\n**History:**\n- ${today()}: activated\n- ${today()}: challenged: see Q004`);
    expect(cli(["rule", "R002", "reviewed"]).code).toBe(0);
    expect((await entry("R002"))!.meta.reviewed).toBe(today());
    expect(cli(["rule", "R001", "retire", "--by", "R002"]).code).toBe(0);
    expect((await entry("R001"))!.meta.status).toBe("retired");
    expect((await entry("R002"))!.meta.supersedes).toBe("R001");
  });

  test("move --to archive files an entry by the year of its date", async () => {
    const r = cli(["move", "A001", "--to", "archive"]);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("A001 → archive/answers-2026.md");
    expect((await entry("A001"))!.file).toBe("archive/answers-2026.md");
    expect(cli(["move", "A001", "--to", "archive"]).code).toBe(2);
    expect(cli(["move", "T001", "--to", "elsewhere"]).code).toBe(2);
  });
});

describe("inverses", () => {
  test("lint reports a missing amended-by (and superseded-by), and doctor --fix adds them", async () => {
    await write("answers.md", (await read("answers.md")) + "\n## A006 · b\nanswered: 2026-09-01 · amends: A001\n\n**Question** ?\n");
    await write("rules.md", (await read("rules.md")).replace("status: proposed · added: 2026-09-01", "status: retired · added: 2026-09-01 · superseded-by: R002"));
    const messages = lint(await loadProject(root), { ids: true }).map((p) => `${p.id}: ${p.message}`);
    expect(messages).toContain('A006: amends A001, but A001 has no "amended-by: A006" (doctor --fix adds it)');
    expect(messages).toContain('R001: superseded-by R002, but R002 has no "supersedes: R001" (doctor --fix adds it)');
    expect((await doctor(root)).problems).toHaveLength(2);
    const fixed = await doctor(root, { fix: true });
    expect(fixed.fixed).toEqual(['added "amended-by: A006" to A001', 'added "supersedes: R001" to R002']);
    expect(fixed.problems).toEqual([]);
    expect((await entry("A001"))!.meta["amended-by"]).toBe("A006");
    expect(lint(await loadProject(root))).toEqual([]);
  });
});
