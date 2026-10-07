// `curate --mode gather`: a packet of small, independent cases for a cheap
// model (or the calling agent) to work through one at a time. Code finds the
// candidates; the curator only classifies them (cluster, retag, link, flag,
// suggest archive). Each case is self-contained: its entries' full text, the
// evidence for grouping them, and the actions allowed. Every entry is in at
// most one case, and a case stays small enough for a small context.
import { attention } from "./analyse";
import { drift } from "./anchors";
import { type Entry, hashText, mentions, today } from "./model";
import { type Project, RefusedError } from "./project";
import { type Proposals, label, parseProposals } from "./proposals";
import { Index } from "./search";
import { effectiveDate, stale, tagsOf } from "./signals";

export const MAX_MEMBERS = 12; // entries in one case
export const MAX_CASE_BODY = 6000; // characters of body text in one case (a small model's context)

// How alike two titles must be to suggest a group: the other entry's BM25
// score for this entry's title, as a share of this entry's own. A heuristic,
// relative so it needs no tuning to a corpus; edges below it are dropped.
export const SIMILAR_SHARE = 0.5;

export type CaseKind = "stale" | "similar" | "inbox" | "drift";

// The actions each kind of case invites; all are gather actions.
export const CASE_ACTIONS: Record<CaseKind, string[]> = {
  similar: ["cluster", "link", "retag", "flag", "archive"],
  stale: ["archive", "link", "retag", "flag"],
  inbox: ["retag", "link", "flag", "archive"],
  drift: ["flag", "link", "retag"],
};

export interface PacketEntry {
  id: string;
  kind: string;
  file: string;
  title: string;
  meta: Record<string, string>;
  body: string;
  hash: string; // copy into an action's "if"
  truncated?: boolean; // the body was cut to fit the case
}

export interface Case {
  case: string;
  kind: CaseKind;
  evidence: string;
  allowed: string[];
  entries: PacketEntry[];
}

export interface Packet {
  packet: string; // the hash of the cases: proposals answering it carry it
  mode: "gather";
  made: string;
  owner: string | null;
  scope: Scope;
  cases: Case[];
}

export type Scope = "active" | "archive" | "all";

const inScope = (e: Entry, scope: Scope) => {
  if (!e.id || e.file === "scratch.md") return false;
  const archived = /^(archive|kb)\//.test(e.file);
  return scope === "all" || (scope === "archive") === archived;
};

function packetEntry(e: Entry): PacketEntry {
  const truncated = e.body.length > MAX_CASE_BODY;
  return {
    id: e.id!,
    kind: e.kind!,
    file: e.file,
    title: e.title,
    meta: e.meta,
    body: truncated ? e.body.slice(0, MAX_CASE_BODY) + "\n…[truncated]" : e.body,
    hash: e.hash,
    ...(truncated ? { truncated: true } : {}),
  };
}

const bodySize = (e: Entry) => Math.min(e.body.length, MAX_CASE_BODY);

// Consecutive entries in cases of at most MAX_MEMBERS and MAX_CASE_BODY.
function chunk(entries: Entry[]): Entry[][] {
  const out: Entry[][] = [];
  let cur: Entry[] = [];
  let size = 0;
  for (const e of entries) {
    if (cur.length && (cur.length >= MAX_MEMBERS || size + bodySize(e) > MAX_CASE_BODY)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += bodySize(e);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Groups of alike entries: explicit edges first (a tag or a reference shared
// by a small group), then titles that find each other in the search index,
// joined strongest first while a group stays within the case limits.
export function similarGroups(pool: Entry[]): { members: Entry[]; reasons: string[] }[] {
  const byId = new Map(pool.map((e) => [e.id!, e]));
  const edges: { a: string; b: string; weight: number; reason: string }[] = [];
  const groupEdges = (groups: Map<string, string[]>, reason: (k: string) => string) => {
    for (const [k, ids] of groups) {
      if (ids.length < 2 || ids.length > MAX_MEMBERS) continue; // a tag on half the project groups nothing
      for (let i = 1; i < ids.length; i++) edges.push({ a: ids[0], b: ids[i], weight: 2, reason: reason(k) });
    }
  };
  const byTag = new Map<string, string[]>();
  const byRef = new Map<string, string[]>();
  for (const e of pool) {
    for (const t of tagsOf(e)) byTag.set(t, [...(byTag.get(t) ?? []), e.id!]);
    for (const r of mentions(e.meta.refs ?? "")) byRef.set(r, [...(byRef.get(r) ?? []), e.id!]);
  }
  groupEdges(byTag, (t) => `shared tag ${t}`);
  groupEdges(byRef, (r) => `both refer to ${r}`);

  const index = new Index(pool);
  try {
    for (const e of pool) {
      const ranked = index.rankWords(e.title);
      const self = ranked.find((r) => r.id === e.id)?.score ?? ranked[0]?.score ?? 0;
      for (const r of ranked) {
        if (r.id === e.id || self <= 0 || r.score < SIMILAR_SHARE * self) continue;
        edges.push({ a: e.id!, b: r.id, weight: r.score / self, reason: `titles alike (${[e.id, r.id].sort().join(", ")})` });
      }
    }
  } finally {
    index.close();
  }

  // Kruskal's join with the case limits as a cap on each group's size.
  const parent = new Map(pool.map((e) => [e.id!, e.id!]));
  const members = new Map(pool.map((e) => [e.id!, [e.id!]]));
  const size = new Map(pool.map((e) => [e.id!, bodySize(e)]));
  const reasons = new Map<string, Set<string>>(pool.map((e) => [e.id!, new Set<string>()]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const { a, b, reason } of edges.sort((x, y) => y.weight - x.weight)) {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) {
      reasons.get(ra)!.add(reason);
      continue;
    }
    if (members.get(ra)!.length + members.get(rb)!.length > MAX_MEMBERS || size.get(ra)! + size.get(rb)! > MAX_CASE_BODY) continue;
    parent.set(rb, ra);
    members.set(ra, [...members.get(ra)!, ...members.get(rb)!]);
    size.set(ra, size.get(ra)! + size.get(rb)!);
    reasons.set(ra, new Set([...reasons.get(ra)!, ...reasons.get(rb)!, reason]));
  }
  return [...members]
    .filter(([root, m]) => find(root) === root && m.length > 1)
    .map(([root, m]) => ({ members: m.map((id) => byId.get(id)!), reasons: [...reasons.get(root)!] }));
}

// Answers whose `revisit-if` words match a newer done or answered entry: the
// condition may have come true. The newer entry must score at least
// SIMILAR_SHARE of the answer's own score for its condition.
function revisitHints(project: Project): Map<string, string> {
  const out = new Map<string, string>();
  const answers = project.entries.filter((e) => e.kind === "A" && e.file === "answers.md" && e.meta["revisit-if"] && !e.meta["superseded-by"]);
  if (!answers.length) return out;
  const later = project.entries.filter((e) => e.file === "done.md" || e.file === "answers.md");
  const index = new Index(later);
  try {
    for (const a of answers) {
      const since = effectiveDate(a) ?? "";
      const ranked = index.rankWords(a.meta["revisit-if"]);
      const self = ranked.find((r) => r.id === a.id)?.score ?? 0;
      const hit = ranked.find((r) => r.id !== a.id && (effectiveDate(index.pool.get(r.id)!) ?? "") > since && self > 0 && r.score >= SIMILAR_SHARE * self);
      if (hit) out.set(a.id!, `revisit-if "${a.meta["revisit-if"]}" may now hold: see ${hit.id}, newer`);
    }
  } finally {
    index.close();
  }
  return out;
}

export function buildPacket(project: Project, { scope = "active" as Scope, now = new Date() } = {}): Packet {
  const pool = project.entries.filter((e) => inScope(e, scope));
  const poolIds = new Set(pool.map((e) => e.id!));
  const used = new Set<string>();
  const cases: Omit<Case, "case">[] = [];
  const add = (kind: CaseKind, entries: Entry[], evidence: (group: Entry[]) => string) => {
    for (const group of chunk(entries.filter((e) => poolIds.has(e.id!) && !used.has(e.id!)))) {
      for (const e of group) used.add(e.id!);
      cases.push({ kind, evidence: evidence(group), allowed: CASE_ACTIONS[kind], entries: group.map(packetEntry) });
    }
  };
  const byId = (id: string) => project.byId.get(id)?.[0];

  // Drift: references gone stale, rules unreviewed, answers whose condition may hold.
  const reasons = new Map<string, string[]>();
  const note = (id: string, why: string) => reasons.set(id, [...(reasons.get(id) ?? []), why]);
  for (const d of drift(project)) note(d.entry.id!, d.message);
  for (const a of attention(project, now)) if (a.kind === "unreviewed-rule" && a.id) note(a.id, a.message);
  for (const [id, why] of revisitHints(project)) note(id, why);
  add("drift", [...reasons.keys()].map(byId).filter((e): e is Entry => !!e), (g) => g.map((e) => `${e.id}: ${reasons.get(e.id!)!.join("; ")}`).join(" | "));

  // The inbox: quick captures waiting to be triaged.
  add("inbox", pool.filter((e) => e.file === "todo.md" && e.meta.status === "inbox"), () => "captured with status: inbox, not yet triaged");

  // Alike entries, then whatever is stale and in no group.
  for (const g of similarGroups(pool.filter((e) => !used.has(e.id!)))) {
    add("similar", g.members, () => g.reasons.slice(0, 6).join("; "));
  }
  const staleList = stale(project, { now });
  const ages = new Map(staleList.map((s) => [s.id, s.age]));
  add("stale", staleList.map((s) => byId(s.id)).filter((e): e is Entry => !!e), (g) =>
    g.map((e) => `${e.id}: unchanged ${ages.get(e.id!) ?? "?"} days, cited by nothing live`).join(" | "));

  const named = cases.map((c, i) => ({ case: `c${i + 1}`, ...c }));
  return { packet: hashText(JSON.stringify(named)), mode: "gather", made: today(), owner: project.config.owner ?? null, scope, cases: named };
}

// A rough size, for choosing a model: about four characters to a token.
export function packetSize(p: Packet): { cases: number; byKind: Record<string, number>; tokens: number; maxCaseTokens: number; meanCaseTokens: number } {
  const tokens = p.cases.map((c) => Math.ceil(JSON.stringify(c).length / 4));
  const byKind: Record<string, number> = {};
  for (const c of p.cases) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  const total = tokens.reduce((a, b) => a + b, 0);
  return { cases: p.cases.length, byKind, tokens: total, maxCaseTokens: Math.max(0, ...tokens), meanCaseTokens: tokens.length ? Math.round(total / tokens.length) : 0 };
}

// The IDs an action names that must be in the packet (its subject, never a link's target).
export function subjects(a: { id?: string; from?: string; members?: string[] }): string[] {
  return [a.id, a.from, ...(a.members ?? [])].filter((x): x is string => !!x).map((x) => x.toUpperCase());
}

// Run a curator command: the packet on its stdin, proposals on its stdout.
// It runs outside the lock (it may take minutes); its stderr passes through.
// `proposals` is null when it proposed nothing.
export async function callCurator(command: string, packet: Packet, { quiet = false } = {}): Promise<{ proposals: Proposals | null; seconds: number }> {
  const start = performance.now();
  const proc = Bun.spawn(["sh", "-c", command], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: quiet ? "ignore" : "inherit" });
  proc.stdin.write(JSON.stringify(packet));
  proc.stdin.end();
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const seconds = Math.round((performance.now() - start) / 100) / 10;
  if (code !== 0) throw new RefusedError(`the curator "${command}" exited ${code}`);
  let raw: { actions?: unknown[] } = {};
  try {
    raw = JSON.parse(text);
  } catch {}
  if (Array.isArray(raw.actions) && raw.actions.length === 0) return { proposals: null, seconds };
  return { proposals: parseProposals(text, "the curator's output"), seconds };
}

// What makes proposals no answer to this packet: another mode or packet, or
// an action on an entry outside it.
export function packetProblems(p: Proposals, packet: Packet): string[] {
  const known = new Set(packet.cases.flatMap((c) => c.entries.map((e) => e.id)));
  return [
    ...(p.mode !== packet.mode ? [`the curator's mode is ${p.mode}, not ${packet.mode}`] : []),
    ...(p.packet !== packet.packet ? [`the proposals answer packet ${p.packet}, not ${packet.packet}`] : []),
    ...p.actions.flatMap((a, i) => subjects(a).filter((id) => !known.has(id)).map((id) => `${label(a, i)}: ${id} is not in the packet`)),
  ];
}
