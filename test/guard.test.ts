import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guard } from "../src/guard";
import { init } from "../src/init";
import { DIR } from "../src/project";

let root: string;
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stderr: "ignore" });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-guard-"));
  git("init", "-q");
  await init(root);
  await Bun.write(join(root, DIR, "rules.md"), "# Rules\n\n## R003 · Cursors round-trip\nscope: code · form: invariant · status: active · added: 2026-09-01\n");
  await Bun.write(join(root, DIR, "questions.md"), "# Questions\n\n## Q004 · Opaque cursors?\nasked: 2026-09-01\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("guard", () => {
  test("refuses a commit message that cites an ID of this project", async () => {
    const reason = await guard(`git commit -m "search: keep cursors stable (R003)"`, root);
    expect(reason).toContain(`R003 "Cursors round-trip" (in the message)`);
  });

  test("scans heredoc messages, gh PR text and --body-file", async () => {
    expect(await guard(`git commit -F - <<'EOF'\nfix: per Q004\nEOF`, root)).toContain("Q004");
    expect(await guard(`gh pr create --title x --body "see R003"`, root)).toContain("R003");
    await Bun.write(join(root, "body.md"), "Closes Q004\n");
    expect(await guard(`gh pr create --title x --body-file body.md`, root)).toContain("Q004");
  });

  test("refuses IDs added in the staged changes, naming the file", async () => {
    await Bun.write(join(root, "cursor.ts"), "// see R003\nexport const x = 1;\n");
    git("add", "cursor.ts");
    expect(await guard(`git commit -m "add cursor"`, root)).toContain("R003 \"Cursors round-trip\" (added in cursor.ts)");
  });

  test("lets through IDs that don't exist, other commands, and a committed .remembrancer/", async () => {
    expect(await guard(`git commit -m "support the T800 and R2 boards"`, root)).toBeNull();
    expect(await guard(`git log --grep R003`, root)).toBeNull();
    await Bun.write(join(root, ".git", "info", "exclude"), "");
    expect(await guard(`git commit -m "R003"`, root)).toBeNull();
  });

  test("as a PreToolUse hook: exit 2 with the reason on stderr", () => {
    const call = JSON.stringify({ tool_name: "Bash", tool_input: { command: `git commit -m "R003"` }, cwd: root });
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "guard", "--hook"], { stdin: new TextEncoder().encode(call) });
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("R003");
    const ok = JSON.stringify({ tool_name: "Bash", tool_input: { command: `git commit -m "fix"` }, cwd: root });
    expect(Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "guard", "--hook"], { stdin: new TextEncoder().encode(ok) }).exitCode).toBe(0);
  });
});
