import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type Entry, type Kind, type ParsedFile, mentions, padId, parseFile } from "./model";

export const DIR = ".remembrancer";
export const FILES = ["todo.md", "done.md", "questions.md", "answers.md", "rules.md", "resources.md", "scratch.md"] as const;

export interface Project {
  root: string;
  name: string;
  files: ParsedFile[];
  entries: Entry[];
  byId: Map<string, Entry[]>;
  config: Config;
  configError: string | null; // why config.json could not be read, if it couldn't
}

// `.remembrancer/config.json`, optional. `owner`: whose decisions `waiting-on`
// tracks first (the brief's "waiting on you").
export interface Config {
  owner?: string;
}

export const CONFIG = "config.json";

export function readConfig(root: string): { config: Config; error: string | null } {
  const path = join(root, DIR, CONFIG);
  if (!existsSync(path)) return { config: {}, error: null };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return { config: {}, error: "is not a JSON object" };
    if (data.owner !== undefined && (typeof data.owner !== "string" || !/^[\w-]+$/.test(data.owner))) return { config: {}, error: `owner must be one word` };
    return { config: data as Config, error: null };
  } catch (err) {
    return { config: {}, error: `is not valid JSON (${(err as Error).message})` };
  }
}

export function findRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Whether .remembrancer/ goes into commits. "private": git ignores it (the
// default after init), so its IDs mean nothing to anyone reading the history.
// "committed": tracked, or not ignored and so picked up by the next `git add`.
// null: not in a git repository.
export function visibility(root: string): "private" | "committed" | null {
  const proc = Bun.spawnSync(["git", "check-ignore", "-q", DIR], { cwd: root, stderr: "ignore" });
  return proc.exitCode === 0 ? "private" : proc.exitCode === 1 ? "committed" : null;
}

export function listFiles(root: string): string[] {
  const out: string[] = FILES.filter((f) => existsSync(join(root, DIR, f)));
  const archive = join(root, DIR, "archive");
  if (existsSync(archive)) {
    for (const f of readdirSync(archive).sort().reverse()) {
      if (f.endsWith(".md")) out.push(`archive/${f}`);
    }
  }
  return out;
}

export function isValidFile(rel: string): boolean {
  return (FILES as readonly string[]).includes(rel) || /^archive\/[\w.-]+\.md$/.test(rel);
}

// A file is read as UTF-8; the lines holding bytes that aren't valid UTF-8 are
// recorded in `badLines` (they read as U+FFFD), for lint to report.
export async function readParsed(root: string, rel: string): Promise<ParsedFile> {
  const f = Bun.file(join(root, DIR, rel));
  if (!(await f.exists())) return parseFile(rel, "");
  const bytes = new Uint8Array(await f.arrayBuffer());
  try {
    return parseFile(rel, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    const text = new TextDecoder("utf-8").decode(bytes);
    const parsed = parseFile(rel, text);
    parsed.badLines = text.split("\n").flatMap((l, i) => (l.includes("\uFFFD") ? [i + 1] : []));
    return parsed;
  }
}

export async function loadProject(root: string): Promise<Project> {
  const files = await Promise.all(listFiles(root).map((rel) => readParsed(root, rel)));
  const entries = files.flatMap((f) => f.entries);
  const byId = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!e.id) continue;
    byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
  }
  const { config, error } = readConfig(root);
  return { root, name: basename(root), files, entries, byId, config, configError: error };
}

// The numbers in use in a sequence: every entry heading (archive included)
// and every `closes:` value. Questions and answers share one sequence.
// Mentions in text never count, so a typo can't burn a range of numbers.
export function usedNumbers(project: Project, kind: Kind): Set<number> {
  const family: Kind[] = kind === "Q" || kind === "A" ? ["Q", "A"] : [kind];
  const used = new Set<number>();
  const add = (id: string) => family.includes(id[0] as Kind) && used.add(parseInt(id.slice(1), 10));
  for (const e of project.entries) {
    if (e.id) add(e.id);
    for (const id of mentions(e.meta.closes ?? "")) add(id);
  }
  return used;
}

// IDs are never reused: one more than the highest number in use. Entries with
// an ID are never deleted (lint reports the gap), so a number is never freed.
export function nextId(project: Project, kind: Kind): string {
  return padId(kind, Math.max(0, ...usedNumbers(project, kind)) + 1);
}

// An exclusive lock for writes from the CLI and the UI. Agents editing the
// files directly don't take it; lint's duplicate-id check is the backstop.
// Hold it only across read, check and write: never across a subprocess, since
// a lock older than LOCK_STALE_MS is taken to be left behind by a crash.
export const LOCK = ".lock";
export const LOCK_STALE_MS = 10_000;

export async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const path = join(root, DIR, LOCK);
  for (let tries = 0; ; tries++) {
    try {
      closeSync(openSync(path, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > LOCK_STALE_MS) rmSync(path, { force: true });
      else if (tries > 100) throw new Error(`${DIR}/${LOCK} is held; remove it if no remembrancer command is running`);
      else await Bun.sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}

export class ConflictError extends Error {
  constructor(public file: string, message = `${file} changed on disk since it was loaded`) {
    super(message);
  }
}

export class NotFoundError extends Error {}

export class RefusedError extends Error {}

export async function writeAtomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await Bun.write(tmp, text);
  await rename(tmp, path);
}

// Where a caller last saw an entry. With `entry` (the entry's own hash, as
// `show` prints it), the entry is found by its ID and only it must be
// unchanged, so edits elsewhere in the file don't invalidate the ref. Without
// it, the whole file must be unchanged (`hash`) and the entry is at `index`.
export interface EntryRef {
  file: string;
  hash: string;
  index: number;
  id: string | null;
  entry?: string;
}

// Call under the lock. Returns the entry as it is now: by-ID refs may find it
// at another index, so callers splice at `entry.index`, never `ref.index`.
export async function checkedEntry(root: string, ref: EntryRef): Promise<{ file: ParsedFile; entry: Entry }> {
  if (!isValidFile(ref.file)) throw new NotFoundError(`unknown file ${ref.file}`);
  const file = await readParsed(root, ref.file);
  if (ref.entry !== undefined) {
    const found = ref.id ? file.entries.filter((e) => e.id === ref.id) : [file.entries[ref.index]].filter(Boolean);
    if (found.length > 1) throw new RefusedError(`${ref.id} appears ${found.length} times in ${ref.file}: run lint`);
    const entry = found[0];
    if (!entry || entry.id !== ref.id) throw new NotFoundError(`entry ${ref.id} not found in ${ref.file}`);
    if (entry.hash !== ref.entry) throw new ConflictError(ref.file, `${ref.id ?? "the entry"} in ${ref.file} changed since it was read`);
    return { file, entry };
  }
  if (file.hash !== ref.hash) throw new ConflictError(ref.file);
  const entry = file.entries[ref.index];
  if (!entry || entry.id !== ref.id) throw new NotFoundError(`entry ${ref.id} not found in ${ref.file}`);
  return { file, entry };
}
