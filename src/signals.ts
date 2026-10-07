// What the files say about themselves over time: what has gone stale, what
// waits on someone, and how a plan stands. Pure functions over a Project.
import { DATE_KEYS, inFile } from "./analyse";
import { type Entry, type Kind, daysSince, mentions } from "./model";
import type { Project } from "./project";

// An entry's tags: `tags:` plus `area:` (read as one more tag), lowercased.
export function tagsOf(e: Entry): string[] {
  const words = [e.meta.tags ?? "", e.meta.area ?? ""].flatMap((v) => v.split(/[,\s]+/));
  return [...new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean))];
}

// The day an entry last changed, as far as the file says: `touched:`, else
// its newest date.
export function effectiveDate(e: Entry): string | null {
  if (daysSince(e.meta.touched) !== null) return e.meta.touched;
  const dates = DATE_KEYS.map((k) => e.meta[k]).filter((d) => daysSince(d) !== null);
  return dates.length ? dates.sort().at(-1)! : null;
}

// Days without change after which an entry counts as stale, per kind: the
// defaults, which config.json's `stale` overrides kind by kind.
export const STALE_DAYS: Record<Kind, number> = { T: 30, Q: 14, A: 90, R: 90, K: 90 };

export function staleDays(project: Project): Record<Kind, number> {
  return { ...STALE_DAYS, ...(project.config.stale ?? {}) };
}

// The files whose entries can be stale: the active set, not the archive or scratch.
const ACTIVE_FILES = ["todo.md", "done.md", "questions.md", "answers.md", "rules.md", "resources.md"];

// The live work: open todos and questions, and rules still in force. An entry
// one of these cites (in its metadata or body) is in use, however old.
function live(project: Project): Entry[] {
  return [
    ...inFile(project, "todo.md"),
    ...inFile(project, "questions.md"),
    ...inFile(project, "rules.md").filter((r) => r.meta.status !== "retired"),
  ];
}

export interface StaleEntry {
  id: string;
  kind: Kind;
  file: string;
  title: string;
  date: string | null;
  age: number | null; // days since `date`; null when the entry has no date
}

// Entries unchanged for longer than their kind's threshold (or `days`) that
// nothing live cites. Oldest first; an undated entry counts as stale.
export function stale(project: Project, { days, kind, now = new Date() }: { days?: number; kind?: Kind; now?: Date } = {}): StaleEntry[] {
  const cited = new Map<string, Set<string>>();
  for (const e of live(project)) {
    for (const id of mentions(e.raw.split("\n").slice(1).join("\n"))) {
      if (id !== e.id) cited.set(id, (cited.get(id) ?? new Set()).add(e.id!));
    }
  }
  const out: StaleEntry[] = [];
  for (const e of project.entries) {
    if (!e.id || !ACTIVE_FILES.includes(e.file) || (kind && e.kind !== kind)) continue;
    if (cited.has(e.id)) continue;
    const date = effectiveDate(e);
    const age = date ? daysSince(date, now) : null;
    if (age !== null && age <= (days ?? staleDays(project)[e.kind!])) continue;
    out.push({ id: e.id, kind: e.kind!, file: e.file, title: e.title, date, age });
  }
  return out.sort((a, b) => (b.age ?? Infinity) - (a.age ?? Infinity));
}

// Entries in the active set with `waiting-on:`, grouped by who (lowercased),
// in file order.
export function waiting(project: Project, on?: string): Map<string, Entry[]> {
  const groups = new Map<string, Entry[]>();
  for (const e of project.entries) {
    const who = e.meta["waiting-on"]?.trim().toLowerCase();
    if (!who || !e.id || !ACTIVE_FILES.includes(e.file) || (on && who !== on.toLowerCase())) continue;
    groups.set(who, [...(groups.get(who) ?? []), e]);
  }
  return groups;
}

export type TaskState = "open" | "done" | "dropped" | "missing";

export function stateOf(project: Project, id: string): TaskState {
  const e = project.byId.get(id)?.[0];
  if (!e) return "missing";
  if (e.file === "todo.md") return "open";
  return e.meta.dropped === "yes" ? "dropped" : "done";
}

export interface PlanNode {
  id: string;
  title: string | null;
  state: TaskState;
  blockers: string[]; // its `after:` tasks that are still open
  children: PlanNode[];
  cycle?: boolean; // it is its own ancestor: not expanded again
}

// The tree a task opens through `after:`. A child with its own `after:` (a
// nested plan, or a task with prerequisites) is expanded in turn; a cycle is
// marked where it closes.
export function planTree(project: Project, id: string, path: string[] = []): PlanNode {
  const e = project.byId.get(id)?.[0];
  const after = mentions(e?.meta.after ?? "");
  const node: PlanNode = {
    id,
    title: e?.title ?? null,
    state: stateOf(project, id),
    blockers: after.filter((a) => stateOf(project, a) === "open"),
    children: [],
  };
  if (path.includes(id)) return { ...node, cycle: true };
  node.children = after.map((child) => planTree(project, child, [...path, id]));
  return node;
}

// A plan is an open todo whose title starts "Plan:", or that has `done-when:`.
export function isPlan(e: Entry): boolean {
  return e.file === "todo.md" && (/^plan\s*:/i.test(e.title) || !!e.meta["done-when"]);
}

export interface Phase {
  plan: Entry;
  done: number; // children done or dropped
  total: number;
  next: Entry[]; // open children with no open blockers, in `after:` order
}

// The current phase: the open plan with `phase:` whose `after:` has the most
// children done, else the first P1 plan. A plan with every child done is
// passed over while another has work left (it is waiting to be closed).
export function currentPhase(project: Project): Phase | null {
  const plans = inFile(project, "todo.md").filter(isPlan);
  const summary = (plan: Entry): Phase => {
    const children = mentions(plan.meta.after ?? "");
    const states = children.map((c) => stateOf(project, c));
    const next = children
      .filter((c, i) => states[i] === "open" && mentions(project.byId.get(c)![0].meta.after ?? "").every((b) => stateOf(project, b) !== "open"))
      .map((c) => project.byId.get(c)![0]);
    return { plan, done: states.filter((s) => s === "done" || s === "dropped").length, total: children.length, next };
  };
  const unfinished = (list: Phase[]) => (list.some((p) => p.done < p.total) ? list.filter((p) => p.done < p.total) : list);
  const phased = unfinished(plans.filter((p) => p.meta.phase).map(summary));
  if (phased.length) return phased.reduce((best, p) => (p.done > best.done ? p : best));
  return unfinished(plans.filter((p) => p.meta.priority === "P1").map(summary))[0] ?? null;
}

// Open plans whose children are all done or dropped: ready to close with `done`.
export function finishedPlans(project: Project): Entry[] {
  return inFile(project, "todo.md").filter((p) => {
    const children = mentions(p.meta.after ?? "");
    return isPlan(p) && children.length > 0 && children.every((c) => ["done", "dropped"].includes(stateOf(project, c)));
  });
}

export function formatPlan(node: PlanNode, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  const blocked = node.blockers.length ? `  (after ${node.blockers.join(", ")})` : "";
  const line = `${pad}${node.id} ${node.state.padEnd(7)} ${node.title ?? "(no entry)"}${blocked}${node.cycle ? "  (cycle: already above)" : ""}`;
  return [line, ...node.children.flatMap((c) => formatPlan(c, depth + 1))];
}
