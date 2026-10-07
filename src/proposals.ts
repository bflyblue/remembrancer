// `apply`: a list of dispositions (from an agent, a person or a curator run)
// applied to the project in one locked step, or refused whole. The format is
// published as JSON Schema in schema/proposals.json and schema/action.json;
// validate() below enforces the same rules (a test keeps the two in step).
import { appendFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Problem } from "./analyse";
import {
  Changes,
  DONE_HEADER,
  addTo,
  appendToSection,
  archiveTarget,
  checkValues,
  finishedRaw,
  lintAdded,
  locate,
  relate,
  rewrite,
  stamp,
  withFiles,
} from "./commands";
import { type Entry, type Kind, formatEntry, mentions, padId, parseFile, today } from "./model";
import { ConflictError, DIR, NotFoundError, type Project, RefusedError, buildProject, kbOn, loadProject, usedNumbers } from "./project";

export const ACTIONS = ["keep", "archive", "drop", "set", "retag", "link", "flag", "cluster", "condense"] as const;
export type ActionName = (typeof ACTIONS)[number];

// Actions named by the plan but not defined yet, and where they arrive.
const LATER: Record<string, string> = {};

// Who may do what. `manual` (an agent or a person) and `insight` (a strong
// model's weekly run) take every action; `gather` (a cheap model's daily run)
// only classifies: its `archive` becomes `suggest: archive`, never a move,
// and it may not `condense`, the one action that writes new text.
export const MODES = {
  manual: [...ACTIONS],
  gather: ["retag", "link", "flag", "archive", "cluster"] as ActionName[],
  insight: [...ACTIONS],
} satisfies Record<string, readonly ActionName[]>;
export type Mode = keyof typeof MODES;

export const LINK_RELS = ["refs", "amends", "supersedes", "closes"] as const;

export interface Action {
  action: ActionName;
  id?: string;
  from?: string | string[]; // link: the entry linked from; condense: the entries condensed
  to?: string;
  rel?: (typeof LINK_RELS)[number];
  if?: string;
  why: string;
  importance?: "high" | "normal" | "low";
  reason?: string;
  fields?: Record<string, string>;
  unset?: string[];
  add?: string[];
  remove?: string[];
  note?: string;
  case?: string; // cluster: the packet case it answers
  label?: string; // cluster: a few words naming what the members share
  members?: string[]; // cluster: the entries grouped
  into?: { kind: Kind; title: string; fields?: Record<string, string>; body: string }; // condense: the theme entry
  dest?: "active" | "archive"; // condense: where the theme entry goes
}

// The entries an action is about (never a link's target), upper-cased.
export function actionIds(a: Partial<Action>): string[] {
  const from = Array.isArray(a.from) ? a.from : a.from ? [a.from] : [];
  return [...new Set([a.id, ...from, ...(a.members ?? [])].filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase()))];
}

export interface Proposals {
  mode: Mode;
  packet?: string | null;
  made: string;
  by: string;
  actions: Action[];
}

// Each action's own fields beyond `action`, `if` and `why`: required, then optional.
const FIELDS: Record<ActionName, [required: string[], optional: string[]]> = {
  keep: [["id"], []],
  archive: [["id"], ["importance"]],
  drop: [["id", "reason"], []],
  set: [["id"], ["fields", "unset"]],
  retag: [["id"], ["add", "remove"]],
  link: [["from", "rel", "to"], []],
  flag: [["id", "note"], []],
  cluster: [["label", "members"], ["case"]],
  condense: [["from", "into"], ["case", "dest", "importance"]],
};

const ID = /^[TQARK]\d{3,}$/;
const TAG = /^[a-z0-9-]+$/;
const oneLine = (v: unknown) => typeof v === "string" && v.trim() !== "" && !v.includes("\n");
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

export const label = (a: Partial<Action>, i: number) => `action ${i + 1} (${a.action ?? "?"} ${actionIds(a).join(",") || "?"})`;

// A cluster's tag: "crossing re-seeds" → c-crossing-re-seeds.
export function clusterTag(label: string): string {
  const slug = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug ? `c-${slug}` : "";
}

// The file's shape, and each action's against its mode. Returns the problems.
export function validate(data: unknown): string[] {
  const out: string[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) return ["the file is not a JSON object"];
  const p = data as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!["mode", "packet", "made", "by", "actions"].includes(k)) out.push(`unknown key "${k}"`);
  const mode = p.mode as Mode;
  if (!Object.hasOwn(MODES, mode as string)) out.push(`mode must be one of ${Object.keys(MODES).join(", ")}`);
  if (p.packet !== undefined && p.packet !== null && typeof p.packet !== "string") out.push("packet must be a string or null");
  if (typeof p.made !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.made)) out.push("made must be a date, YYYY-MM-DD");
  if (!oneLine(p.by)) out.push("by must name who made the file");
  if (!Array.isArray(p.actions) || !p.actions.length) return [...out, "actions must be a non-empty list"];
  p.actions.forEach((raw, i) => {
    const a = raw as Record<string, unknown>;
    const name = a?.action as string;
    const at = (m: string) => out.push(`${label(a ?? {}, i)}: ${m}`);
    if (typeof a !== "object" || a === null) return at("not an object");
    if (LATER[name]) return at(`"${name}" is not defined yet (it arrives with ${LATER[name]})`);
    if (!(ACTIONS as readonly string[]).includes(name)) return at(`unknown action "${name}" (one of ${ACTIONS.join(", ")})`);
    if (Object.hasOwn(MODES, mode) && !(MODES[mode] as readonly string[]).includes(name)) return at(`a ${mode} run may not ${name} (allowed: ${MODES[mode].join(", ")})`);
    const [required, optional] = FIELDS[name as ActionName];
    for (const k of Object.keys(a)) if (![...required, ...optional, "action", "if", "why"].includes(k)) at(`unknown field "${k}"`);
    for (const k of required) if (a[k] === undefined) at(`needs "${k}"`);
    if (!oneLine(a.why)) at(`needs "why", one line`);
    if (a.if !== undefined && typeof a.if !== "string") at(`"if" must be the entry's hash, as show prints it`);
    for (const k of ["id", "from", "to"]) if (a[k] !== undefined && !(name === "condense" && k === "from") && !ID.test(String(a[k]))) at(`${k} "${a[k]}" is not an ID`);
    if (a.importance !== undefined && !["high", "normal", "low"].includes(a.importance as string)) at(`importance must be high, normal or low`);
    if (a.rel !== undefined && !(LINK_RELS as readonly string[]).includes(a.rel as string)) at(`rel must be one of ${LINK_RELS.join(", ")}`);
    for (const k of ["reason", "note"]) if (a[k] !== undefined && !oneLine(a[k])) at(`${k} must be one line`);
    if (a.fields !== undefined && (typeof a.fields !== "object" || a.fields === null || !Object.values(a.fields).every((v) => typeof v === "string"))) at(`fields must map names to strings`);
    for (const k of ["unset", "add", "remove"]) if (a[k] !== undefined && !strings(a[k])) at(`${k} must be a list of strings`);
    for (const k of ["add", "remove"]) if (strings(a[k]) && !(a[k] as string[]).every((t) => TAG.test(t))) at(`${k}: tags are words of a-z, 0-9 and -`);
    if (name === "set" && a.fields === undefined && a.unset === undefined) at(`needs "fields" or "unset"`);
    if (name === "retag" && a.add === undefined && a.remove === undefined) at(`needs "add" or "remove"`);
    if (name === "cluster") {
      if (!oneLine(a.label) || !clusterTag(String(a.label))) at(`label must be a few words, one line`);
      if (!strings(a.members) || (a.members as string[]).length < 2) at(`members must list two or more IDs`);
      else for (const m of a.members as string[]) if (!ID.test(m)) at(`member "${m}" is not an ID`);
      if (a.case !== undefined && typeof a.case !== "string") at(`case must be the packet case's name`);
    }
    if (name === "condense") {
      if (!strings(a.from) || (a.from as string[]).length < 2) at(`from must list two or more IDs`);
      else for (const m of a.from as string[]) if (!ID.test(m)) at(`from "${m}" is not an ID`);
      const into = a.into as Record<string, unknown> | undefined;
      if (typeof into !== "object" || into === null) at(`into must be the theme entry: {kind, title, body, fields?}`);
      else {
        for (const k of Object.keys(into)) if (!["kind", "title", "fields", "body"].includes(k)) at(`into: unknown field "${k}"`);
        if (!["T", "Q", "A", "R", "K"].includes(into.kind as string)) at(`into.kind must be T, Q, A, R or K`);
        if (!oneLine(into.title)) at(`into.title must be one line`);
        if (typeof into.body !== "string" || !into.body.trim()) at(`into.body must hold the condensed text`);
        if (into.fields !== undefined && (typeof into.fields !== "object" || into.fields === null || !Object.values(into.fields).every((v) => typeof v === "string"))) at(`into.fields must map names to strings`);
      }
      if (a.dest !== undefined && !["active", "archive"].includes(a.dest as string)) at(`dest must be active or archive`);
      if (a.case !== undefined && typeof a.case !== "string") at(`case must be the packet case's name`);
    }
  });
  return out;
}

export class ProposalsRefusedError extends RefusedError {
  constructor(public problems: string[], what = "refused") {
    super(`${what}: ${problems.length} problem${problems.length === 1 ? "" : "s"}, nothing applied:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
}

export interface Applied {
  index: number;
  action: ActionName;
  id: string;
  result: string; // what happened, in a few words
}

// Every action checked against the project as loaded, and its change made in
// memory. Any problem refuses the whole file.
function plan(before: Project, p: Proposals): { changes: Changes; applied: Applied[] } {
  const changes = new Changes(before);
  const kb = kbOn(before.root);
  const owner = before.config.owner;
  const problems: string[] = [];
  const gone = new Map<string, number>(); // ID → the action that moved or removed it
  const applied: Applied[] = [];
  const claimed = new Set<string>(); // IDs new theme entries took in this file

  p.actions.forEach((a, i) => {
    const id = actionIds(a)[0];
    try {
      for (const ref of [id, ...(a.to ? [a.to.toUpperCase()] : [])]) {
        if (gone.has(ref)) throw new RefusedError(`${ref} was already moved by action ${gone.get(ref)! + 1}`);
      }
      const e = locate(before, id);
      if (a.if !== undefined && e.hash !== a.if) throw new RefusedError(`stale if: ${id} has changed since the proposals were made (its hash is now ${e.hash})`);
      let result = "";
      switch (a.action) {
        case "keep":
          changes.change(id, (x) => stamp(x));
          result = "kept (touched)";
          break;
        case "archive": {
          const importance = a.importance ? { importance: a.importance } : {};
          if (p.mode === "gather") {
            changes.change(id, (x) => stamp(x, { suggest: "archive", ...importance }));
            result = "suggest: archive";
            break;
          }
          const { to, header } = archiveTarget(changes.get(id), kb);
          changes.move(id, to, header, (x) => stamp(x, importance));
          gone.set(id, i);
          result = `→ ${to}`;
          break;
        }
        case "drop":
          if (e.file !== "todo.md") throw new RefusedError(`${id} is not an open todo`);
          changes.move(id, "done.md", DONE_HEADER, (x) => finishedRaw(x, { dropped: true, reason: a.reason }));
          gone.set(id, i);
          result = "dropped → done.md";
          break;
        case "set": {
          const updates = { ...(a.fields ?? {}), ...Object.fromEntries((a.unset ?? []).map((k) => [k, ""])) };
          checkValues(e.file, updates);
          changes.change(id, (x) => stamp(x, updates));
          result = Object.entries(updates).map(([k, v]) => (v ? `${k}: ${v}` : `-${k}`)).join(", ");
          break;
        }
        case "retag":
          changes.change(id, (x) => {
            const tags = (x.meta.tags ?? "").split(/[,\s]+/).filter(Boolean).filter((t) => !(a.remove ?? []).includes(t));
            for (const t of a.add ?? []) if (!tags.includes(t)) tags.push(t);
            result = `tags: ${tags.join(", ") || "(none)"}`;
            return stamp(x, { tags: tags.join(", ") });
          });
          break;
        case "link": {
          const to = locate(before, a.to!.toUpperCase());
          if (a.rel === "refs") changes.change(id, (x) => stamp(x, { refs: addTo(x.meta.refs, to.id!) }));
          else if (a.rel === "closes") {
            if (e.kind !== "A" || to.kind !== "Q") throw new RefusedError(`closes links an answer to a question`);
            if (mentions(e.meta["superseded-by"] ?? "").length) throw new RefusedError(`${id} is superseded: link its current answer`);
            changes.change(id, (x) => stamp(x, { closes: addTo(x.meta.closes, to.id!) }));
            // An open question that an answer closes leaves questions.md, as `answer --closes` does.
            if (to.file === "questions.md") {
              changes.remove(to.id!);
              gone.set(to.id!, i);
            }
          } else relate(changes, before, a.rel!, to.id!, id);
          result = `${a.rel} ${to.id}`;
          break;
        }
        case "cluster": {
          // Each member gets the cluster's tag; the group itself is the log line.
          const tag = clusterTag(a.label!);
          const members = [...new Set(a.members!.map((m) => m.toUpperCase()))];
          for (const m of members) {
            if (gone.has(m)) throw new RefusedError(`${m} was already moved by action ${gone.get(m)! + 1}`);
            locate(before, m);
          }
          for (const m of members) {
            changes.change(m, (x) => {
              const tags = (x.meta.tags ?? "").split(/[,\s]+/).filter(Boolean);
              return stamp(x, { tags: [...new Set([...tags, tag])].join(", ") });
            });
          }
          result = `${tag} on ${members.join(", ")} ("${a.label}")`;
          break;
        }
        case "condense": {
          result = condense(before, changes, a, gone, i, claimed, kb);
          break;
        }
        case "flag":
          if (!owner) throw new RefusedError(`flag sets waiting-on to the owner: name one in ${DIR}/config.json ({"owner": "…"})`);
          changes.change(id, (x) => rewrite(x, { updates: { "waiting-on": owner }, body: appendToSection(x.body, "History", `flagged: ${a.note}`) }));
          result = `waiting-on: ${owner}`;
          break;
      }
      applied.push({ index: i, action: a.action, id, result });
    } catch (err) {
      // A refusal, a missing entry or a stale hash is this action's problem; anything else is a bug.
      if (!(err instanceof RefusedError || err instanceof NotFoundError || err instanceof ConflictError)) throw err;
      problems.push(`${label(a, i)}: ${err.message}`);
    }
  });
  if (problems.length) throw new ProposalsRefusedError(problems);
  return { changes, applied };
}

export async function readProposals(path: string): Promise<Proposals> {
  const f = Bun.file(path);
  if (!(await f.exists())) throw new RefusedError(`no file ${path}`);
  return parseProposals(await f.text(), path);
}

// Proposals from JSON text, checked against the format.
export function parseProposals(text: string, source: string): Proposals {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ProposalsRefusedError([`${source} is not valid JSON (${(err as Error).message})`]);
  }
  const problems = validate(data);
  if (problems.length) throw new ProposalsRefusedError(problems);
  return data as Proposals;
}

export const LOG = "log/curation.md";
const LOG_HEADER = "# Curation log\n\nOne line per applied action, oldest first. Append-only: `remembrancer apply` writes it.\n\n";

// Apply a proposals file, or with `dryRun` say what it would do (and which lint
// problems it would add) without writing anything.
export async function apply(root: string, path: string, { dryRun = false } = {}): Promise<Applied[]> {
  return applyProposals(root, await readProposals(path), basename(path), { dryRun });
}

export async function applyProposals(root: string, p: Proposals, sourceName: string, { dryRun = false } = {}): Promise<Applied[]> {
  if (dryRun) {
    const before = await loadProject(root);
    const { changes, applied } = plan(before, p);
    const texts = new Map(changes.writes());
    const files = before.files.map((f) => (texts.has(f.path) ? parseFile(f.path, texts.get(f.path)!) : f));
    for (const [rel, text] of texts) if (!before.files.some((f) => f.path === rel)) files.push(parseFile(rel, text));
    const added = lintAdded(before, buildProject(root, files));
    if (added.length) throw new ProposalsRefusedError(added.map((x: Problem) => `${DIR}/${x.file}: ${x.id ?? "?"}: ${x.message}`), "would be refused by lint");
    return applied;
  }
  const applied = await withFiles(root, async (before) => {
    const { changes, applied } = plan(before, p);
    return { writes: changes.writes(), result: applied };
  });
  const log = join(root, DIR, LOG);
  await mkdir(join(root, DIR, "log"), { recursive: true });
  const start = (await Bun.file(log).exists()) ? "" : LOG_HEADER;
  const when = new Date().toISOString().slice(0, 16) + "Z";
  const source = `${p.mode} by ${p.by}${p.packet ? `, packet ${p.packet}` : ""}, ${sourceName}`;
  await appendFile(log, start + applied.map((a) => `- ${when} ${a.action} ${a.id}: ${a.result} (${source}): ${p.actions[a.index].why}\n`).join(""));
  return applied;
}

// The file a theme entry goes to: its kind's active file (a theme of tasks
// that are all finished goes to done.md), or the archive with dest "archive".
function themeFile(kind: Kind, members: Entry[], dest: "active" | "archive", kb: boolean): { to: string; header: string; prepend: boolean } {
  const stems: Record<Kind, string> = { T: "done", Q: "questions", A: "answers", R: "rules", K: "resources" };
  const openWork = kind === "T" && members.some((m) => m.file === "todo.md");
  const stem = openWork ? "todo" : stems[kind];
  if (dest === "archive") {
    return kb ? { to: `kb/${stem}.md`, header: `# Knowledge base: ${stem}\n`, prepend: true } : { to: `archive/${stem}-${today().slice(0, 4)}.md`, header: `# Archive: ${stem}\n`, prepend: true };
  }
  return { to: `${stem}.md`, header: "", prepend: stem === "done" };
}

// The next free number for a kind, past any this file's themes already took.
function freshId(before: Project, kind: Kind, claimed: Set<string>): string {
  const family = kind === "Q" || kind === "A" ? ["Q", "A"] : [kind];
  let n = Math.max(0, ...usedNumbers(before, kind), ...[...claimed].filter((c) => family.includes(c[0])).map((c) => parseInt(c.slice(1), 10))) + 1;
  const id = padId(kind, n++);
  claimed.add(id);
  return id;
}

const REASON = /\*\*(Why|Because)\b[^*]*\*\*|^(Why|Because):/im;

// condense: several entries become one theme entry (`kind: theme`,
// `condensed-from:` and `refs:` naming them), and each source moves to the
// archive with `condensed-into:`, so its ID still resolves and leads to the
// theme. Guards against losing knowledge: the theme must name its sources in
// its text, keep a reason where a source gave one, and no source may be the
// live end of a supersession chain whose older entries stay behind.
function condense(before: Project, changes: Changes, a: Action, gone: Map<string, number>, i: number, claimed: Set<string>, kb: boolean): string {
  const from = actionIds({ from: a.from });
  const into = a.into!;
  const members = from.map((m) => {
    if (gone.has(m)) throw new RefusedError(`${m} was already moved by action ${gone.get(m)! + 1}`);
    return locate(before, m);
  });
  for (const m of members) {
    for (const older of mentions(m.meta.supersedes ?? "")) {
      if (!from.includes(older)) throw new RefusedError(`${m.id} supersedes ${older}: condensing ${m.id} alone would leave ${older}'s chain ending in the archive; condense ${older} with it, or leave ${m.id} out`);
    }
  }
  if (!mentions(into.body).some((id) => from.includes(id))) throw new RefusedError(`the theme's body names none of its sources (${from.join(", ")}): say which entry each fact comes from`);
  const reasoned = members.filter((m) => REASON.test(m.body)).map((m) => m.id);
  if (reasoned.length && !REASON.test(into.body)) throw new RefusedError(`${reasoned.join(", ")} give${reasoned.length === 1 ? "s" : ""} a reason (**Why**); the theme must keep it under **Why:**`);
  checkValues(`${into.kind === "T" ? "done" : "x"}.md`, into.fields ?? {});
  const dest = a.dest ?? "active";
  const { to, header, prepend } = themeFile(into.kind, members, dest, kb);
  const id = freshId(before, into.kind, claimed);
  const dateKey = { T: to.startsWith("todo") ? "added" : "done", Q: "asked", A: "answered", R: "added", K: "added" }[into.kind];
  const meta: Record<string, string> = {
    kind: "theme",
    [dateKey]: today(),
    ...(into.fields ?? {}),
    "condensed-from": from.join(", "),
    refs: [...new Set([...mentions(into.fields?.refs ?? ""), ...from])].join(", "),
  };
  const raw = formatEntry({ id, title: into.title.trim(), meta, body: into.body.trim() });
  if (prepend || dest === "archive") changes.prepend(to, raw, header);
  else changes.append(to, raw);
  for (const m of members) {
    const update = (x: Entry) => {
      const tags = (x.meta.tags ?? "").split(/[,\s]+/).filter((t) => t && !t.startsWith("c-")).join(", ");
      return stamp(x, { "condensed-into": id, tags, suggest: "", ...(a.importance ? { importance: a.importance } : {}) });
    };
    if (/^(archive|kb)\//.test(m.file)) changes.change(m.id!, update);
    else {
      const target = archiveTarget(changes.get(m.id!), kb);
      changes.move(m.id!, target.to, target.header, update);
    }
    gone.set(m.id!, i);
  }
  return `${id} "${into.title.trim()}" in ${to}, from ${from.join(", ")}`;
}
