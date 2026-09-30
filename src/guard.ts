import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mentions } from "./model";
import { type Project, findRoot, loadProject, visibility } from "./project";

// Commands whose text ends up in git history or on the forge: the commit or
// tag message, and PR or issue text. Everything from the match to the end of
// the command is scanned, so a heredoc message counts too.
const PUBLISHING = [
  /\bgit\s+(?:-[Cc]\s+\S+\s+)*(commit|tag)\b/,
  /\bgh\s+(?:pr|issue)\s+(?:create|edit|comment|review)\b/,
];

const FILE_FLAGS = new Set(["-F", "--file", "--body-file"]);

export interface Leak {
  id: string;
  title: string;
  where: string; // "message" or the staged file the ID was added to
}

function words(text: string): string[] {
  return text.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
}

// Added lines of the change about to be committed, by file. `-a` commits
// tracked changes that aren't staged yet, so it diffs against HEAD instead.
function addedLines(cwd: string, all: boolean): Map<string, string> {
  const args = ["git", "diff", all ? "HEAD" : "--cached", "-U0", "--no-color", "--no-ext-diff"];
  const proc = Bun.spawnSync(args, { cwd, stderr: "ignore" });
  const out = new Map<string, string>();
  if (proc.exitCode !== 0) return out;
  let file = "";
  for (const line of proc.stdout.toString().split("\n")) {
    if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("+") && file) out.set(file, (out.get(file) ?? "") + line.slice(1) + "\n");
  }
  return out;
}

// The IDs of this project's entries that a command would publish. Only IDs
// that exist count, so "T800" or "R2" in ordinary text never blocks anything.
export function leaks(project: Project, command: string, cwd: string): Leak[] {
  const match = PUBLISHING.map((re) => re.exec(command)).find(Boolean);
  if (!match) return [];
  const text = command.slice(match.index);
  const sources: [where: string, text: string][] = [["message", text]];
  const args = words(text);
  args.forEach((w, i) => {
    const path = FILE_FLAGS.has(w) ? args[i + 1] : w.startsWith("--body-file=") ? w.slice(12) : "";
    if (path && path !== "-" && existsSync(resolve(cwd, path))) sources.push(["message", readFileSync(resolve(cwd, path), "utf8")]);
  });
  if (match[1] === "commit") {
    const all = args.some((w) => w === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(w));
    sources.push(...addedLines(cwd, all));
  }

  const title = (id: string) => project.byId.get(id)?.[0]?.title ?? project.byId.get("A" + id.slice(1))?.[0]?.title;
  const seen = new Set<string>();
  const out: Leak[] = [];
  for (const [where, body] of sources) {
    for (const id of mentions(body)) {
      const t = title(id);
      if (t === undefined || seen.has(`${id} ${where}`)) continue;
      seen.add(`${id} ${where}`);
      out.push({ id, title: t, where });
    }
  }
  return out;
}

// Why a command must not run, or null. Only a project whose .remembrancer/
// git ignores is guarded: when it is committed, its IDs resolve for everyone.
export async function guard(command: string, cwd: string): Promise<string | null> {
  const root = findRoot(cwd);
  if (!root || visibility(root) !== "private") return null;
  const found = leaks(await loadProject(root), command, cwd);
  if (!found.length) return null;
  const lines = found.map((l) => `  ${l.id} "${l.title}" (${l.where === "message" ? "in the message" : `added in ${l.where}`})`);
  return [
    "remembrancer: git ignores .remembrancer/, so these IDs would mean nothing to anyone reading the history:",
    ...lines,
    "Describe each one in words instead (and remove it from the staged code), then run the command again.",
  ].join("\n");
}
