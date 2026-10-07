// References from entries to the code, and when they go stale. Two kinds:
// - cited paths: `src/foo.ts` in backticks, [text](path) links, and a
//   resource's `link:`; a bare name (`Burn.hs`) counts when exactly one
//   tracked file ends with it;
// - anchors: a stable name in a code comment, `anchor: capture-entry-rows`
//   (a space), cited from an entry as `anchor:capture-entry-rows` (none).
//   Code moves; the anchor moves with it.
// Both are checked by full lint only: they read the git work tree.
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Entry } from "./model";
import { DIR, type Project } from "./project";

export interface Repo {
  top: string; // the git work tree, or the project root outside git
  tracked: string[]; // tracked files, relative to top; empty outside git
  extensions: Set<string>; // the extensions of tracked files: what a cited name may end with
}

export function repoOf(root: string): Repo {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: root, stderr: "ignore" });
  if (top.exitCode !== 0) return { top: root, tracked: [], extensions: new Set() };
  const dir = top.stdout.toString().trim();
  const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: dir, stderr: "ignore" });
  const tracked = ls.stdout.toString().split("\0").filter(Boolean);
  const extensions = new Set(tracked.map(extensionOf).filter((x): x is string => !!x));
  return { top: dir, tracked, extensions };
}

function extensionOf(path: string): string | null {
  // Case kept: `Trace.Json` (a module) is not a `.json` file.
  return /\.([A-Za-z0-9]{1,8})$/.exec(path.split("/").pop() ?? "")?.[1] ?? null;
}

// Text that names a file: path characters only, and either a folder path
// ending in "/" or a name with an extension some tracked file has. So
// `Iapetus.Canonical`, `km/s` and `e.meta` are not paths; `lib/Burn.hs`,
// `Burn.hs` and `docs/plans/` are.
export function looksLikePath(text: string, repo: Repo): boolean {
  if (!/^[\w.@~/-][\w.@/+-]*$/.test(text) || /^\.+$/.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text)) return false;
  if (text.includes("/") && text.endsWith("/")) return true;
  const ext = extensionOf(text);
  return !!ext && (repo.extensions.size ? repo.extensions.has(ext) : text.includes("/"));
}

// The paths an entry cites: backtick spans and markdown link targets in its
// body (fenced code skipped), as written.
export function citedPaths(e: Entry, repo: Repo): string[] {
  const body = e.body.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "");
  const out = new Set<string>();
  for (const m of body.matchAll(/`([^`\n]{1,300})`/g)) {
    const text = m[1].trim().replace(/:\d+(-\d+)?$/, ""); // `src/a.ts:12` cites src/a.ts
    if (looksLikePath(text, repo)) out.add(text);
  }
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    let target = m[1].split(/[?#]/)[0];
    try {
      target = decodeURIComponent(target);
    } catch {}
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(m[1]) && !m[1].startsWith("#")) out.add(target);
  }
  return [...out];
}

// Whether a cited path names something that exists: from the entry's own
// file (as markdown means it), the project root, then the git work tree; a
// bare name, when exactly one tracked file ends with it.
// "ambiguous": a bare name that several tracked files end with.
export function pathExists(path: string, entryFile: string, root: string, repo: Repo): "yes" | "no" | "ambiguous" {
  const bases = isAbsolute(path) ? [""] : [dirname(join(root, DIR, entryFile)), root, repo.top];
  for (const base of bases) {
    const full = resolve(base, path);
    if (existsSync(full) && (!path.endsWith("/") || statSync(full).isDirectory())) return "yes";
  }
  if (path.includes("/")) return "no";
  const n = repo.tracked.filter((t) => t === path || t.endsWith("/" + path)).length;
  return n === 1 ? "yes" : n > 1 ? "ambiguous" : "no";
}

export const ANCHOR_NAME = "[a-z0-9][a-z0-9-]*";
const CITATION = new RegExp(`\\banchor:(${ANCHOR_NAME})`, "g");

export interface AnchorDef {
  name: string;
  file: string; // relative to the work tree
  line: number;
}

// A definition: the word "anchor" (not `text-anchor`), and the name last on its
// line but for a comment closer, so prose ("-- anchor: the event") is not one.
const DEFINITION = new RegExp(`(?:^|[^\\w-])anchor: (${ANCHOR_NAME})\\s*(?:-->|\\*/|-\\}|\\*\\))?\\s*$`);

// Every `anchor: name` in the tracked files, outside .remembrancer/ and binaries.
export function anchorDefinitions(repo: Repo): AnchorDef[] {
  if (!repo.tracked.length) return [];
  const grep = Bun.spawnSync(
    ["git", "grep", "-I", "-n", "-E", `anchor: ${ANCHOR_NAME}`, "--", ".", `:(exclude)${DIR}`, `:(exclude)**/${DIR}`],
    { cwd: repo.top, stderr: "ignore" },
  );
  const out: AnchorDef[] = [];
  for (const line of grep.stdout.toString().split("\n")) {
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    const def = m && DEFINITION.exec(m[3]);
    if (def) out.push({ file: m![1], line: parseInt(m![2], 10), name: def[1] });
  }
  return out;
}

// The anchors each entry cites, by name.
export function anchorCitations(project: Project): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  for (const e of project.entries) {
    if (!e.id) continue;
    for (const m of e.raw.matchAll(CITATION)) {
      const list = out.get(m[1]) ?? [];
      if (!list.includes(e)) out.set(m[1], [...list, e]);
    }
  }
  return out;
}

export interface Drift {
  entry: Entry;
  message: string;
}
// Cited paths that name nothing, and cited anchors no tracked file defines.
// archive/ is history: what its entries cite may be gone, and that is no fault.
export function drift(project: Project, repo = repoOf(project.root)): Drift[] {
  const out: Drift[] = [];
  for (const e of project.entries) {
    if (!e.id || e.file.startsWith("archive/")) continue;
    for (const path of citedPaths(e, repo)) {
      const found = pathExists(path, e.file, project.root, repo);
      if (found === "no") out.push({ entry: e, message: `cites ${path}, which does not exist (moved? cite an anchor instead)` });
      if (found === "ambiguous") out.push({ entry: e, message: `cites ${path}, but several tracked files have that name: give its path` });
    }
    const link = e.kind === "K" ? e.meta.link : undefined;
    if (link && !/^([a-z][a-z0-9+.-]*:|www\.)/i.test(link) && pathExists(link, "", project.root, repo) !== "yes") {
      out.push({ entry: e, message: `link ${link} does not exist` });
    }
  }
  const defined = new Set(anchorDefinitions(repo).map((d) => d.name));
  for (const [name, entries] of anchorCitations(project)) {
    if (defined.has(name)) continue;
    for (const e of entries) out.push({ entry: e, message: `cites anchor:${name}, which no tracked file defines (\`anchor: ${name}\` in a comment)` });
  }
  return out;
}
