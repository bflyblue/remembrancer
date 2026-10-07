// The one layer every writer goes through: the CLI's commands and the UI's
// ops. Each write takes the lock, checks the entry against what the caller
// read, splices, stamps `touched:`, writes, and runs `lint --ids` on the
// result; a write that adds a lint problem is undone and refused. Reads
// (`show`) take no lock.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Problem, lint, requiredKeys, valueProblems } from "./analyse";
import { type Entry, type Kind, type ParsedFile, ID_RE, appendEntry, formatEntry, mentions, parseFile, prependEntry, removeEntry, spliceEntry, today, withMeta } from "./model";
import {
  ConflictError,
  DIR,
  type EntryRef,
  NotFoundError,
  type Project,
  RefusedError,
  checkedEntry,
  isValidFile,
  loadProject,
  nextId,
  readParsed,
  withLock,
  writeAtomic,
} from "./project";

// A write refused because it would add lint problems; nothing was changed.
export class LintRefusedError extends RefusedError {
  constructor(public problems: Problem[]) {
    super(`refused: the change would add ${problems.length} lint problem${problems.length === 1 ? "" : "s"}:\n` +
      problems.map((p) => `  ${DIR}/${p.file}: ${p.id ?? "?"}: ${p.message}`).join("\n"));
  }
}

// The one entry with this ID, anywhere in the project (archive included).
export function locate(project: Project, id: string): Entry {
  const found = project.byId.get(id.toUpperCase()) ?? [];
  if (found.length > 1) throw new RefusedError(`${id} appears in ${found.map((e) => e.file).join(", ")}: run lint`);
  if (!found.length) throw new NotFoundError(`no entry ${id}`);
  return found[0];
}

// A by-ID ref to an entry as it is in `project`.
export function refTo(project: Project, e: Entry): EntryRef {
  const hash = project.files.find((f) => f.path === e.file)?.hash ?? "";
  return { file: e.file, hash, index: e.index, id: e.id, entry: e.hash };
}

const KEY_RE = /^[a-z][a-z-]*$/;

// The meta line is split on " · ", so a value holding it (or a newline) would
// corrupt the entry.
export function checkFields(updates: Record<string, string>) {
  for (const [k, v] of Object.entries(updates)) {
    if (!KEY_RE.test(k)) throw new RefusedError(`"${k}" is not a field name (lowercase words joined by dashes)`);
    if (/\n/.test(v) || v.includes(" · ")) throw new RefusedError(`${k}: a value may not contain " · " or a newline`);
  }
}

// An entry's text with `updates` applied and `touched:` set to today.
export function stamp(e: Entry, updates: Record<string, string> = {}): string {
  return withMeta(e, { ...updates, touched: today() });
}

const problemKey = (p: Problem) => `${p.id ?? ""}\u0000${p.message}`;

// Write each file, then lint IDs and links. Problems the project already had
// don't count (keyed by ID and message, so a moved entry keeps its old ones);
// a new one restores every file as it was and refuses the write. Call under
// the lock, with `before` loaded under it.
async function commit(root: string, before: Project, writes: [rel: string, text: string][]) {
  const old = new Map<string, string | null>();
  for (const [rel] of writes) {
    if (old.has(rel)) continue;
    const path = join(root, DIR, rel);
    old.set(rel, (await Bun.file(path).exists()) ? await Bun.file(path).text() : null);
  }
  for (const [rel, text] of writes) await writeAtomic(join(root, DIR, rel), text);
  const known = new Set(lint(before, { ids: true }).map(problemKey));
  const added = lint(await loadProject(root), { ids: true }).filter((p) => !known.has(problemKey(p)));
  if (!added.length) return;
  for (const [rel, text] of [...old].reverse()) {
    if (text === null) rmSync(join(root, DIR, rel), { force: true });
    else await writeAtomic(join(root, DIR, rel), text);
  }
  throw new LintRefusedError(added);
}

type Writes = { writes: [rel: string, text: string][] };

// Lock, load the project, compute the new file texts from it, write them and
// lint. `fn` returns the writes (in order) and a result for the caller.
export async function withFiles<T>(root: string, fn: (before: Project) => Promise<Writes & { result: T }>): Promise<T> {
  return withLock(root, async () => {
    const before = await loadProject(root);
    const { writes, result } = await fn(before);
    await commit(root, before, writes);
    return result;
  });
}

// The same, for one entry checked against `ref` first.
export async function withEntry<T>(
  root: string,
  ref: EntryRef,
  fn: (file: ParsedFile, entry: Entry) => Promise<Writes & { result: T }>,
): Promise<T> {
  return withLock(root, async () => {
    const { file, entry } = await checkedEntry(root, ref);
    const before = await loadProject(root);
    const { writes, result } = await fn(file, entry);
    await commit(root, before, writes);
    return result;
  });
}

// An entry rewritten with a new title, metadata or body, stamped `touched:`.
export function rewrite(e: Entry, { title, body, updates = {} }: { title?: string; body?: string; updates?: Record<string, string> }): string {
  if (title === undefined && body === undefined) return stamp(e, updates);
  return formatEntry({ id: e.id!, title: title ?? e.title, meta: { ...e.meta, ...updates, touched: today() }, body: body ?? e.body });
}

function checkTitle(title: string) {
  if (!title.trim() || /\n/.test(title)) throw new RefusedError("a title is one non-empty line");
}

// Refuse values lint would reject in this file (enums, dates).
function checkValues(file: string, updates: Record<string, string>) {
  checkFields(updates);
  const bad = valueProblems(file, updates);
  if (bad.length) throw new RefusedError(bad.join("; "));
}

// Replace an entry's whole text (the UI's raw editor). A single entry is
// stamped `touched:`; anything else is written as given.
export async function replaceEntry(root: string, ref: EntryRef, raw: string) {
  await withEntry(root, ref, async (file, entry) => {
    const parsed = parseFile(ref.file, raw);
    const one = parsed.entries.length === 1 && parsed.preamble.trim() === "" ? parsed.entries[0] : null;
    return { writes: [[ref.file, spliceEntry(file, entry.index, one ? stamp(one) : raw)]], result: undefined };
  });
}

// Only an entry without an ID (a malformed heading) can be deleted. Deleting
// one with an ID would free its number: drop a todo, answer a question (with
// a stub answer if it was abandoned) or retire a rule instead.
export async function deleteEntry(root: string, ref: EntryRef) {
  await withEntry(root, ref, async (file, entry) => {
    if (entry.id) throw new RefusedError(`${entry.id} has an ID, so it is never deleted: drop, answer or retire it instead`);
    return { writes: [[ref.file, removeEntry(file, entry.index)]], result: undefined };
  });
}

// Set (or, with an empty value, remove) metadata fields.
export async function setMeta(root: string, ref: EntryRef, updates: Record<string, string>) {
  checkValues(ref.file, updates);
  await withEntry(root, ref, async (file, entry) => ({ writes: [[ref.file, spliceEntry(file, entry.index, stamp(entry, updates))]], result: undefined }));
}

// Change an entry's title or body; its metadata is kept.
export async function editEntry(root: string, ref: EntryRef, change: { title?: string; body?: string }) {
  if (change.title !== undefined) checkTitle(change.title);
  await withEntry(root, ref, async (file, entry) => ({ writes: [[ref.file, spliceEntry(file, entry.index, rewrite(entry, change))]], result: undefined }));
}

// Add `- YYYY-MM-DD: text` at the end of the body's `**Name:**` section, or
// start that section at the end of the body.
export function appendToSection(body: string, name: string, text: string, date = today()): string {
  const item = `- ${date}: ${text}`;
  const lines = body.split("\n");
  const label = (l: string) => /^\*\*([^*]+?):?\*\*:?/.exec(l)?.[1].trim();
  const at = lines.findIndex((l) => label(l)?.toLowerCase() === name.toLowerCase());
  if (at < 0) return `${body.trimEnd()}${body.trim() ? "\n\n" : ""}**${name}:**\n${item}`;
  let end = at + 1;
  while (end < lines.length && label(lines[end]) === undefined && !/^#/.test(lines[end])) end++;
  let last = end - 1;
  while (last > at && lines[last].trim() === "") last--;
  lines.splice(last + 1, 0, item);
  return lines.join("\n");
}

export async function appendLine(root: string, ref: EntryRef, section: string, text: string) {
  if (!/^[\w][\w -]*$/.test(section)) throw new RefusedError(`"${section}" is not a section name (words, like History)`);
  if (!text.trim() || /\n/.test(text)) throw new RefusedError("the line is one non-empty line");
  await withEntry(root, ref, async (file, entry) => ({
    writes: [[ref.file, spliceEntry(file, entry.index, rewrite(entry, { body: appendToSection(entry.body, section, text) }))]],
    result: undefined,
  }));
}

// Where each kind lives, the date it is stamped with, and the keys that lead its metadata line.
const KINDS: Record<Kind, { file: string; date: string; first: string[] }> = {
  T: { file: "todo.md", date: "added", first: ["status", "priority"] },
  Q: { file: "questions.md", date: "asked", first: [] },
  A: { file: "answers.md", date: "answered", first: [] },
  R: { file: "rules.md", date: "added", first: ["scope", "form", "status"] },
  K: { file: "resources.md", date: "added", first: ["link", "consult-when"] },
};

// Claim the next ID and append the whole entry to its file, in one locked
// step. With `stub`, no field is required (the caller fills them in later).
export async function newEntry(
  root: string,
  kind: Kind,
  title: string,
  { fields = {}, body = "", inbox = false, stub = false }: { fields?: Record<string, string>; body?: string; inbox?: boolean; stub?: boolean } = {},
): Promise<string> {
  checkTitle(title);
  const { file: rel, date, first } = KINDS[kind];
  const given: Record<string, string> = { ...fields };
  if (inbox) {
    if (kind !== "T") throw new RefusedError("only a todo can go to the inbox");
    given.status = "inbox";
  }
  if (kind === "R") given.status ??= "proposed";
  checkValues(rel, given);
  if (!stub) {
    const missing = requiredKeys(rel, given).filter((k) => k !== date && !given[k]);
    if (missing.length) throw new RefusedError(`a new ${kind} needs ${missing.map((k) => `--${k}=…`).join(" and ")}${kind === "T" ? " (or --inbox)" : ""}`);
  }
  const meta: Record<string, string> = {};
  for (const k of first) if (given[k]) meta[k] = given[k];
  meta[date] = given[date] || today();
  Object.assign(meta, given, { [date]: meta[date] });
  return withFiles(root, async (before) => {
    const id = nextId(before, kind);
    const file = before.files.find((f) => f.path === rel);
    if (!file?.text) throw new NotFoundError(`${DIR}/${rel} does not exist (run: remembrancer init)`);
    return { writes: [[rel, appendEntry(file.text, formatEntry({ id, title: title.trim(), meta, body }))]], result: id };
  });
}

// `next --claim`: a stub with the date (and a rule's status), for the caller to fill in.
export async function claimId(root: string, kind: Kind, title: string): Promise<string> {
  return newEntry(root, kind, title, { stub: true });
}

// Move an entry to the top of another file. The target is written first, so
// a crash in between leaves a duplicate (which lint reports), never a loss.
async function moveEntry(root: string, ref: EntryRef, target: (e: Entry) => string, header: string, change: (e: Entry) => string) {
  return withEntry(root, ref, async (file, entry) => {
    const to = target(entry);
    const existing = await readParsed(root, to);
    return {
      writes: [
        [to, prependEntry(existing.text || header, change(entry))],
        [ref.file, removeEntry(file, entry.index)],
      ],
      result: to,
    };
  });
}

// Move an entry into archive/<stem>-YYYY.md (year of its `done:` or `answered:` date).
export async function archiveEntry(root: string, ref: EntryRef) {
  if (ref.file.startsWith("archive/")) throw new NotFoundError(`${ref.id} is already archived`);
  const stem = ref.file.replace(/\.md$/, "");
  const year = (e: Entry) => (e.meta.done ?? e.meta.answered ?? today()).slice(0, 4);
  return moveEntry(root, ref, (e) => `archive/${stem}-${year(e)}.md`, `# Archive: ${stem}\n`, (e) => stamp(e));
}

// Move a todo to the top of done.md, stamping today's date; `outcome`
// replaces the body. A dropped todo goes the same way, marked `dropped: yes`
// with `Dropped: <reason>` above its body, so its number stays taken. An inbox
// todo leaves the inbox.
export async function completeEntry(root: string, ref: EntryRef, { dropped = false, outcome, reason }: { dropped?: boolean; outcome?: string; reason?: string } = {}) {
  if (ref.file !== "todo.md") throw new NotFoundError(`${ref.id} is not an open todo`);
  if (reason !== undefined && (!reason.trim() || /\n/.test(reason))) throw new RefusedError("a reason is one non-empty line");
  const updates = { done: today(), ...(dropped ? { dropped: "yes" } : {}) };
  return moveEntry(root, ref, () => "done.md", "# Done\n", (e) => {
    const u = e.meta.status === "inbox" ? { ...updates, status: "" } : updates;
    const body = outcome ?? (reason !== undefined ? `Dropped: ${reason.trim()}${e.body ? "\n\n" + e.body : ""}` : undefined);
    return rewrite(e, { updates: u, body });
  });
}

// Replace a whole file (the UI's scratch editor), checked against its file hash.
// Not linted: it changes no entry, and scratch is free-form (its `## ` headings
// have no IDs, which lint would report).
export async function replaceFile(root: string, rel: string, hash: string, text: string) {
  if (!isValidFile(rel)) throw new NotFoundError(`unknown file ${rel}`);
  await withLock(root, async () => {
    const file = await readParsed(root, rel);
    if (file.hash !== hash) throw new ConflictError(rel);
    await writeAtomic(join(root, DIR, rel), text);
  });
}

// ---- show ----

export interface Link {
  rel: string; // the meta key that holds the ID, or "mentions" for the body
  id: string;
  title: string | null; // null when no entry has that ID
}

export interface Shown {
  id: string;
  kind: Kind;
  file: string;
  index: number;
  title: string;
  meta: Record<string, string>;
  body: string;
  raw: string;
  hash: string;
  links?: { out: Link[]; in: Link[] };
  current?: string | null;
}

// An ID's title. An answered question has no entry left; it reads as the
// answer that closed it (An, or one that lists it in `closes:`).
function titleOf(project: Project, id: string): string | null {
  const e = project.byId.get(id)?.[0];
  if (e) return e.title;
  if (id[0] !== "Q") return null;
  const answer = project.byId.get("A" + id.slice(1))?.[0] ?? project.entries.find((a) => a.kind === "A" && mentions(a.meta.closes ?? "").includes(id));
  return answer ? answer.title : null;
}

// Where a chain of `superseded-by:` leads from `e`, or null when it leads
// nowhere. A cycle stops at the last entry before it repeats.
export function currentOf(project: Project, e: Entry): string | null {
  const seen = new Set([e.id]);
  let at = e;
  for (;;) {
    const next = mentions(at.meta["superseded-by"] ?? "")[0];
    const entry = next ? project.byId.get(next)?.[0] : undefined;
    if (!entry || seen.has(next)) break;
    seen.add(next);
    at = entry;
  }
  return at === e ? null : at.id;
}

function linksOf(project: Project, e: Entry): { out: Link[]; in: Link[] } {
  const out: Link[] = [];
  const inMeta = new Set<string>();
  for (const [key, value] of Object.entries(e.meta)) {
    for (const id of mentions(value)) {
      if (id === e.id) continue;
      out.push({ rel: key, id, title: titleOf(project, id) });
      inMeta.add(id);
    }
  }
  for (const id of mentions(e.body)) {
    if (id !== e.id && !inMeta.has(id)) out.push({ rel: "mentions", id, title: titleOf(project, id) });
  }
  const into: Link[] = [];
  for (const other of project.entries) {
    if (!other.id || other === e) continue;
    const keys = Object.entries(other.meta).filter(([, v]) => mentions(v).includes(e.id!)).map(([k]) => k);
    for (const rel of keys) into.push({ rel, id: other.id, title: other.title });
    if (!keys.length && mentions(other.body).includes(e.id!)) into.push({ rel: "mentions", id: other.id, title: other.title });
  }
  return { out, in: into };
}

export function show(project: Project, id: string, { links = false } = {}): Shown {
  if (!new RegExp(`^${ID_RE.source}$`).test(id.toUpperCase())) throw new NotFoundError(`"${id}" is not an ID (T, Q, A, R or K and three digits)`);
  const e = locate(project, id);
  const shown: Shown = {
    id: e.id!,
    kind: e.kind!,
    file: e.file,
    index: e.index,
    title: e.title,
    meta: e.meta,
    body: e.body,
    raw: e.raw,
    hash: e.hash,
  };
  if (links) {
    shown.links = linksOf(project, e);
    shown.current = currentOf(project, e);
  }
  return shown;
}

export function formatShown(s: Shown): string {
  const lines = [s.raw.trimEnd(), `hash: ${s.hash}`];
  if (s.links) {
    const line = (l: Link) => `  ${l.rel}: ${l.id} ${l.title ?? "(no entry)"}`;
    lines.push("links out:", ...(s.links.out.length ? s.links.out.map(line) : ["  none"]));
    lines.push("links in:", ...(s.links.in.length ? s.links.in.map(line) : ["  none"]));
    if (s.current) lines.push(`current: ${s.current}`);
  }
  return lines.join("\n");
}
