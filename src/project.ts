import { closeSync, existsSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  type Entry,
  type Kind,
  type ParsedFile,
  mentions,
  padId,
  parseFile,
  prependEntry,
  removeEntry,
  spliceEntry,
  today,
  withMeta,
} from "./model";

export const DIR = ".remembrancer";
export const FILES = ["todo.md", "done.md", "questions.md", "answers.md", "rules.md", "scratch.md"] as const;

export interface Project {
  root: string;
  name: string;
  files: ParsedFile[];
  entries: Entry[];
  byId: Map<string, Entry[]>;
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

export async function readParsed(root: string, rel: string): Promise<ParsedFile> {
  const f = Bun.file(join(root, DIR, rel));
  return parseFile(rel, (await f.exists()) ? await f.text() : "");
}

export async function loadProject(root: string): Promise<Project> {
  const files = await Promise.all(listFiles(root).map((rel) => readParsed(root, rel)));
  const entries = files.flatMap((f) => f.entries);
  const byId = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!e.id) continue;
    byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
  }
  return { root, name: basename(root), files, entries, byId };
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

const CLAIM: Record<Kind, [file: string, meta: string]> = {
  T: ["todo.md", "added: "],
  Q: ["questions.md", "asked: "],
  A: ["answers.md", "answered: "],
  R: ["rules.md", "status: proposed · added: "],
};

// Allocate the next ID and append a stub entry for it, under the lock, so two
// callers in the same checkout never get the same number. The stub leaves the
// other required fields for the caller to fill in (full lint reports them).
export async function claimId(root: string, kind: Kind, title: string): Promise<string> {
  return withLock(root, async () => {
    const id = nextId(await loadProject(root), kind);
    const [rel, meta] = CLAIM[kind];
    const file = await readParsed(root, rel);
    if (!file.text) throw new NotFoundError(`${DIR}/${rel} does not exist (run: remembrancer init)`);
    await writeAtomic(join(root, DIR, rel), `${file.text.replace(/\n*$/, "\n\n")}## ${id} · ${title}\n${meta}${today()}\n`);
    return id;
  });
}

// An exclusive lock for writes from the CLI and the UI. Agents editing the
// files directly don't take it; lint's duplicate-id check is the backstop.
async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const path = join(root, DIR, ".lock");
  for (let tries = 0; ; tries++) {
    try {
      closeSync(openSync(path, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A lock this old was left behind by a crash.
      if (Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 10_000) rmSync(path, { force: true });
      else if (tries > 100) throw new Error(`${DIR}/.lock is held; remove it if no remembrancer command is running`);
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
  constructor(public file: string) {
    super(`${file} changed on disk since it was loaded`);
  }
}

export class NotFoundError extends Error {}

export class RefusedError extends Error {}

async function writeAtomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await Bun.write(tmp, text);
  await rename(tmp, path);
}

async function checkedEntry(root: string, rel: string, hash: string, index: number, id: string | null) {
  if (!isValidFile(rel)) throw new NotFoundError(`unknown file ${rel}`);
  const file = await readParsed(root, rel);
  if (file.hash !== hash) throw new ConflictError(rel);
  const entry = file.entries[index];
  if (!entry || entry.id !== id) throw new NotFoundError(`entry ${id} not found in ${rel}`);
  return { file, entry };
}

export interface EntryRef {
  file: string;
  hash: string;
  index: number;
  id: string | null;
}

// Every write below holds the lock from its hash check to its last write, so
// the check can't pass against a file another writer is about to change.
export async function replaceEntry(root: string, ref: EntryRef, raw: string) {
  await withLock(root, async () => {
    const { file } = await checkedEntry(root, ref.file, ref.hash, ref.index, ref.id);
    await writeAtomic(join(root, DIR, ref.file), spliceEntry(file, ref.index, raw));
  });
}

// Only an entry without an ID (a malformed heading) can be deleted. Deleting
// one with an ID would free its number: drop a todo, answer a question (with
// a stub answer if it was abandoned) or retire a rule instead.
export async function deleteEntry(root: string, ref: EntryRef) {
  await withLock(root, async () => {
    const { file, entry } = await checkedEntry(root, ref.file, ref.hash, ref.index, ref.id);
    if (entry.id) throw new RefusedError(`${entry.id} has an ID, so it is never deleted: drop, answer or retire it instead`);
    await writeAtomic(join(root, DIR, ref.file), removeEntry(file, ref.index));
  });
}

export async function setMeta(root: string, ref: EntryRef, updates: Record<string, string>) {
  await withLock(root, async () => {
    const { file, entry } = await checkedEntry(root, ref.file, ref.hash, ref.index, ref.id);
    await writeAtomic(join(root, DIR, ref.file), spliceEntry(file, ref.index, withMeta(entry, updates)));
  });
}

// Move an entry to the top of another file. The target is written first, so
// a crash in between leaves a duplicate (which lint reports), never a loss.
async function moveEntry(root: string, ref: EntryRef, target: (e: Entry) => string, header: string, updates = {}) {
  return withLock(root, async () => {
    const { file, entry } = await checkedEntry(root, ref.file, ref.hash, ref.index, ref.id);
    const to = target(entry);
    const existing = await readParsed(root, to);
    const raw = Object.keys(updates).length ? withMeta(entry, updates) : entry.raw;
    await writeAtomic(join(root, DIR, to), prependEntry(existing.text || header, raw));
    await writeAtomic(join(root, DIR, ref.file), removeEntry(file, ref.index));
    return to;
  });
}

// Move a done entry into archive/done-YYYY.md (year of its `done:` date).
export async function archiveEntry(root: string, ref: EntryRef) {
  if (ref.file.startsWith("archive/")) throw new NotFoundError(`${ref.id} is already archived`);
  const stem = ref.file.replace(/\.md$/, "");
  const year = (e: Entry) => (e.meta.done ?? e.meta.answered ?? today()).slice(0, 4);
  return moveEntry(root, ref, (e) => `archive/${stem}-${year(e)}.md`, `# Archive: ${stem}\n`);
}

// Move a todo to the top of done.md, stamping today's date. A dropped todo
// goes the same way, marked `dropped: yes`, so its number stays taken.
export async function completeEntry(root: string, ref: EntryRef, { dropped = false } = {}) {
  if (ref.file !== "todo.md") throw new NotFoundError(`${ref.id} is not an open todo`);
  return moveEntry(root, ref, () => "done.md", "# Done\n", { done: today(), ...(dropped ? { dropped: "yes" } : {}) });
}

export async function replaceFile(root: string, rel: string, hash: string, text: string) {
  if (!isValidFile(rel)) throw new NotFoundError(`unknown file ${rel}`);
  await withLock(root, async () => {
    const file = await readParsed(root, rel);
    if (file.hash !== hash) throw new ConflictError(rel);
    await writeAtomic(join(root, DIR, rel), text);
  });
}

