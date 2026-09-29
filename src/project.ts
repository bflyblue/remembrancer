import { existsSync, readdirSync } from "node:fs";
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

// IDs are never reused: take the highest number seen anywhere (headings and
// mentions, archive included). Questions and answers share one sequence.
export function nextId(project: Project, kind: Kind): string {
  const family: Kind[] = kind === "Q" || kind === "A" ? ["Q", "A"] : [kind];
  let max = 0;
  for (const f of project.files) {
    for (const id of mentions(f.text)) {
      if (family.includes(id[0] as Kind)) max = Math.max(max, parseInt(id.slice(1), 10));
    }
  }
  return padId(kind, max + 1);
}

export class ConflictError extends Error {
  constructor(public file: string) {
    super(`${file} changed on disk since it was loaded`);
  }
}

export class NotFoundError extends Error {}

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

export async function replaceEntry(root: string, ref: EntryRef, raw: string) {
  const { file } = await checkedEntry(root, ref.file, ref.hash, ref.index, ref.id);
  await writeAtomic(join(root, DIR, ref.file), spliceEntry(file, ref.index, raw));
}

export async function deleteEntry(root: string, ref: EntryRef) {
  const { file } = await checkedEntry(root, ref.file, ref.hash, ref.index, ref.id);
  await writeAtomic(join(root, DIR, ref.file), removeEntry(file, ref.index));
}

export async function setMeta(root: string, ref: EntryRef, updates: Record<string, string>) {
  const { file, entry } = await checkedEntry(root, ref.file, ref.hash, ref.index, ref.id);
  await writeAtomic(join(root, DIR, ref.file), spliceEntry(file, ref.index, withMeta(entry, updates)));
}

// Move an entry to the top of another file. The target is written first, so
// a crash in between leaves a duplicate (which lint reports), never a loss.
async function moveEntry(root: string, ref: EntryRef, target: (e: Entry) => string, header: string, updates = {}) {
  const { file, entry } = await checkedEntry(root, ref.file, ref.hash, ref.index, ref.id);
  const to = target(entry);
  const existing = await readParsed(root, to);
  const raw = Object.keys(updates).length ? withMeta(entry, updates) : entry.raw;
  await writeAtomic(join(root, DIR, to), prependEntry(existing.text || header, raw));
  await writeAtomic(join(root, DIR, ref.file), removeEntry(file, ref.index));
  return to;
}

// Move a done entry into archive/done-YYYY.md (year of its `done:` date).
export async function archiveEntry(root: string, ref: EntryRef) {
  if (ref.file.startsWith("archive/")) throw new NotFoundError(`${ref.id} is already archived`);
  const stem = ref.file.replace(/\.md$/, "");
  const year = (e: Entry) => (e.meta.done ?? e.meta.answered ?? today()).slice(0, 4);
  return moveEntry(root, ref, (e) => `archive/${stem}-${year(e)}.md`, `# Archive: ${stem}\n`);
}

// Move a todo to the top of done.md, stamping today's date.
export async function completeEntry(root: string, ref: EntryRef) {
  if (ref.file !== "todo.md") throw new NotFoundError(`${ref.id} is not an open todo`);
  return moveEntry(root, ref, () => "done.md", "# Done\n", { done: today() });
}

export async function replaceFile(root: string, rel: string, hash: string, text: string) {
  if (!isValidFile(rel)) throw new NotFoundError(`unknown file ${rel}`);
  const file = await readParsed(root, rel);
  if (file.hash !== hash) throw new ConflictError(rel);
  await writeAtomic(join(root, DIR, rel), text);
}

