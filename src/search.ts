// Ranked search over whole entries: an in-memory SQLite FTS5 table built per
// call (nothing on disk to go stale), porter-stemmed, titles weighted 3, BM25
// order, then widened by the graph so an old decision leads to its current one.
import { Database } from "bun:sqlite";
import { type Link, type Shown, currentOf, linksOf } from "./commands";
import { type Entry, type Kind, mentions } from "./model";
import { RefusedError, type Project } from "./project";
import { tagsOf } from "./signals";

export interface SearchOptions {
  kind?: Kind;
  tag?: string;
  phase?: string;
  all?: boolean; // include archive/ and kb/
  k?: number;
  neighbours?: boolean;
}

export interface Hit {
  id: string;
  score: number; // BM25, higher is better
  via?: string; // pulled in by this hit: the end of its supersession chain, or what it closes
  entry: Shown;
  neighbours?: { out: Link[]; in: Link[] };
}

export const DEFAULT_K = 12;

// Column weights for bm25(): id and kind are unindexed, then title, tags, body.
const WEIGHTS = "0, 0, 3, 1, 1";

// Query text with FTS5 syntax (quotes, operators, prefixes, column filters)
// passes through as written. Plain words become an OR of quoted terms, so an
// entry needn't hold every word to rank, and "re-seed" is a phrase, not a
// column filter.
export function ftsQuery(q: string): string {
  if (/["*()^]|\b(AND|OR|NOT|NEAR)\b|\w:/.test(q)) return q;
  const words = q.split(/\s+/).filter(Boolean);
  return words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

const searchable = (e: Entry, all: boolean) =>
  !!e.id && e.file !== "scratch.md" && (all || !/^(archive|kb)\//.test(e.file));

export function search(project: Project, query: string, o: SearchOptions = {}): Hit[] {
  if (!query.trim()) throw new RefusedError("search for something");
  const db = new Database(":memory:");
  try {
    db.run("CREATE VIRTUAL TABLE e USING fts5(id UNINDEXED, kind UNINDEXED, title, tags, body, tokenize='porter unicode61')");
    const insert = db.prepare("INSERT INTO e VALUES (?, ?, ?, ?, ?)");
    const pool = new Map<string, Entry>();
    db.transaction(() => {
      for (const e of project.entries) {
        if (!searchable(e, !!o.all) || pool.has(e.id!)) continue;
        pool.set(e.id!, e);
        insert.run(e.id!, e.kind!, e.title, tagsOf(e).join(" "), e.body + "\n" + Object.values(e.meta).join(" "));
      }
    })();
    let rows: { id: string; s: number }[];
    try {
      rows = db.query(`SELECT id, bm25(e, ${WEIGHTS}) AS s FROM e WHERE e MATCH ? ORDER BY s`).all(ftsQuery(query)) as { id: string; s: number }[];
    } catch (err) {
      throw new RefusedError(`bad search syntax: ${(err as Error).message} (quote words with symbols in them)`);
    }

    const keep = (e: Entry) =>
      (!o.kind || e.kind === o.kind) &&
      (!o.tag || tagsOf(e).includes(o.tag.toLowerCase())) &&
      (!o.phase || (e.meta.phase ?? "").toLowerCase() === o.phase.toLowerCase());
    const direct = rows.map((r) => ({ e: pool.get(r.id)!, score: -r.s })).filter((h) => keep(h.e)).slice(0, o.k ?? DEFAULT_K);

    const hits: Hit[] = [];
    const seen = new Set<string>();
    const add = (e: Entry, score: number, via?: string) => {
      if (seen.has(e.id!)) return;
      seen.add(e.id!);
      const hit: Hit = { id: e.id!, score: Math.round(score * 1e6) / 1e6, entry: { id: e.id!, kind: e.kind!, file: e.file, index: e.index, title: e.title, meta: e.meta, body: e.body, raw: e.raw, hash: e.hash }, ...(via ? { via } : {}) };
      if (o.neighbours) hit.neighbours = linksOf(project, e);
      hits.push(hit);
    };
    for (const { e, score } of direct) {
      add(e, score);
      // Widen: where its supersession chain ends, and what it closes (when that is still an entry).
      const current = currentOf(project, e);
      if (current) add(project.byId.get(current)![0], score, e.id!);
      for (const q of mentions(e.meta.closes ?? "")) {
        const closed = project.byId.get(q)?.[0];
        if (closed) add(closed, score, e.id!);
      }
    }
    return hits;
  } finally {
    db.close();
  }
}

export function formatHits(hits: Hit[], { list = false } = {}): string {
  if (!hits.length) return "no matches";
  return hits
    .map((h) => {
      const head = `${h.id}  ${h.score.toFixed(2)}  ${h.entry.title}  (${h.entry.file})${h.via ? `  via ${h.via}` : ""}`;
      const near = h.neighbours
        ? [...h.neighbours.out.map((l) => `  out ${l.rel}: ${l.id} ${l.title ?? "(no entry)"}`), ...h.neighbours.in.map((l) => `  in  ${l.rel}: ${l.id} ${l.title ?? "(no entry)"}`)]
        : [];
      return list ? [head, ...near].join("\n") : [`== ${head}`, ...near, h.entry.raw.trimEnd(), `hash: ${h.entry.hash}`].join("\n");
    })
    .join(list ? "\n" : "\n\n");
}
