import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/analyse";
import { brief } from "../src/brief";
import { parseEnforcedBy, runChecks } from "../src/check";
import { init } from "../src/init";
import { today } from "../src/model";
import { DIR, loadProject } from "../src/project";

let root: string;
const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const rule = (id: string, by: string, status = "active") => `## ${id} · rule ${id}\nscope: code · form: invariant · status: ${status} · added: 2026-01-01 · enforced-by: ${by}\n`;
const cli = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "check", ...args], { cwd: root });
  return { code: p.exitCode, out: p.stdout.toString() };
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-check-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
  await Bun.write(join(root, "test", "Spec.hs"), "-- tests\n");
  await write(
    "rules.md",
    "# Rules\n\n" +
      [
        rule("R001", "cmd: true"),
        rule("R002", "cmd: echo one; echo two; echo boom >&2; false"),
        rule("R003", 'test/Spec.hs: "the cursor round-trips"'),
        rule("R004", "test/Spec.hs"),
        rule("R005", "cmd: true", "retired"),
      ].join("\n"),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("enforced-by", () => {
  test("three forms; lint accepts them and checks a test's or a path's file", async () => {
    expect(parseEnforcedBy('test/Spec.hs: "a name"')).toEqual({ kind: "test", file: "test/Spec.hs", name: "a name" });
    expect(parseEnforcedBy("cmd: make check")).toEqual({ kind: "cmd", command: "make check" });
    expect(parseEnforcedBy("test/Spec.hs")).toEqual({ kind: "path", file: "test/Spec.hs" });
    expect(parseEnforcedBy("two words").kind).toBe("bad");
    expect(lint(await loadProject(root)).filter((p) => /enforced-by/.test(p.message))).toEqual([]);
    await write("rules.md", rule("R001", 'test/Gone.hs: "x"') + "\n" + rule("R002", "two words"));
    const messages = lint(await loadProject(root)).map((p) => `${p.id}: ${p.message}`);
    expect(messages).toContain("R001: enforced-by test/Gone.hs does not exist");
    expect(messages).toContain('R002: enforced-by "two words" is not a path, path: "test name", or cmd: command');
  });
});

describe("check", () => {
  test("cmd: true passes and is stamped checked; cmd: false fails with its output; a test without a runner is skipped", async () => {
    const r = cli();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^R001 pass \([\d.]+s\)  rule R001$/m);
    expect(r.out).toContain("R002 FAIL");
    expect(r.out).toContain("  exit 1\n  | one\n  | two\n  | boom");
    expect(r.out).toContain('R003 skipped  rule R003\n  no runner: set "check": {"test": "… {name} …"} in .remembrancer/config.json');
    expect(r.out).toContain("R004 skipped  rule R004\n  no runner: enforced-by names a path only");
    expect(r.out).not.toContain("R005");
    expect(r.out).toEndWith("1 pass, 1 fail, 2 skipped\n");
    const p = await loadProject(root);
    expect(p.byId.get("R001")![0].meta.checked).toBe(today());
    expect(p.byId.get("R002")![0].meta.checked).toBeUndefined();
    expect(brief(p)).toContain("Rules (check work against these; checks: 1 FAIL, 1 pass, 2 unrunnable (remembrancer check)):");
  });

  test("check.test runs a named test with {file} and {name}, in check.cwd; fail-if-output catches an empty match", async () => {
    await write("config.json", JSON.stringify({ check: { test: "grep -q 'cursor' {file} && echo 'ran {name}'", cwd: "." } }));
    await Bun.write(join(root, "test", "Spec.hs"), "-- the cursor round-trips\n");
    let [res] = await runChecks(await loadProject(root), ["R003"]);
    expect(res).toMatchObject({ id: "R003", status: "pass", command: "grep -q 'cursor' test/Spec.hs && echo 'ran the cursor round-trips'" });
    await write("config.json", JSON.stringify({ check: { test: "echo 'All 0 tests passed'", "fail-if-output": "All 0 tests" } }));
    [res] = await runChecks(await loadProject(root), ["R003"]);
    expect(res.status).toBe("fail");
    expect(res.message).toContain("nothing was really checked");
    expect(cli("R003", "--json").code).toBe(1);
  });

  test("a named rule must have a check", async () => {
    await write("rules.md", "# Rules\n\n## R001 · plain\nscope: code · form: heuristic · status: active · added: 2026-01-01\n");
    expect(cli("R001").code).toBe(2);
  });
});
