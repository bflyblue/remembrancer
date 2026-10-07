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

// `.remembrancer/config.json`, optional, every key optional:
// - `owner`: whose decisions `waiting-on` tracks first (the brief's "waiting on you");
// - `stale`: days without change after which an entry is stale, per kind
//   (policy, so settable; the defaults are in signals.ts);
// - `knowledge-base`: true to archive into kb/<stem>.md instead of
//   archive/<stem>-<year>.md, and to read kb/ as part of the project.
export interface Config {
  owner?: string;
  stale?: Partial<Record<Kind, number>>;
  "knowledge-base"?: boolean;
  check?: {
    test?: string; // the command that runs one test: {file} and {name} are filled in
    cwd?: string; // where checks run and enforced-by paths are read (default: the project root)
    "fail-if-output"?: string; // a regex: output matching it fails a check that exited 0 (a pattern that matched no test)
  };
}

export const CONFIG = "config.json";

export function readConfig(root: string): { config: Config; error: string | null } {
  const path = join(root, DIR, CONFIG);
  if (!existsSync(path)) return { config: {}, error: null };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return { config: {}, error: "is not a JSON object" };
    if (data.owner !== undefined && (typeof data.owner !== "string" || !/^[\w-]+$/.test(data.owner))) return { config: {}, error: `owner must be one word` };
    if (data.stale !== undefined) {
      const ok = typeof data.stale === "object" && data.stale !== null && !Array.isArray(data.stale) &&
        Object.entries(data.stale).every(([k, v]) => ["T", "Q", "A", "R", "K"].includes(k) && Number.isInteger(v) && (v as number) >= 0);
      if (!ok) return { config: {}, error: `stale must map T, Q, A, R or K to a whole number of days, like {"T": 30}` };
    }
    if (data["knowledge-base"] !== undefined && typeof data["knowledge-base"] !== "boolean") return { config: {}, error: "knowledge-base must be true or false" };
    if (data.check !== undefined) {
      const c = data.check;
      const ok = typeof c === "object" && c !== null && !Array.isArray(c) && Object.entries(c).every(([k, v]) => ["test", "cwd", "fail-if-output"].includes(k) && typeof v === "string");
      if (!ok) return { config: {}, error: `check must be {"test": "…", "cwd": "…", "fail-if-output": "…"}, each a string` };
      if (c["fail-if-output"] !== undefined) {
        try {
          new RegExp(c["fail-if-output"]);
        } catch {
          return { config: {}, error: "check.fail-if-output is not a valid regular expression" };
        }
      }
    }
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

// The folders that hold entry files: the active set, the dated archive, and
// the knowledge base (read only when config.json turns it on).
export const DIRS = ["", "archive/", "kb/"] as const;

export function kbOn(root: string): boolean {
  return readConfig(root).config["knowledge-base"] === true;
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of DIRS) {
    if (dir === "") out.push(...FILES.filter((f) => existsSync(join(root, DIR, f))));
    else if (dir !== "kb/" || kbOn(root)) {
      const path = join(root, DIR, dir);
      if (!existsSync(path)) continue;
      const names = readdirSync(path).filter((f) => f.endsWith(".md")).sort();
      out.push(...(dir === "archive/" ? names.reverse() : names).map((f) => dir + f));
    }
  }
  return out;
}

export function isValidFile(rel: string): boolean {
  return (FILES as readonly string[]).includes(rel) || /^(archive|kb)\/[\w.-]+\.md$/.test(rel);
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
  return buildProject(root, await Promise.all(listFiles(root).map((rel) => readParsed(root, rel))));
}

// A project from parsed files, read from disk or computed (a dry run).
export function buildProject(root: string, files: ParsedFile[]): Project {
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
