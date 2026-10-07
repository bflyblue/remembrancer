// The loop every example curator shares: read a packet on stdin, ask a model
// about each case (one small prompt per case), check the answer, retry once
// with the problems named, and print a gather proposals file on stdout.
// Progress and skipped cases go to stderr. Run from a remembrancer checkout.
import { mentions } from "../src/model";
import { validate } from "../src/proposals";
import actionSchema from "../schema/action.json";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

// Ask the model: the conversation so far, and the JSON schema its answer must meet.
export type Ask = (messages: Message[], schema: object) => Promise<string>;

export interface PacketCase {
  case: string;
  kind: string;
  evidence: string;
  allowed: string[];
  entries: { id: string; kind: string; title: string; meta: Record<string, string>; body: string; hash: string }[];
}

// The prompt for the packet's mode: gather.md (classify only) or insight.md.
export async function systemPrompt(mode = "gather"): Promise<string> {
  return Bun.file(new URL(mode === "insight" ? "./insight.md" : "./gather.md", import.meta.url)).text();
}

// action.json with its $refs replaced by their definitions: local servers'
// structured output handles inline schemas best.
function inline(node: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => inline(n, defs));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.$ref === "string" && o.$ref.startsWith("#/$defs/")) {
      const { $ref: _, ...rest } = o;
      return { ...(inline(defs[o.$ref.slice(8)], defs) as object), ...rest };
    }
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "$defs" && k !== "$schema" && k !== "$id").map(([k, v]) => [k, inline(v, defs)]));
  }
  return node;
}

// The schema for one case's answer: {actions: [...]}, each action one of the
// case's allowed kinds, its subject one of the case's IDs, and no "if".
export function caseSchema(c: PacketCase): object {
  const defs = actionSchema.$defs as Record<string, unknown>;
  const ids = { type: "string", enum: c.entries.map((e) => e.id) };
  const variants = (actionSchema.oneOf as Record<string, any>[])
    .filter((v) => c.allowed.includes(v.properties.action.const))
    .map((v) => {
      const s = inline(v, defs) as Record<string, any>;
      const props = { ...s.properties };
      delete props.if;
      delete props.case;
      for (const k of ["id", "from"]) if (props[k]) props[k] = ids;
      if (props.members) props.members = { type: "array", minItems: 2, items: ids };
      if (s.properties.action.const === "condense") props.from = { type: "array", minItems: 2, items: ids };
      return { ...s, properties: props };
    });
  return {
    type: "object",
    properties: { actions: { type: "array", items: { anyOf: variants } } },
    required: ["actions"],
    additionalProperties: false,
  };
}

// The JSON object in a reply, fenced or not.
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in the reply");
  return JSON.parse(body.slice(start, end + 1));
}

// The IDs an entry names anywhere: its title, metadata and body.
const names = (e: PacketCase["entries"][number]) => new Set(mentions([e.title, ...Object.values(e.meta), e.body].join("\n")));

// A link the model proposed that the records already hold, so that applying it
// would change nothing: a `refs` between entries that already name each other
// (the graph reads a reference from either end), or between members of a
// cluster proposed in the same answer (the cluster's tag connects them); an
// `amends`, `supersedes` or `closes` already in the metadata. Dropped, not
// retried: the model was right about the relation, only late.
function alreadyLinked(a: Record<string, unknown>, c: PacketCase, clusters: string[][]): string | null {
  const from = c.entries.find((e) => e.id === a.from);
  const to = String(a.to ?? "").toUpperCase();
  if (!from || !to) return null;
  const target = c.entries.find((e) => e.id === to);
  if (a.rel === "refs") {
    if (names(from).has(to)) return `${from.id} already names ${to}`;
    if (target && names(target).has(from.id)) return `${to} already names ${from.id}`;
    if (clusters.some((m) => m.includes(from.id) && m.includes(to))) return `${from.id} and ${to} are in one cluster this answer proposes`;
    return null;
  }
  return mentions(from.meta[String(a.rel)] ?? "").includes(to) ? `${from.id} already ${a.rel} ${to}` : null;
}

// A cluster of exactly two entries that already name each other: its tag would
// connect what the records already connect.
function alreadyPaired(a: Record<string, unknown>, c: PacketCase): string | null {
  const members = Array.isArray(a.members) ? (a.members as string[]).map((m) => String(m).toUpperCase()) : [];
  if (new Set(members).size !== 2) return null;
  const [x, y] = members.map((id) => c.entries.find((e) => e.id === id));
  if (!x || !y) return null;
  if (names(x).has(y.id)) return `${x.id} already names ${y.id}`;
  if (names(y).has(x.id)) return `${y.id} already names ${x.id}`;
  return null;
}

// What the rels mean by kind: closes is an answer settling a question; amends
// and supersedes stand between two answers or two rules. `apply` refuses the
// rest, so the model is told now and can answer again.
function linkKindProblem(a: Record<string, unknown>, c: PacketCase): string | null {
  const from = c.entries.find((e) => e.id === a.from);
  const to = String(a.to ?? "").toUpperCase();
  if (!from || !to) return null;
  const toKind = to[0]; // an ID's letter is its kind, in the case or not
  if (a.rel === "closes") return from.kind === "A" && toKind === "Q" ? null : "closes links an answer (A) to a question (Q)";
  if (a.rel === "amends" || a.rel === "supersedes") {
    return ["A", "R"].includes(from.kind) && toKind === from.kind ? null : `${a.rel} links an answer to an answer or a rule to a rule`;
  }
  return null;
}

// The answer's actions, completed (if hashes, the case name), or its problems;
// `dropped` names the links left out because the records already hold them.
export function checkAnswer(answer: unknown, c: PacketCase, mode = "gather"): { actions: Record<string, unknown>[]; problems: string[]; dropped: string[] } {
  const actions = (answer as { actions?: unknown })?.actions;
  if (!Array.isArray(actions)) return { actions: [], problems: ['the answer must be {"actions": [...]}'], dropped: [] };
  const hashes = new Map(c.entries.map((e) => [e.id, e.hash]));
  const all = actions.map((a) => {
    const x = { ...(a as Record<string, unknown>) };
    delete x.if;
    const subject = (x.id ?? (typeof x.from === "string" ? x.from : undefined)) as string | undefined;
    if (subject && hashes.has(subject)) x.if = hashes.get(subject);
    if (x.action === "cluster" || x.action === "condense") x.case = c.case;
    return x;
  });
  const clusters = all.filter((a) => a.action === "cluster" && Array.isArray(a.members)).map((a) => (a.members as string[]).map((m) => String(m).toUpperCase()));
  const dropped: string[] = [];
  const done = all.filter((a) => {
    const why = a.action === "link" ? alreadyLinked(a, c, clusters) : a.action === "cluster" ? alreadyPaired(a, c) : null;
    if (why) dropped.push(`${a.action} ${a.action === "link" ? `${a.from} ${a.rel} ${a.to}` : (a.members as string[]).join(", ")}: ${why}`);
    return !why;
  });
  if (!done.length) return { actions: [], problems: [], dropped };
  const problems = validate({ mode, made: "2000-01-01", by: "check", actions: done });
  done.forEach((a, i) => {
    if (!c.allowed.includes(a.action as string)) problems.push(`action ${i + 1}: ${a.action} is not allowed in this case (allowed: ${c.allowed.join(", ")})`);
    for (const id of [a.id, ...(Array.isArray(a.from) ? a.from : [a.from]), ...((a.members as string[]) ?? [])]) {
      if (typeof id === "string" && !hashes.has(id)) problems.push(`action ${i + 1}: ${id} is not one of this case's entries`);
    }
    const kind = a.action === "link" ? linkKindProblem(a, c) : null;
    if (kind) problems.push(`action ${i + 1}: ${kind}`);
  });
  return { actions: done, problems, dropped };
}

export function caseMessage(c: PacketCase): string {
  return JSON.stringify({ case: c.case, kind: c.kind, evidence: c.evidence, allowed: c.allowed, entries: c.entries.map(({ hash: _, ...e }) => e) }, null, 1);
}

export async function runCurator(ask: Ask, by: string) {
  const packet = JSON.parse(await Bun.stdin.text()) as { packet: string; mode: string; cases: PacketCase[] };
  const system = await systemPrompt(packet.mode);
  const actions: Record<string, unknown>[] = [];
  for (const [n, c] of packet.cases.entries()) {
    const messages: Message[] = [{ role: "system", content: system }, { role: "user", content: caseMessage(c) }];
    let problems: string[] = [];
    let dropped: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let reply = "";
      try {
        reply = await ask(messages, caseSchema(c));
        const checked = checkAnswer(extractJson(reply), c, packet.mode);
        problems = checked.problems;
        dropped = checked.dropped;
        if (!problems.length) {
          actions.push(...checked.actions);
          break;
        }
      } catch (err) {
        problems = [(err as Error).message];
      }
      messages.push({ role: "assistant", content: reply }, { role: "user", content: `That answer had problems:\n- ${problems.join("\n- ")}\nAnswer again with the JSON object only.` });
    }
    const left = dropped.length ? `; already in the records, left out: ${dropped.join("; ")}` : "";
    console.error(`${c.case} (${n + 1}/${packet.cases.length}): ${problems.length ? `skipped: ${problems.join("; ")}` : "ok"}${left}`);
  }
  const made = new Date().toISOString().slice(0, 10);
  console.log(JSON.stringify({ mode: packet.mode, packet: packet.packet, made, by, actions }, null, 2));
}
