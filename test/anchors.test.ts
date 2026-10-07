import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/analyse";
import { anchorDefinitions, looksLikePath, repoOf } from "../src/anchors";
import { init } from "../src/init";
import { DIR, loadProject } from "../src/project";

let root: string;
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-anchor-"));
  git("init", "-q");
  await init(root);
  await Bun.write(join(root, "src", "solver", "new.ts"), "// anchor: kept-thing\nexport const a = 1; // anchor: lonely-thing\n");
  await Bun.write(join(root, "src", "notes.md"), "Prose: anchor: the event we mean, and text-anchor: middle.\n<!-- anchor: html-thing -->\n");
  await Bun.write(join(root, "docs", "a", "README.md"), "a\n");
  await Bun.write(join(root, "docs", "b", "README.md"), "b\n");
  git("add", "src", "docs");
  await Bun.write(
    join(root, DIR, "todo.md"),
    "# Todo\n\n## T001 · Uses the solver\npriority: P1 · added: 2026-10-01\n\n" +
      "See anchor:kept-thing and anchor:gone-thing, `src/old.ts` (moved), `new.ts`, `README.md`, " +
      "`Iapetus.Canonical`, `km/s`, [the notes](../src/notes.md) and [moved notes](../src/gone%20notes.md).\n\n```\n`src/in-a-fence.ts`\n```\n",
  );
  await Bun.write(join(root, DIR, "archive", "done-2025.md"), "# Archive: done\n\n## T002 · history\ndone: 2025-01-01\n\nOnce in `src/older.ts`.\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("drift", () => {
  test("full lint names a missing anchor and a moved file; lint --ids reports neither", async () => {
    const messages = lint(await loadProject(root)).map((p) => `${p.id}: ${p.message}`);
    expect(messages.filter((m) => /cites|anchor/.test(m)).sort()).toEqual([
      "T001: cites ../src/gone notes.md, which does not exist (moved? cite an anchor instead)",
      "T001: cites README.md, but several tracked files have that name: give its path",
      "T001: cites anchor:gone-thing, which no tracked file defines (`anchor: gone-thing` in a comment)",
      "T001: cites src/old.ts, which does not exist (moved? cite an anchor instead)",
    ]);
    expect(lint(await loadProject(root), { ids: true }).some((p) => /cites/.test(p.message))).toBe(false);
  });

  test("what counts as a path: a tracked extension, case kept, or a folder", () => {
    const repo = repoOf(root);
    expect(["src/old.ts", "new.ts", "docs/", "README.md"].every((t) => looksLikePath(t, repo))).toBe(true);
    expect(["Iapetus.Canonical", "km/s", "e.meta", "Trace.MD", "https://x.dev/a.ts"].some((t) => looksLikePath(t, repo))).toBe(false);
  });
});

describe("anchors", () => {
  test("definitions are whole words last on their line; prose and text-anchor are not", () => {
    expect(anchorDefinitions(repoOf(root)).map((d) => `${d.name} ${d.file}:${d.line}`).sort()).toEqual([
      "html-thing src/notes.md:2",
      "kept-thing src/solver/new.ts:1",
      "lonely-thing src/solver/new.ts:2",
    ]);
  });

  test("anchors lists each with its citers; --unused only the uncited", async () => {
    const cli = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "anchors", ...args], { cwd: root }).stdout.toString();
    expect(cli()).toBe("html-thing  src/notes.md:2  ← no entry\nkept-thing  src/solver/new.ts:1  ← T001\nlonely-thing  src/solver/new.ts:2  ← no entry\n");
    expect(cli("--unused")).toBe("html-thing  src/notes.md:2  ← no entry\nlonely-thing  src/solver/new.ts:2  ← no entry\n");
    expect(JSON.parse(cli("--json")).anchors[1]).toEqual({ name: "kept-thing", defined: ["src/solver/new.ts:1"], citedBy: ["T001"] });
  });
});
