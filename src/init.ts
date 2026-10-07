import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Problem } from "./analyse";
import { DIR, FILES, LOCK, LOCK_STALE_MS, loadProject, visibility } from "./project";
import answers from "../skill/templates/answers.md" with { type: "text" };
import done from "../skill/templates/done.md" with { type: "text" };
import questions from "../skill/templates/questions.md" with { type: "text" };
import resources from "../skill/templates/resources.md" with { type: "text" };
import rules from "../skill/templates/rules.md" with { type: "text" };
import scratch from "../skill/templates/scratch.md" with { type: "text" };
import todo from "../skill/templates/todo.md" with { type: "text" };

export const TEMPLATES: Record<(typeof FILES)[number], string> = {
  "todo.md": todo,
  "done.md": done,
  "questions.md": questions,
  "answers.md": answers,
  "rules.md": rules,
  "resources.md": resources,
  "scratch.md": scratch,
};

const MARKER = "<!-- remembrancer -->";
export const AGENTS_SNIPPET = `${MARKER}
## Remembrancer

This project keeps its working memory in \`.remembrancer/\` (use the remembrancer skill):
tasks, done work, open questions, answers and rules.
Before reviewing code or committing, check the change against the active rules in
\`.remembrancer/rules.md\`, run any \`enforced-by\` checks, and cite the rule IDs (R###) that apply.
If git ignores \`.remembrancer/\`, keep its IDs out of commits, PRs, code and comments.
`;

async function gitDir(root: string): Promise<string | null> {
  const proc = Bun.spawnSync(["git", "rev-parse", "--absolute-git-dir"], { cwd: root, stderr: "ignore" });
  if (proc.exitCode !== 0) return null;
  // Worktrees share info/exclude with the common dir.
  const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, stderr: "ignore" });
  const out = (common.exitCode === 0 ? common.stdout : proc.stdout).toString().trim();
  return out || null;
}

// The tool's own files, never to be committed: each ignore line (relative to
// the project root) and paths it must cover. The paths go through
// `git check-ignore`, so any pattern the user wrote instead counts too.
// Temporary files appear in archive/ as well, hence `**/`.
export const IGNORED: { line: string; what: string; probes: string[] }[] = [
  { line: `/${DIR}/${LOCK}`, what: "the write lock", probes: [`${DIR}/${LOCK}`] },
  { line: `/${DIR}/**/*.tmp-*`, what: "half-written files", probes: [`${DIR}/todo.md.tmp-1`, `${DIR}/archive/done-2026.md.tmp-1`] },
  { line: `/${DIR}/.index.db`, what: "a search index", probes: [`${DIR}/.index.db`] },
  { line: `/${DIR}/log/`, what: "the curation log", probes: [`${DIR}/log/x`] },
  { line: `/${DIR}/proposals/`, what: "queued proposals", probes: [`${DIR}/proposals/x`] },
];

// The project root's path below the git work tree, as an ignore-line prefix
// ("" at the top): .git/info/exclude is read relative to the top.
function gitPrefix(root: string): string {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: root, stderr: "ignore" });
  const rel = top.exitCode === 0 ? relative(realpathSync(top.stdout.toString().trim()), realpathSync(root)) : "";
  return rel ? "/" + rel.split("\\").join("/") : "";
}

function isIgnored(root: string, path: string): boolean {
  return Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd: root, stderr: "ignore" }).exitCode === 0;
}

export interface DoctorReport {
  problems: Problem[]; // what is still wrong
  fixed: string[]; // what --fix changed
}

// Checks of the folder's health that lint does not make: tool files a
// committed folder would publish, a lock left by a crash, duplicate IDs.
// With `fix`, ignore lines go into .gitignore (committed) or
// .git/info/exclude (private), and a stale lock is removed.
export async function doctor(root: string, { fix = false } = {}): Promise<DoctorReport> {
  const problems: Problem[] = [];
  const fixed: string[] = [];
  const vis = visibility(root);
  if (vis === "committed") {
    const target = join(root, ".gitignore");
    for (const { line, what, probes } of IGNORED) {
      if (probes.every((p) => isIgnored(root, p))) continue;
      if (fix) {
        if (await ensureLine(target, line)) fixed.push(`added ${line} to .gitignore`);
      } else {
        problems.push({ file: ".gitignore", id: null, message: `${DIR}/ is committed but does not ignore ${what}: add "${line}"` });
      }
    }
  } else if (vis === "private" && fix) {
    const git = await gitDir(root);
    const exclude = git ? join(git, "info", "exclude") : null;
    const prefix = gitPrefix(root);
    for (const line of IGNORED.map(({ line }) => prefix + line)) {
      if (exclude && (await ensureLine(exclude, line))) fixed.push(`added ${line} to ${exclude}`);
    }
  }

  const lock = join(root, DIR, LOCK);
  const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
  if (age > LOCK_STALE_MS) {
    const secs = Math.round(age / 1000);
    if (fix) {
      rmSync(lock, { force: true });
      fixed.push(`removed a stale ${DIR}/${LOCK} (${secs}s old)`);
    } else {
      problems.push({ file: LOCK, id: null, message: `stale lock, ${secs}s old: left by a crash (doctor --fix removes it)` });
    }
  }

  for (const [id, list] of (await loadProject(root)).byId) {
    if (list.length > 1) problems.push({ file: list[0].file, id, message: `duplicate id ${id} in ${list.map((e) => e.file).join(", ")}: renumber one by hand` });
  }
  return { problems, fixed };
}

export async function ensureLine(path: string, line: string): Promise<boolean> {
  const f = Bun.file(path);
  const text = (await f.exists()) ? await f.text() : "";
  if (text.split("\n").some((l) => l.trim() === line)) return false;
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, (text && !text.endsWith("\n") ? "\n" : "") + line + "\n");
  return true;
}

export async function init(root: string, opts: { local?: boolean } = {}): Promise<string[]> {
  const log: string[] = [];
  await mkdir(join(root, DIR, "archive"), { recursive: true });
  for (const [name, text] of Object.entries(TEMPLATES)) {
    const path = join(root, DIR, name);
    if (!existsSync(path)) {
      await Bun.write(path, text);
      log.push(`created ${DIR}/${name}`);
    }
  }

  const git = await gitDir(root);
  if (git) {
    const exclude = join(git, "info", "exclude");
    if (await ensureLine(exclude, `/${DIR}/`)) log.push(`added /${DIR}/ to ${exclude}`);
    if (opts.local && (await ensureLine(exclude, "/CLAUDE.local.md"))) log.push(`added /CLAUDE.local.md to ${exclude}`);
    // Redundant while the folder is excluded, but in place if it is ever committed.
    const prefix = gitPrefix(root);
    let added = 0;
    for (const line of IGNORED.map(({ line }) => prefix + line)) if (await ensureLine(exclude, line)) added++;
    if (added) log.push(`added ${added} ignore line${added === 1 ? "" : "s"} for the tool's own files to ${exclude}`);
  } else {
    log.push(`not a git repository: ${DIR}/ is not excluded from anything`);
  }

  const target = opts.local
    ? "CLAUDE.local.md"
    : existsSync(join(root, "AGENTS.md")) || !existsSync(join(root, "CLAUDE.md"))
      ? "AGENTS.md"
      : "CLAUDE.md";
  const path = join(root, target);
  const f = Bun.file(path);
  const text = (await f.exists()) ? await f.text() : "";
  if (!text.includes(MARKER)) {
    await Bun.write(path, (text ? text.replace(/\s*$/, "\n\n") : "") + AGENTS_SNIPPET);
    log.push(`added the rules section to ${target}`);
  }
  return log;
}
