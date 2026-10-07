import { attention, inFile, openTodos } from "./analyse";
import { type Entry, daysSince } from "./model";
import type { Project } from "./project";
import { STALE_DAYS, currentPhase, finishedPlans, stale, tagsOf, waiting } from "./signals";

const MAX_TODOS = 6;
const MAX_NEXT = 4;
const MAX_QUESTIONS = 5;
const MAX_RULES = 15;
const MAX_RESOURCES = 6;
const MAX_WAITING = 10;

function plural(n: number, word: string, many = word + "s"): string {
  return `${n} ${n === 1 ? word : many}`;
}

function more(total: number, shown: number): string[] {
  return total > shown ? [`  … ${total - shown} more`] : [];
}

const VISIBILITY = {
  private:
    "git ignores .remembrancer/, so its IDs mean nothing outside it: never write T/Q/A/R/K IDs in commit messages, PRs, code, comments or other files. Describe the task, rule or decision in words instead.",
  committed: ".remembrancer/ is committed with the code: cite IDs in commit messages and PRs where they help.",
};

// An entry as the brief carries it.
export interface BriefEntry {
  id: string;
  kind: string;
  file: string;
  title: string;
  meta: Record<string, string>;
}

const summary = (e: Entry): BriefEntry => ({ id: e.id!, kind: e.kind!, file: e.file, title: e.title, meta: e.meta });

// What the brief says, as data (`brief --json`); the text is drawn from it.
export interface BriefData {
  project: string;
  visibility: "private" | "committed" | null;
  owner: string | null;
  waiting: BriefEntry[]; // waiting on the owner (on anyone, when there is no owner)
  waitingOthers: number; // entries waiting on someone else
  phase: { plan: BriefEntry; phase: string | null; done: number; total: number; next: BriefEntry[]; resources: BriefEntry[] } | null;
  inbox: number;
  finishedPlans: BriefEntry[]; // open plans with every child done: ready to close
  rules: { id: string; title: string; status: string; form: string | null; tested: boolean; checked: string | null; reviewed: string | null }[];
  stale: { count: number; byKind: Record<string, number> };
  checks: null; // { pass, fail, unrunnable } once rule checks run (a later slice)
  todos: (BriefEntry & { blockedBy: string[] })[]; // open and triaged, in order
  questions: (BriefEntry & { age: number | null })[];
  resources: BriefEntry[];
  attention: Record<string, number>;
}

export function briefData(project: Project, now = new Date(), visibility: "private" | "committed" | null = null): BriefData {
  const owner = project.config.owner?.toLowerCase() ?? null;
  const groups = waiting(project);
  const mine = owner ? (groups.get(owner) ?? []) : [...groups.values()].flat();
  const others = owner ? [...groups].filter(([who]) => who !== owner).reduce((n, [, l]) => n + l.length, 0) : 0;

  // Resources for the phase: those whose consult-when or tags share a word with the plan's tags.
  const phase = currentPhase(project);
  const phaseTags = new Set(phase ? tagsOf(phase.plan) : []);
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  const resources = inFile(project, "resources.md");
  const phaseResources = resources.filter((k) => [...words(k.meta["consult-when"] ?? ""), ...tagsOf(k)].some((w) => phaseTags.has(w)));

  const staleList = stale(project, { now });
  const byKind: Record<string, number> = {};
  for (const s of staleList) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  const counts: Record<string, number> = {};
  for (const a of attention(project, now)) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  const todos = openTodos(project);

  return {
    project: project.name,
    visibility,
    owner,
    waiting: mine.map(summary),
    waitingOthers: others,
    phase: phase && {
      plan: summary(phase.plan),
      phase: phase.plan.meta.phase ?? null,
      done: phase.done,
      total: phase.total,
      next: phase.next.map(summary),
      resources: phaseResources.map(summary),
    },
    inbox: todos.filter((t) => t.meta.status === "inbox").length,
    finishedPlans: finishedPlans(project).map(summary),
    rules: inFile(project, "rules.md")
      .filter((r) => ["active", "challenged", "proposed"].includes(r.meta.status))
      .map((r) => ({
        id: r.id!,
        title: r.title,
        status: r.meta.status,
        form: r.meta.form ?? null,
        tested: !!r.meta["enforced-by"],
        checked: r.meta.checked ?? null,
        reviewed: r.meta.reviewed ?? null,
      })),
    stale: { count: staleList.length, byKind },
    checks: null,
    todos: todos.filter((t) => t.meta.status !== "inbox").map((t) => ({ ...summary(t), blockedBy: t.blockedBy })),
    questions: inFile(project, "questions.md").map((q) => ({ ...summary(q), age: daysSince(q.meta.asked, now) })),
    resources: resources.map(summary),
    attention: counts,
  };
}

// A short plain-text summary for the start of a session (and SessionStart hooks).
// `visibility` comes from project.visibility (git state, kept out of here so tests stay pure).
export function brief(project: Project, now = new Date(), visibility: "private" | "committed" | null = null): string {
  return renderBrief(briefData(project, now, visibility));
}

// Order: what waits on the owner, the current phase, what needs a decision
// (inbox, proposed and challenged rules, staleness), then the day's sections,
// shortened.
export function renderBrief(d: BriefData): string {
  const inForce = d.rules.filter((r) => r.status !== "proposed");
  const lines: string[] = [
    `Remembrancer · ${d.project} · ${d.todos.length + d.inbox} todo · ${plural(d.questions.length, "open question")} · ${plural(inForce.length, "rule")} (.remembrancer/)`,
  ];
  if (d.visibility) lines.push(VISIBILITY[d.visibility]);

  if (d.waiting.length || d.waitingOthers) {
    lines.push("", d.owner ? `Waiting on you (${d.owner}):` : "Waiting on someone:");
    for (const e of d.waiting.slice(0, MAX_WAITING)) lines.push(`  ${e.id} ${e.title}${d.owner ? "" : `  (${e.meta["waiting-on"]})`}`);
    lines.push(...more(d.waiting.length, MAX_WAITING));
    if (!d.waiting.length) lines.push("  nothing");
    if (d.waitingOthers) lines.push(`  and ${plural(d.waitingOthers, "entry", "entries")} waiting on others (remembrancer waiting --all)`);
  }

  if (d.phase) {
    const p = d.phase;
    lines.push("", `Current phase${p.phase ? ` ${p.phase}` : ""}: ${p.plan.id} ${p.plan.title}  (${p.done} of ${p.total} done)`);
    if (p.plan.meta["done-when"]) lines.push(`  done when: ${p.plan.meta["done-when"]}`);
    for (const e of p.next.slice(0, MAX_NEXT)) lines.push(`  next: ${e.id} ${e.title}`);
    lines.push(...more(p.next.length, MAX_NEXT));
    if (p.resources.length) lines.push(`  read: ${p.resources.map((k) => `${k.id} ${k.title}`).join("; ")}`);
  }

  const proposed = d.rules.filter((r) => r.status === "proposed");
  const challenged = d.rules.filter((r) => r.status === "challenged");
  const decide: string[] = [];
  if (d.inbox) decide.push(`${plural(d.inbox, "inbox task")} to triage (remembrancer set T### priority=P2 --unset status)`);
  for (const p of d.finishedPlans) decide.push(`${p.id} ${p.title}: every task done (remembrancer done ${p.id} --outcome "…")`);
  if (proposed.length) decide.push(`proposed rules: ${proposed.map((r) => r.id).join(", ")} (remembrancer rule R### activate)`);
  if (challenged.length) decide.push(`challenged rules: ${challenged.map((r) => r.id).join(", ")}`);
  if (d.stale.count) {
    const kinds = Object.entries(d.stale.byKind).map(([k, n]) => `${n} ${k}`).join(", ");
    decide.push(`${plural(d.stale.count, "stale entry", "stale entries")} (${kinds}), unchanged and uncited for ${Object.entries(STALE_DAYS).map(([k, n]) => `${k} ${n}d`).join(", ")}: remembrancer stale`);
  }
  if (decide.length) lines.push("", "To decide:", ...decide.map((s) => `  ${s}`));

  if (d.todos.length) {
    lines.push("", "Next up:");
    for (const t of d.todos.slice(0, MAX_TODOS)) {
      const blocked = t.blockedBy.length ? `  (after ${t.blockedBy.join(", ")})` : "";
      lines.push(`  ${t.meta.priority ?? "P?"} ${t.id} ${t.title}${blocked}`);
    }
    lines.push(...more(d.todos.length, MAX_TODOS));
  }

  const shown = new Set(d.waiting.map((e) => e.id));
  const questions = d.questions.filter((q) => !shown.has(q.id));
  if (questions.length) {
    lines.push("", "Open questions:");
    for (const q of questions.slice(0, MAX_QUESTIONS)) lines.push(`  ${q.id} ${q.title}${q.age !== null ? `  (${q.age}d)` : ""}`);
    lines.push(...more(questions.length, MAX_QUESTIONS));
  }

  if (inForce.length) {
    lines.push("", "Rules (check work against these):");
    for (const r of inForce.slice(0, MAX_RULES)) {
      const tags = [r.form, r.tested ? "tested" : "", r.status === "challenged" ? "CHALLENGED" : ""].filter(Boolean).join(", ");
      lines.push(`  ${r.id} ${r.title}${tags ? `  [${tags}]` : ""}`);
    }
    lines.push(...more(inForce.length, MAX_RULES));
  }

  if (d.resources.length) {
    lines.push("", "Resources (read the matching ones before non-trivial work on that area):");
    for (const k of d.resources.slice(0, MAX_RESOURCES)) {
      const when = k.meta["consult-when"];
      lines.push(`  ${k.id} ${k.title}${when ? `  (when: ${when})` : ""}`);
    }
    lines.push(...more(d.resources.length, MAX_RESOURCES));
  }

  const labels: Record<string, [string, string]> = {
    curate: ["done entry due for curation", "done entries due for curation"],
    "unreviewed-rule": ["rule not reviewed recently", "rules not reviewed recently"],
  };
  const notes = Object.entries(d.attention)
    .filter(([k]) => labels[k])
    .map(([k, n]) => `${n} ${labels[k][n === 1 ? 0 : 1]}`);
  if (d.attention.scratch) notes.push("scratch has leftovers from a past session");
  if (notes.length) lines.push("", `Needs attention: ${notes.join("; ")}.`);
  return lines.join("\n");
}
