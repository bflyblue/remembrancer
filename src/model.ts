// File format: each entry is a `## <ID> · <title>` heading, an optional
// `key: value · key: value` metadata line, then a free markdown body.
// Parsing never rewrites text: every entry keeps its exact byte span so
// edits can splice one entry without touching the rest of the file.

export type Kind = "T" | "Q" | "A" | "R" | "K";

export interface Entry {
  id: string | null; // null when the heading does not parse as an ID
  kind: Kind | null;
  num: number;
  title: string;
  meta: Record<string, string>;
  body: string;
  raw: string;
  start: number;
  end: number;
  index: number; // position within its file
  file: string; // path relative to the .remembrancer dir
}

export interface ParsedFile {
  path: string;
  text: string;
  hash: string;
  preamble: string;
  entries: Entry[];
}

export const ID_RE = /\b([TQARK])(\d{3,})\b/g;
const HEADING_RE = /^## +([TQARK])(\d{3,})\s*(?:·|—|-|:)\s*(.*?)\s*$/;
const META_KEY_RE = /^([a-z][a-z-]*):\s*(.*)$/;
const META_SEP = " · ";

export function hashText(text: string): string {
  return Bun.hash(text).toString(16);
}

export function parseFile(path: string, text: string): ParsedFile {
  const starts: number[] = [];
  let inFence = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && line.startsWith("## ")) starts.push(offset);
    offset += line.length + 1;
  }
  const entries = starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : text.length;
    return parseEntry(path, text.slice(start, end), start, end, index);
  });
  return {
    path,
    text,
    hash: hashText(text),
    preamble: text.slice(0, starts[0] ?? text.length),
    entries,
  };
}

function parseEntry(file: string, raw: string, start: number, end: number, index: number): Entry {
  const lines = raw.replace(/\n+$/, "").split("\n");
  const heading = lines[0];
  const m = HEADING_RE.exec(heading);
  let rest = lines.slice(1);
  while (rest.length && rest[0].trim() === "") rest = rest.slice(1);
  let meta: Record<string, string> = {};
  if (rest.length && isMetaLine(rest[0])) {
    meta = parseMeta(rest[0]);
    rest = rest.slice(1);
  }
  return {
    id: m ? m[1] + m[2] : null,
    kind: m ? (m[1] as Kind) : null,
    num: m ? parseInt(m[2], 10) : 0,
    title: m ? m[3] : heading.replace(/^## +/, ""),
    meta,
    body: rest.join("\n").trim(),
    raw,
    start,
    end,
    index,
    file,
  };
}

function isMetaLine(line: string): boolean {
  return line.split(META_SEP).every((part) => META_KEY_RE.test(part.trim()));
}

export function parseMeta(line: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const part of line.split(META_SEP)) {
    const m = META_KEY_RE.exec(part.trim());
    if (m) meta[m[1]] = m[2].trim();
  }
  return meta;
}

export function formatMeta(meta: Record<string, string>): string {
  return Object.entries(meta)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join(META_SEP);
}

export function formatEntry(e: { id: string; title: string; meta: Record<string, string>; body: string }): string {
  const meta = formatMeta(e.meta);
  return [`## ${e.id} · ${e.title}`, meta, "", e.body.trim()]
    .filter((l, i) => i !== 1 || l !== "")
    .join("\n")
    .trimEnd() + "\n";
}

// Normalise an entry's text so entries stay separated by one blank line.
function normaliseRaw(raw: string, isLast: boolean): string {
  const trimmed = raw.replace(/\s+$/, "");
  if (trimmed === "") return "";
  return trimmed + (isLast ? "\n" : "\n\n");
}

export function spliceEntry(file: ParsedFile, index: number, newRaw: string): string {
  const e = file.entries[index];
  const isLast = index === file.entries.length - 1;
  let before = file.text.slice(0, e.start);
  const after = file.text.slice(e.end);
  const replacement = normaliseRaw(newRaw, isLast);
  if (replacement === "" && isLast) before = before.replace(/\n{2,}$/, "\n");
  return before + replacement + after;
}

export function removeEntry(file: ParsedFile, index: number): string {
  return spliceEntry(file, index, "");
}

// Insert an entry directly after the preamble (newest first).
export function prependEntry(text: string, raw: string): string {
  const parsed = parseFile("", text);
  const cut = parsed.preamble.length;
  let preamble = text.slice(0, cut).replace(/\s+$/, "");
  preamble = preamble === "" ? "" : preamble + "\n\n";
  const rest = text.slice(cut);
  return preamble + raw.replace(/\s+$/, "") + (rest.trim() ? "\n\n" + rest : "\n");
}

export function appendEntry(text: string, raw: string): string {
  const base = text.replace(/\s+$/, "");
  return (base ? base + "\n\n" : "") + raw.replace(/\s+$/, "") + "\n";
}

// Rewrite (or add) the metadata line of an entry, keeping heading and body.
export function withMeta(e: Entry, updates: Record<string, string>): string {
  const meta = { ...e.meta, ...updates };
  const lines = e.raw.replace(/\n+$/, "").split("\n");
  const heading = lines[0];
  let rest = lines.slice(1);
  while (rest.length && rest[0].trim() === "") rest = rest.slice(1);
  if (rest.length && isMetaLine(rest[0])) rest = rest.slice(1);
  else if (rest.length) rest = ["", ...rest];
  return [heading, formatMeta(meta), ...rest].join("\n") + "\n";
}

export function mentions(text: string): string[] {
  return [...new Set([...text.matchAll(ID_RE)].map((m) => m[1] + m[2]))];
}

export function padId(kind: Kind, num: number): string {
  return kind + String(num).padStart(3, "0");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysSince(date: string | undefined, now = new Date()): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const then = new Date(date + "T00:00:00Z").getTime();
  return Math.floor((now.getTime() - then) / 86_400_000);
}
