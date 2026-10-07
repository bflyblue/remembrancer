// Running the rules' machine checks. A rule's `enforced-by:` takes one of
// three forms:
// - `path: "test name"`: a test, run by config.json's `check.test` command
//   with {file} and {name} filled in;
// - `cmd: shell command`: run with `sh -c` in the check directory;
// - a bare path: where the check lives, for a reader; `check` has no runner.
// Checks run outside the lock (they can take minutes); a pass then stamps
// `checked:` under it. The last result per rule is kept in log/checks.json
// for the brief.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Changes, locate, withFiles } from "./commands";
import { type Entry, today, withMeta } from "./model";
import { DIR, type Project, RefusedError } from "./project";

import { type Form, checkDir, parseEnforcedBy } from "./analyse";
export { checkDir, parseEnforcedBy };

export interface CheckResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "skipped";
  message: string;
  command?: string;
  tail?: string[]; // the last 20 lines of output, on a failure
  seconds?: number;
}

const TAIL = 20;

// The shell command for a rule, or why there is none.
function commandFor(project: Project, form: Form): { command: string } | { skip: string } {
  if (form.kind === "cmd") return { command: form.command };
  if (form.kind === "path") return { skip: "no runner: enforced-by names a path only (check it by reading)" };
  if (form.kind === "bad") return { skip: form.message };
  const template = project.config.check?.test;
  if (!template) return { skip: `no runner: set "check": {"test": "… {name} …"} in ${DIR}/config.json` };
  if (/['"`$\\]/.test(form.name)) return { skip: `the test name holds a quote, $ or \\, which the command can't carry safely` };
  return { command: template.replaceAll("{file}", form.file).replaceAll("{name}", form.name) };
}

// The rules to check: the ones named, or every active or challenged rule with enforced-by.
export function rulesToCheck(project: Project, ids: string[]): Entry[] {
  if (ids.length) {
    return ids.map((id) => {
      const r = locate(project, id);
      if (r.kind !== "R") throw new RefusedError(`${r.id} is not a rule`);
      if (!r.meta["enforced-by"]) throw new RefusedError(`${r.id} has no enforced-by: nothing to run`);
      return r;
    });
  }
  return project.entries.filter((e) => e.kind === "R" && e.file === "rules.md" && e.meta["enforced-by"] && ["active", "challenged"].includes(e.meta.status));
}

export async function runChecks(project: Project, ids: string[], onResult: (r: CheckResult) => void = () => {}): Promise<CheckResult[]> {
  const cwd = checkDir(project);
  const failIf = project.config.check?.["fail-if-output"];
  const results: CheckResult[] = [];
  for (const r of rulesToCheck(project, ids)) {
    const base = { id: r.id!, title: r.title };
    const how = commandFor(project, parseEnforcedBy(r.meta["enforced-by"]));
    let result: CheckResult;
    if ("skip" in how) result = { ...base, status: "skipped", message: how.skip };
    else {
      const start = performance.now();
      const proc = Bun.spawn(["sh", "-c", how.command], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const output = out + (err ? (out.endsWith("\n") || !out ? "" : "\n") + err : "");
      const seconds = Math.round((performance.now() - start) / 100) / 10;
      const suspect = failIf ? new RegExp(failIf).test(output) : false;
      const pass = code === 0 && !suspect;
      result = {
        ...base,
        status: pass ? "pass" : "fail",
        message: pass ? "passed" : suspect ? `the output matches "${failIf}" (check.fail-if-output): nothing was really checked` : `exit ${code}`,
        command: how.command,
        seconds,
        ...(pass ? {} : { tail: output.trimEnd().split("\n").slice(-TAIL) }),
      };
    }
    results.push(result);
    onResult(result);
  }
  return results;
}

export const CHECKS_LOG = "log/checks.json";

export interface ChecksLog {
  [id: string]: { status: CheckResult["status"]; at: string; message: string };
}

export function readChecksLog(root: string): ChecksLog {
  const path = join(root, DIR, CHECKS_LOG);
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ChecksLog) : {};
  } catch {
    return {};
  }
}

// Stamp `checked:` on each rule that passed (under the lock, linted), and keep
// every result in log/checks.json.
export async function recordChecks(root: string, results: CheckResult[]) {
  const passed = results.filter((r) => r.status === "pass").map((r) => r.id);
  if (passed.length) {
    await withFiles(root, async (before) => {
      const changes = new Changes(before);
      for (const id of passed) changes.change(id, (e) => withMeta(e, { checked: today() }));
      return { writes: changes.writes(), result: undefined };
    });
  }
  const log = readChecksLog(root);
  const at = new Date().toISOString().slice(0, 16) + "Z";
  for (const r of results) log[r.id] = { status: r.status, at, message: r.message };
  await mkdir(join(root, DIR, "log"), { recursive: true });
  await Bun.write(join(root, DIR, CHECKS_LOG), JSON.stringify(log, null, 2) + "\n");
}

// For the brief: the active rules' machine checks, by their last result.
export function checkCounts(project: Project, log: ChecksLog): { pass: number; fail: number; unrunnable: number; notRun: number } {
  const counts = { pass: 0, fail: 0, unrunnable: 0, notRun: 0 };
  for (const r of rulesToCheck(project, [])) {
    const how = commandFor(project, parseEnforcedBy(r.meta["enforced-by"]));
    if ("skip" in how) counts.unrunnable++;
    else if (log[r.id!]?.status === "pass") counts.pass++;
    else if (log[r.id!]?.status === "fail") counts.fail++;
    else counts.notRun++;
  }
  return counts;
}
