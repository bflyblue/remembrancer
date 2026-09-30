import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/analyse";
import { brief } from "../src/brief";
import { init } from "../src/init";
import {
  ConflictError,
  DIR,
  RefusedError,
  archiveEntry,
  claimId,
  completeEntry,
  deleteEntry,
  loadProject,
  nextId,
  readParsed,
  replaceEntry,
  visibility,
} from "../src/project";

let root: string;

async function write(rel: string, text: string) {
  await Bun.write(join(root, DIR, rel), text);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("init", () => {
  test("creates files, excludes the dir from git, adds the AGENTS.md section, and is idempotent", async () => {
    const project = await loadProject(root);
    expect(project.files.map((f) => f.path)).toEqual(["todo.md", "done.md", "questions.md", "answers.md", "rules.md", "resources.md", "scratch.md"]);
    const exclude = await Bun.file(join(root, ".git", "info", "exclude")).text();
    expect(exclude).toContain("/.remembrancer/");
    const agents = await Bun.file(join(root, "AGENTS.md")).text();
    expect(agents).toContain(".remembrancer/rules.md");
    expect(await init(root)).toEqual([]);
    expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(agents);
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString();
    expect(status).not.toContain(".remembrancer");
  });

  test("--local writes CLAUDE.local.md and excludes it too", async () => {
    await init(root, { local: true });
    expect(await Bun.file(join(root, "CLAUDE.local.md")).text()).toContain("Remembrancer");
    expect(await Bun.file(join(root, ".git", "info", "exclude")).text()).toContain("/CLAUDE.local.md");
  });
});

describe("nextId", () => {
  test("counts archived headings; questions and answers share numbers", async () => {
    await write("todo.md", "# Todo\n\n## T003 · a\npriority: P1 · added: 2026-09-01\n");
    await write("archive/done-2025.md", "# Archive\n\n## T007 · old\ndone: 2025-01-01\n");
    await write("answers.md", "# Answers\n\n## A005 · x\nanswered: 2026-09-01\n\n**Question** ?\n");
    await write("questions.md", "# Questions\n\n## Q002 · y\nasked: 2026-09-01 · context: T003\n");
    const p = await loadProject(root);
    expect(nextId(p, "T")).toBe("T008");
    expect(nextId(p, "Q")).toBe("Q006");
    expect(nextId(p, "R")).toBe("R001");
  });

  test("a mention in text never counts; a closes: value does", async () => {
    await write("todo.md", "# Todo\n\n## T001 · a\npriority: P1 · added: 2026-09-01\n\nSee T999 and A999.\n");
    await write("answers.md", "# Answers\n\n## A002 · x\nanswered: 2026-09-01 · closes: Q007\n\n**Question** ?\n");
    const p = await loadProject(root);
    expect(nextId(p, "T")).toBe("T002");
    expect(nextId(p, "Q")).toBe("Q008");
  });

  test("concurrent claims get different numbers and each leaves a stub", async () => {
    const ids = await Promise.all(["one", "two", "three"].map((t) => claimId(root, "Q", t)));
    expect(new Set(ids).size).toBe(3);
    const q = await readParsed(root, "questions.md");
    expect(q.entries.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(q.entries[0].meta.asked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lint(await loadProject(root), { ids: true })).toEqual([]);
  });
});

describe("writes", () => {
  test("a write with a stale hash is rejected and changes nothing", async () => {
    await write("todo.md", "# Todo\n\n## T001 · a\npriority: P1 · added: 2026-09-01\n");
    const before = await readParsed(root, "todo.md");
    await write("todo.md", before.text + "\n## T002 · b\npriority: P2 · added: 2026-09-01\n");
    const ref = { file: "todo.md", hash: before.hash, index: 0, id: "T001" };
    await expect(replaceEntry(root, ref, "## T001 · changed\n")).rejects.toBeInstanceOf(ConflictError);
    const after = await readParsed(root, "todo.md");
    expect(after.entries.map((e) => e.title)).toEqual(["a", "b"]);
  });

  test("complete moves a todo to the top of done with today's date; archive moves it on", async () => {
    await write("todo.md", "# Todo\n\n## T001 · a\npriority: P1 · added: 2026-09-01\n\n## T002 · b\npriority: P2 · added: 2026-09-01\n");
    let todo = await readParsed(root, "todo.md");
    await completeEntry(root, { file: "todo.md", hash: todo.hash, index: 0, id: "T001" });
    todo = await readParsed(root, "todo.md");
    const done = await readParsed(root, "done.md");
    expect(todo.entries.map((e) => e.id)).toEqual(["T002"]);
    expect(done.entries[0].id).toBe("T001");
    expect(done.entries[0].meta.done).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await write("done.md", done.text.replace(/done: \d{4}-\d{2}-\d{2}/, "done: 2024-03-01"));
    const d2 = await readParsed(root, "done.md");
    const moved = await archiveEntry(root, { file: "done.md", hash: d2.hash, index: 0, id: "T001" });
    expect(moved).toBe("archive/done-2024.md");
    expect((await readParsed(root, "done.md")).entries).toHaveLength(0);
    expect((await readParsed(root, moved)).entries[0].id).toBe("T001");
  });

  test("an entry with an ID is never deleted; a todo is dropped instead", async () => {
    await write("todo.md", "# Todo\n\n## T001 · a\npriority: P1 · added: 2026-09-01\n\n## Stray heading\n");
    let todo = await readParsed(root, "todo.md");
    const ref = { file: "todo.md", hash: todo.hash, index: 0, id: "T001" };
    await expect(deleteEntry(root, ref)).rejects.toBeInstanceOf(RefusedError);
    await deleteEntry(root, { ...ref, index: 1, id: null });
    todo = await readParsed(root, "todo.md");
    expect(todo.entries.map((e) => e.id)).toEqual(["T001"]);

    await completeEntry(root, { ...ref, hash: todo.hash }, { dropped: true });
    expect((await readParsed(root, "done.md")).entries[0].meta.dropped).toBe("yes");
  });
});

describe("lint", () => {
  test("a fresh project is clean", async () => {
    expect(lint(await loadProject(root))).toEqual([]);
  });

  test("catches each seeded problem", async () => {
    await write("todo.md", "# Todo\n\n## T001 · dup\npriority: P9 · added: 2026-9-1\n\n## Bad heading\n\n## Q001 · wrong file\npriority: P1 · added: 2026-09-01\n");
    await write("done.md", "# Done\n\n## T001 · dup\ndone: 2026-09-02 · refs: T404\n");
    await write("questions.md", "# Questions\n\n## Q002 · answered already\nasked: 2026-09-01\n");
    await write("answers.md", "# Answers\n\n## A002 · no question section\nanswered: 2026-09-02\n\nJust an answer.\n");
    await write(
      "rules.md",
      [
        "# Rules",
        "## R001 · old\nscope: code · form: property · status: active · added: 2026-01-01",
        "## R002 · new\nscope: code · form: invariant · status: active · added: 2026-02-01 · supersedes: R001 · enforced-by: test/missing.test.ts",
        "## R003 · doubted\nscope: agent · form: heuristic · status: challenged · added: 2026-02-01",
        "## R004 · vague\nscope: vibes · form: invariant · status: active",
      ].join("\n\n") + "\n",
    );
    const messages = lint(await loadProject(root)).map((p) => `${p.id}: ${p.message}`);
    const expectAny = (re: RegExp) => expect(messages.some((m) => re.test(m))).toBe(true);
    expectAny(/duplicate id T001/);
    expectAny(/priority: "P9"/);
    expectAny(/added: "2026-9-1" is not YYYY-MM-DD/);
    expectAny(/null: heading "Bad heading"/);
    expectAny(/Q001 does not belong in todo.md/);
    expectAny(/refers to T404/);
    expectAny(/Q002 is still open but A002 closes it/);
    expectAny(/A002: answer has no \*\*Question\*\* section/);
    expectAny(/R002: supersedes R001, but R001 has no "superseded-by: R002"/);
    expectAny(/R002: supersedes R001, but R001 is not retired/);
    expectAny(/R002: enforced-by test\/missing.test.ts does not exist/);
    expectAny(/R003: challenged, but no open question/);
    expectAny(/R004: scope: "vibes"/);
    expectAny(/R004: missing "added:"/);
  });

  test("question and answer links: closes, closed twice, supersedes, gaps", async () => {
    const answer = (id: string, meta = "") => `## ${id} · a\nanswered: 2026-09-01${meta}\n\n**Question** ?\n`;
    await write("questions.md", "# Questions\n\n## Q005 · open but closed\nasked: 2026-09-01\n\n## Q009 · raised by an answer\nasked: 2026-09-01 · context: A004\n");
    await write(
      "answers.md",
      "# Answers\n\n" +
        [
          answer("A001", " · closes: Q002, Q005"),
          answer("A003", " · closes: Q002"),
          answer("A004", " · closes: A001 · amends: Q003"),
          answer("A006", " · superseded-by: A007 · closes: Q008"),
          answer("A007", " · supersedes: A006 · closes: Q008"),
          answer("A010", " · supersedes: A001"),
        ].join("\n"),
    );
    await write("todo.md", "# Todo\n\n## T002 · b\nadded: 2026-09-01\n");
    let messages = lint(await loadProject(root)).map((p) => `${p.id}: ${p.message}`);
    const has = (re: RegExp) => messages.some((m) => re.test(m));
    expect(has(/Q005: Q005 is still open but A001 closes it/)).toBe(true);
    expect(has(/A003: Q002 is closed by both A001 and A003/)).toBe(true);
    expect(has(/Q008 is closed by both/)).toBe(false); // A006 is superseded
    expect(has(/A004: closes: A001 is not a Q id/)).toBe(true);
    expect(has(/A004: amends: Q003 is not a A id/)).toBe(true);
    expect(has(/A010: supersedes A001, but A001 has no "superseded-by: A010"/)).toBe(true);
    expect(has(/refers to Q002/)).toBe(false); // closed by A001
    expect(has(/T001: no entry has number 1/)).toBe(true);
    expect(has(/Q\/A|number (2|5|8|9) /)).toBe(false); // covered by closes: or open
    expect(has(/missing "priority:"/)).toBe(true);

    messages = lint(await loadProject(root), { ids: true }).map((p) => `${p.id}: ${p.message}`);
    expect(has(/missing "priority:"/)).toBe(false);
    expect(has(/T001: no entry has number 1/)).toBe(true);
  });
});

describe("resources", () => {
  test("K has its own sequence, and lint checks fields and local links", async () => {
    expect(await claimId(root, "K", "Raft paper")).toBe("K001");
    await write(
      "resources.md",
      "# Resources\n\n## K001 · Raft paper\nlink: https://raft.github.io/raft.pdf · consult-when: leader election · added: 2026-09-01\n\n## K002 · Local spec\nlink: docs/spec.pdf · consult-when: wire format · added: 2026-09-01 · refs: K001\n\n## K003 · Stub\nadded: 2026-09-01\n",
    );
    const project = await loadProject(root);
    expect(nextId(project, "K")).toBe("K004");
    const messages = lint(project).map((p) => `${p.id}: ${p.message}`);
    expect(messages).toContain("K002: link docs/spec.pdf does not exist");
    expect(messages).toContain('K003: missing "link:"');
    expect(messages.some((m) => m.startsWith("K001"))).toBe(false);
  });
});

describe("visibility", () => {
  test("private while git ignores the dir, committed once it doesn't, null outside git", async () => {
    expect(visibility(root)).toBe("private");
    await Bun.write(join(root, ".git", "info", "exclude"), "");
    expect(visibility(root)).toBe("committed");
    const bare = mkdtempSync(join(tmpdir(), "remembrancer-nogit-"));
    try {
      expect(visibility(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("brief", () => {
  test("says whether IDs may leave .remembrancer/, and lists resources with when to read them", async () => {
    await write("resources.md", "# Resources\n\n## K001 · Raft paper\nlink: https://raft.github.io/raft.pdf · consult-when: leader election · added: 2026-09-01\n");
    const project = await loadProject(root);
    expect(brief(project, new Date(), "private")).toContain("never write T/Q/A/R/K IDs in commit messages");
    expect(brief(project, new Date(), "committed")).toContain("cite IDs in commit messages");
    expect(brief(project)).not.toContain("commit");
    expect(brief(project)).toContain("K001 Raft paper  (when: leader election)");
  });

  test("orders todos by priority and dependency, and lists rules", async () => {
    await write(
      "todo.md",
      "# Todo\n\n## T001 · later\npriority: P2 · added: 2026-09-01\n\n## T002 · blocked\npriority: P1 · added: 2026-09-01 · after: T003\n\n## T003 · first\npriority: P1 · added: 2026-09-01\n",
    );
    await write("rules.md", "# Rules\n\n## R001 · cursors round-trip\nscope: code · form: invariant · status: active · added: 2026-09-01 · enforced-by: AGENTS.md\n");
    const out = brief(await loadProject(root), new Date("2026-09-29"));
    const order = ["T003", "T002", "T001"].map((id) => out.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toContain("(after T003)");
    expect(out).toContain("R001 cursors round-trip  [invariant, tested]");
  });
});
