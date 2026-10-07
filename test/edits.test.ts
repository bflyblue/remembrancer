import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/analyse";
import { appendToSection, newEntry } from "../src/commands";
import { init } from "../src/init";
import { hashText, today } from "../src/model";
import { DIR, loadProject, readParsed } from "../src/project";

let root: string;

const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const read = (rel: string) => Bun.file(join(root, DIR, rel)).text();
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const cli = (args: string[], stdin?: string) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const entry = async (rel: string, id: string) => (await readParsed(root, rel)).entries.find((e) => e.id === id)!;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-edit-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
  await write("todo.md", "# Todo\n\n## T001 · one\npriority: P1 · added: 2026-09-01\n\nThe plan.\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("new", () => {
  test("new T needs a priority, or --inbox; both lint clean", async () => {
    const refused = cli(["new", "T", "no priority"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("--priority=");
    const ok = cli(["new", "T", "Fix the parser", "--priority=P2", "--after=T001", "--body", "Details."]);
    expect(ok.code).toBe(0);
    expect(ok.out).toStartWith("T002");
    const t2 = await entry("todo.md", "T002");
    expect(t2.raw).toBe(`## T002 · Fix the parser\npriority: P2 · added: ${today()} · after: T001\n\nDetails.\n`);
    const inbox = JSON.parse(cli(["new", "T", "a thought", "--inbox", "--json"]).out);
    expect(inbox).toMatchObject({ ok: true, id: "T003", file: "todo.md" });
    const t3 = await entry("todo.md", "T003");
    expect(t3.meta).toEqual({ status: "inbox", added: today() });
    expect(inbox.hash).toBe(t3.hash);
    expect(lint(await loadProject(root))).toEqual([]);
  });

  test("lint accepts status: inbox only on todo.md, and requires a priority otherwise", async () => {
    await write("todo.md", "# Todo\n\n## T001 · a\nstatus: inbox · added: 2026-09-01\n\n## T002 · b\nstatus: open · added: 2026-09-01\n");
    const messages = lint(await loadProject(root)).map((p) => `${p.id}: ${p.message}`);
    expect(messages.filter((m) => m.startsWith("T001"))).toEqual([]);
    expect(messages).toContain('T002: status: "open" is not one of inbox');
    expect(messages).toContain('T002: missing "priority:"');
  });

  test("new K without link exits 2 and writes nothing; with both fields it lands", async () => {
    const before = await read("resources.md");
    const r = cli(["new", "K", "Raft paper", "--consult-when=elections"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--link=");
    expect(await read("resources.md")).toBe(before);
    expect(cli(["new", "K", "Raft paper", "--link=https://raft.github.io", "--consult-when=elections"]).code).toBe(0);
    expect((await entry("resources.md", "K001")).meta).toEqual({ link: "https://raft.github.io", "consult-when": "elections", added: today() });
  });

  test("new R is proposed; new Q is dated; a bad value or a body naming a missing ID is refused", async () => {
    expect(cli(["new", "R", "Keep it small", "--scope=code", "--form=heuristic"]).code).toBe(0);
    expect((await entry("rules.md", "R001")).meta).toEqual({ scope: "code", form: "heuristic", status: "proposed", added: today() });
    expect(cli(["new", "Q", "Why?", "--context=T001", "--body", "-"], "From stdin.").code).toBe(0);
    const q = await entry("questions.md", "Q001");
    expect(q.meta).toEqual({ asked: today(), context: "T001" });
    expect(q.body).toBe("From stdin.");

    const todo = await read("todo.md");
    expect(cli(["new", "T", "bad", "--priority=P9"]).code).toBe(2);
    const missing = cli(["new", "T", "names a ghost", "--priority=P1", "--body", "See T999.", "--json"]);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.out).problems[0].message).toBe("refers to T999, which does not exist");
    expect(await read("todo.md")).toBe(todo);
    expect(cli(["new", "T", "x", "--priority=P1", "--body", "a", "--body-file", "f"]).code).toBe(2);
  });

  test("two concurrent new T get different IDs", async () => {
    const ids = await Promise.all(["a", "b", "c"].map((t) => newEntry(root, "T", t, { inbox: true })));
    expect(new Set(ids).size).toBe(3);
    expect((await readParsed(root, "todo.md")).entries.map((e) => e.id).sort()).toEqual(["T001", ...ids].sort());
  });
});

describe("done and drop", () => {
  test("done --outcome replaces the body and stamps done and touched; an inbox todo leaves the inbox", async () => {
    const r = cli(["done", "T001", "--outcome", "Shipped; the parser is in src/parse.ts."]);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("T001 → done.md · hash: ");
    const d = await entry("done.md", "T001");
    expect(d.meta).toEqual({ priority: "P1", added: "2026-09-01", done: today(), touched: today() });
    expect(d.body).toBe("Shipped; the parser is in src/parse.ts.");
    expect((await readParsed(root, "todo.md")).entries).toHaveLength(0);

    await newEntry(root, "T", "captured", { inbox: true });
    expect(cli(["done", "T002"]).code).toBe(0);
    expect((await entry("done.md", "T002")).meta.status).toBeUndefined();
  });

  test("drop keeps the number, marks it dropped, and puts the reason above the body", async () => {
    expect(cli(["drop", "T001"]).code).toBe(2);
    expect(cli(["drop", "T001", "--reason", "superseded by the new parser"]).code).toBe(0);
    const d = await entry("done.md", "T001");
    expect(d.meta.dropped).toBe("yes");
    expect(d.body).toBe("Dropped: superseded by the new parser\n\nThe plan.");
    expect(cli(["new", "T", "next", "--inbox"]).out).toStartWith("T002");
  });
});

describe("edit, set, append", () => {
  test("edit needs --if; with a stale hash it exits 2 and changes nothing", async () => {
    const hash = (await entry("todo.md", "T001")).hash;
    expect(cli(["edit", "T001", "--title", "renamed"]).code).toBe(2);
    expect(cli(["edit", "T001", "--if", "0000", "--title", "renamed"]).code).toBe(2);
    expect(await read("todo.md")).toContain("## T001 · one");
    const ok = JSON.parse(cli(["edit", "T001", "--if", hash, "--title", "renamed", "--body", "New plan.", "--json"]).out);
    const t = await entry("todo.md", "T001");
    expect(t.title).toBe("renamed");
    expect(t.body).toBe("New plan.");
    expect(t.meta.touched).toBe(today());
    expect(ok.hash).toBe(hashText(t.raw));
    expect(cli(["edit", "T001", "--if", hash, "--title", "again"]).code).toBe(2); // hash now stale
  });

  test("set changes and unsets fields, and refuses the separator, a newline and a bad value", async () => {
    expect(cli(["set", "T001", "priority=P3", "area=parser"]).code).toBe(0);
    expect((await entry("todo.md", "T001")).meta).toEqual({ priority: "P3", added: "2026-09-01", touched: today(), area: "parser" });
    expect(cli(["set", "T001", "--unset", "area"]).code).toBe(0);
    expect((await entry("todo.md", "T001")).meta.area).toBeUndefined();
    const before = await read("todo.md");
    const sep = cli(["set", "T001", "refs=T001 · T002"]);
    expect(sep.code).toBe(2);
    expect(sep.err).toContain(`may not contain " · "`);
    expect(cli(["set", "T001", "refs=a\nb"]).code).toBe(2);
    expect(cli(["set", "T001", "priority=high"]).code).toBe(2);
    expect(cli(["set", "T001", "added=yesterday"]).code).toBe(2);
    expect(cli(["set", "T001", "refs=T999"]).code).toBe(2);
    expect(await read("todo.md")).toBe(before);
  });

  test("append creates the section once, then adds under it", async () => {
    expect(cli(["append", "T001", "--section", "History", "--line", "first try failed"]).code).toBe(0);
    expect(cli(["append", "T001", "--section", "History", "--line", "second worked"]).code).toBe(0);
    const t = await entry("todo.md", "T001");
    expect(t.body).toBe(`The plan.\n\n**History:**\n- ${today()}: first try failed\n- ${today()}: second worked`);
    expect(t.body.match(/\*\*History:\*\*/g)).toHaveLength(1);
  });

  test("appendToSection adds at the end of its section, before the next one", () => {
    const body = "Rule.\n\n**Why:** because.\n\n**History:**\n- 2026-01-01: made\n\n**Check:** read it.";
    expect(appendToSection(body, "History", "sharpened", "2026-02-02")).toBe(
      "Rule.\n\n**Why:** because.\n\n**History:**\n- 2026-01-01: made\n- 2026-02-02: sharpened\n\n**Check:** read it.",
    );
    expect(appendToSection("", "History", "x", "2026-02-02")).toBe("**History:**\n- 2026-02-02: x");
  });

  test("the lint hook names the commands to use instead", async () => {
    await write("todo.md", "# Todo\n\n## T001 · one\npriority: P1 · added: 2026-09-01\n\nSee T999.\n");
    const call = JSON.stringify({ tool_input: { file_path: join(root, DIR, "todo.md") } });
    const r = cli(["lint", "--ids", "--hook"], call);
    expect(r.code).toBe(2);
    expect(r.err).toContain("refers to T999");
    expect(r.err.trimEnd().split("\n").at(-1)).toBe("Make todo changes with the CLI: remembrancer new T, set, append, edit, done, drop.");
  });
});
