import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LintRefusedError,
  completeEntry,
  currentOf,
  formatShown,
  locate,
  refTo,
  replaceEntry,
  replaceFile,
  setMeta,
  show,
} from "../src/commands";
import { IGNORED, doctor, init } from "../src/init";
import { hashText, today } from "../src/model";
import { ConflictError, DIR, RefusedError, checkedEntry, loadProject, readParsed, withLock } from "../src/project";
import { serve } from "../src/server";

let root: string;

async function write(rel: string, text: string) {
  await Bun.write(join(root, DIR, rel), text);
}

const read = (rel: string) => Bun.file(join(root, DIR, rel)).text();

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-cmd-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const ANSWERS = [
  "# Answers",
  "## A001 · first\nanswered: 2026-09-01 · superseded-by: A002\n\n**Question** ?",
  "## A002 · second\nanswered: 2026-09-02 · supersedes: A001 · superseded-by: A003\n\n**Question** ?",
  "## A003 · third\nanswered: 2026-09-03 · supersedes: A002 · refs: T001\n\n**Question** ? See T002.",
].join("\n\n") + "\n";

const TODOS = "# Todo\n\n## T001 · one\npriority: P1 · added: 2026-09-01 · after: T002\n\n## T002 · two\npriority: P2 · added: 2026-09-01\n\nSettled by A003.\n";

describe("show", () => {
  test("prints the raw entry and its hash, which is hashText(raw)", async () => {
    await write("todo.md", TODOS);
    const project = await loadProject(root);
    const s = show(project, "t002");
    const raw = (await readParsed(root, "todo.md")).entries[1].raw;
    expect(s.raw).toBe(raw);
    expect(s.hash).toBe(hashText(raw));
    expect(s.links).toBeUndefined();
    expect(formatShown(s)).toBe(`${raw.trimEnd()}\nhash: ${hashText(raw)}`);
  });

  test("--links lists links out (meta keys, then body mentions) and links in", async () => {
    await write("todo.md", TODOS);
    await write("answers.md", ANSWERS);
    const s = show(await loadProject(root), "A003", { links: true });
    expect(s.links!.out).toEqual([
      { rel: "supersedes", id: "A002", title: "second" },
      { rel: "refs", id: "T001", title: "one" },
      { rel: "mentions", id: "T002", title: "two" },
    ]);
    expect(s.links!.in).toEqual([
      { rel: "mentions", id: "T002", title: "two" },
      { rel: "superseded-by", id: "A002", title: "second" },
    ]);
    expect(s.current).toBeNull();
    const text = formatShown(s);
    expect(text).toContain("links out:\n  supersedes: A002 second");
    expect(text).toContain("links in:\n  mentions: T002 two");
    expect(text).not.toContain("current:");
  });

  test("an answered question's title is its answer's", async () => {
    await write("answers.md", ANSWERS);
    await write("todo.md", "# Todo\n\n## T001 · one\npriority: P1 · added: 2026-09-01 · refs: Q003\n");
    const s = show(await loadProject(root), "T001", { links: true });
    expect(s.links!.out).toEqual([{ rel: "refs", id: "Q003", title: "third" }]);
  });

  test("current follows superseded-by twice, and stops on a cycle", async () => {
    await write("answers.md", ANSWERS);
    let project = await loadProject(root);
    expect(show(project, "A001", { links: true }).current).toBe("A003");
    expect(formatShown(show(project, "A001", { links: true }))).toEndWith("current: A003");
    expect(currentOf(project, locate(project, "A002"))).toBe("A003");

    await write("answers.md", ANSWERS.replace("supersedes: A002 · refs", "supersedes: A002 · superseded-by: A001 · refs"));
    project = await loadProject(root);
    expect(currentOf(project, locate(project, "A001"))).toBe("A003");
    expect(currentOf(project, locate(project, "A003"))).toBe("A002");
  });

  test("an unknown ID is not found; a duplicate is refused", async () => {
    await write("todo.md", TODOS);
    await write("done.md", "# Done\n\n## T001 · again\ndone: 2026-09-02\n");
    const project = await loadProject(root);
    expect(() => show(project, "T009")).toThrow("no entry T009");
    expect(() => show(project, "T001")).toThrow(RefusedError);
    expect(() => show(project, "T001")).toThrow(/run lint/);
  });

  test("the CLI prints JSON, and errors as JSON too", async () => {
    await write("todo.md", TODOS);
    const cli = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { cwd: root });
    const ok = cli("show", "T001", "--links", "--json");
    expect(ok.exitCode).toBe(0);
    const s = JSON.parse(ok.stdout.toString());
    expect(s).toMatchObject({ id: "T001", kind: "T", file: "todo.md", index: 0, title: "one", current: null });
    expect(s.hash).toBe(hashText(s.raw));
    expect(s.links.in).toEqual([]);
    const two = JSON.parse(cli("show", "T001", "T002", "--json").stdout.toString());
    expect(two.map((x: any) => x.id)).toEqual(["T001", "T002"]);
    const missing = cli("show", "T404", "--json");
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout.toString())).toMatchObject({ ok: false, error: "no entry T404" });
    expect(missing.stderr.toString()).toBe("no entry T404\n");
    const linted = cli("lint", "--json");
    expect(linted.exitCode).toBe(1);
    expect(JSON.parse(linted.stdout.toString())).toEqual({ ok: false, problems: [{ file: "todo.md", id: "T002", message: "refers to A003, which does not exist" }] });
    expect(JSON.parse(cli("doctor", "--json").stdout.toString())).toEqual({ ok: true, problems: [], fixed: [] });
  });
});

describe("writes by entry hash", () => {
  test("checkedEntry with an entry hash passes when another entry changed, and fails when this one did", async () => {
    await write("todo.md", TODOS);
    const ref = refTo(await loadProject(root), locate(await loadProject(root), "T002"));
    // Another writer adds an entry above T002 and edits T001: the file hash and T002's index both change.
    await write("todo.md", TODOS.replace("## T001 · one", "## T003 · new\npriority: P3 · added: 2026-09-03\n\n## T001 · one, edited"));
    await withLock(root, async () => {
      const { entry } = await checkedEntry(root, ref);
      expect(entry.id).toBe("T002");
      expect(entry.index).toBe(2);
    });
    await setMeta(root, ref, { priority: "P1" });
    const after = await readParsed(root, "todo.md");
    expect(after.entries.map((e) => `${e.id} ${e.meta.priority}`)).toEqual(["T003 P3", "T001 P1", "T002 P1"]);
    expect(after.entries[2].meta.touched).toBe(today());
    expect(after.entries[1].title).toBe("one, edited");

    // Now T002 itself has changed since `ref` was taken.
    await expect(setMeta(root, ref, { priority: "P3" })).rejects.toBeInstanceOf(ConflictError);
    await withLock(root, async () => {
      await expect(checkedEntry(root, ref)).rejects.toThrow("T002 in todo.md changed since it was read");
    });
  });

  test("without an entry hash, a stale file hash still fails", async () => {
    await write("todo.md", TODOS);
    const before = await readParsed(root, "todo.md");
    await write("todo.md", TODOS + "\n## T003 · three\npriority: P3 · added: 2026-09-01\n");
    const ref = { file: "todo.md", hash: before.hash, index: 1, id: "T002" };
    await expect(setMeta(root, ref, { priority: "P1" })).rejects.toBeInstanceOf(ConflictError);
  });

  test("a write that adds a lint problem is rolled back; problems already there don't block", async () => {
    await write("todo.md", TODOS.replace("Settled by A003.", "Settled by A404.")); // already broken
    const project = await loadProject(root);
    const ref = refTo(project, locate(project, "T001"));
    const text = await read("todo.md");
    const err = await setMeta(root, ref, { refs: "T999" }).catch((e) => e);
    expect(err).toBeInstanceOf(LintRefusedError);
    expect(err.problems.map((p: any) => p.message)).toEqual(["refers to T999, which does not exist"]);
    expect(await read("todo.md")).toBe(text);

    await setMeta(root, ref, { priority: "P3" });
    expect((await readParsed(root, "todo.md")).entries[0].meta.priority).toBe("P3");

    const t2 = locate(await loadProject(root), "T002");
    let todo = await read("todo.md");
    await expect(replaceEntry(root, refTo(await loadProject(root), t2), t2.raw.replace("A404", "A404 and T888"))).rejects.toBeInstanceOf(LintRefusedError);
    expect(await read("todo.md")).toBe(todo);

    // A refused move restores both files: done.md already holds a T002, so the move
    // turns "in todo.md, done.md" into a new problem, "in done.md, done.md".
    await write("done.md", "# Done\n\n## T002 · stray copy\ndone: 2026-09-02\n");
    todo = await read("todo.md");
    const done = await read("done.md");
    const project2 = await loadProject(root);
    const t2ref = { ...refTo(project2, project2.byId.get("T002")!.find((e) => e.file === "todo.md")!) };
    await expect(completeEntry(root, t2ref)).rejects.toBeInstanceOf(LintRefusedError);
    expect(await read("todo.md")).toBe(todo);
    expect(await read("done.md")).toBe(done);
  });

  test("a scratch save is not linted: its headings have no IDs", async () => {
    const scratch = await readParsed(root, "scratch.md");
    await replaceFile(root, "scratch.md", scratch.hash, scratch.text + "\n## Notes\n\nSee T404.\n");
    expect(await read("scratch.md")).toContain("## Notes");
  });

  test("a field value may not hold the separator or a newline", async () => {
    await write("todo.md", TODOS);
    const project = await loadProject(root);
    const ref = refTo(project, locate(project, "T001"));
    await expect(setMeta(root, ref, { refs: "T002 · T001" })).rejects.toBeInstanceOf(RefusedError);
    await expect(setMeta(root, ref, { refs: "T002\nT001" })).rejects.toBeInstanceOf(RefusedError);
    await expect(setMeta(root, ref, { "Bad Key": "x" })).rejects.toBeInstanceOf(RefusedError);
  });
});

describe("the server's ops go through the commands", () => {
  test("meta still 409s on a stale file hash, stamps touched, and 422s on a lint problem", async () => {
    await write("todo.md", TODOS);
    const server = serve([root], 0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const token = /name="token" content="([^"]+)"/.exec(await (await fetch(base + "/")).text())![1];
      const post = (body: unknown) =>
        fetch(`${base}/api/p/0/op`, { method: "POST", headers: { "content-type": "application/json", "x-token": token }, body: JSON.stringify(body) });
      const data = await (await fetch(`${base}/api/p/0`)).json();
      const t = data.entries.find((e: any) => e.id === "T001");
      const ref = { file: t.file, hash: t.hash, index: t.index, id: t.id };
      expect((await post({ op: "meta", ref: { ...ref, hash: "stale" }, updates: { priority: "P3" } })).status).toBe(409);
      expect((await post({ op: "meta", ref, updates: { priority: "P3" } })).status).toBe(200);
      expect(await read("todo.md")).toContain(`priority: P3 · added: 2026-09-01 · after: T002 · touched: ${today()}`);

      const fresh = (await readParsed(root, "todo.md")).hash;
      const res = await post({ op: "meta", ref: { ...ref, hash: fresh }, updates: { refs: "Q404" } });
      expect(res.status).toBe(422);
      expect((await res.json()).problems[0].message).toContain("Q404");
      expect((await readParsed(root, "todo.md")).hash).toBe(fresh);
    } finally {
      server.stop(true);
    }
  });
});

describe("doctor", () => {
  test("a committed folder: reports the tool files, and --fix appends the lines to .gitignore once", async () => {
    await Bun.write(join(root, ".git", "info", "exclude"), ""); // now committed
    const report = await doctor(root);
    expect(report.problems.map((p) => p.message)).toEqual(IGNORED.map(({ line }) => expect.stringContaining(line)));
    const fixed = await doctor(root, { fix: true });
    expect(fixed.problems).toEqual([]);
    expect(fixed.fixed).toHaveLength(IGNORED.length);
    expect(await doctor(root, { fix: true })).toEqual({ problems: [], fixed: [] });
    const gitignore = await Bun.file(join(root, ".gitignore")).text();
    expect(gitignore).toBe(IGNORED.map(({ line }) => line + "\n").join(""));
    expect((await doctor(root)).problems).toEqual([]);
    // The lines do what they say: nothing the tool writes shows as untracked.
    await write(".lock", "");
    await write("archive/done-2026.md.tmp-123", "");
    const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: root }).stdout.toString();
    expect(status).not.toContain(".lock");
    expect(status).not.toContain(".tmp-");
  });

  test("init adds the same lines to .git/info/exclude; a private folder reports nothing", async () => {
    const exclude = await Bun.file(join(root, ".git", "info", "exclude")).text();
    for (const { line } of IGNORED) expect(exclude.split("\n")).toContain(line);
    expect(await doctor(root)).toEqual({ problems: [], fixed: [] });
  });

  test("reports a stale lock (--fix removes it) and duplicate IDs", async () => {
    await write("todo.md", TODOS);
    await write("done.md", "# Done\n\n## T001 · again\ndone: 2026-09-02\n");
    await write(".lock", "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, DIR, ".lock"), old, old);
    const messages = (await doctor(root)).problems.map((p) => p.message);
    expect(messages.some((m) => /stale lock/.test(m))).toBe(true);
    expect(messages.some((m) => /duplicate id T001 in todo.md, done.md/.test(m))).toBe(true);
    const fixed = await doctor(root, { fix: true });
    expect(fixed.fixed.some((f) => /removed a stale/.test(f))).toBe(true);
    expect(await Bun.file(join(root, DIR, ".lock")).exists()).toBe(false);
    expect(fixed.problems.map((p) => p.id)).toEqual(["T001"]);
  });
});
