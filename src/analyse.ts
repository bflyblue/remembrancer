import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Entry, type Kind, daysSince, mentions, padId } from "./model";
import { type Project, usedNumbers } from "./project";

export const THRESHOLDS = {
  todoDays: 30, // an open task this old is worth a second look
  questionDays: 14, // a question open this long should be answered or dropped
  ruleReviewDays: 90, // a rule not re-read in this long may have drifted
  curateDays: 30, // done entries older than this are due for distil + archive
};

export const PRIORITY_ORDER: Record<string, number> = { P1: 1, P2: 2, P3: 3 };

export function inFile(project: Project, file: string): Entry[] {
  return project.files.find((f) => f.path === file)?.entries ?? [];
}

export function openTodos(project: Project): (Entry & { blockedBy: string[] })[] {
  const open = inFile(project, "todo.md");
  const openIds = new Set(open.map((e) => e.id));
  return open
    .map((e) => ({ ...e, blockedBy: mentions(e.meta.after ?? "").filter((id) => openIds.has(id)) }))
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.meta.priority] ?? 9;
      const pb = PRIORITY_ORDER[b.meta.priority] ?? 9;
      return pa - pb || a.blockedBy.length - b.blockedBy.length || a.index - b.index;
    });
}

export interface Attention {
  kind: string;
  id: string | null;
  file: string;
  index: number;
  message: string;
}

export function attention(project: Project, now = new Date()): Attention[] {
  const out: Attention[] = [];
  const add = (e: Entry, kind: string, message: string) =>
    out.push({ kind, id: e.id, file: e.file, index: e.index, message });

  for (const e of inFile(project, "todo.md")) {
    const age = daysSince(e.meta.added, now);
    if (age !== null && age > THRESHOLDS.todoDays) add(e, "stale-todo", `open for ${age} days`);
  }
  for (const e of inFile(project, "questions.md")) {
    const age = daysSince(e.meta.asked, now);
    if (age !== null && age > THRESHOLDS.questionDays) add(e, "stale-question", `open for ${age} days`);
  }
  for (const e of inFile(project, "done.md")) {
    const age = daysSince(e.meta.done, now);
    if (age !== null && age > THRESHOLDS.curateDays) add(e, "curate", `done ${age} days ago: distil and archive`);
  }
  for (const e of inFile(project, "rules.md")) {
    const status = e.meta.status;
    if (status === "proposed") add(e, "proposed-rule", "proposed: promote to active or drop");
    if (status === "challenged") add(e, "challenged-rule", "challenged: resolve the linked question");
    if (status === "active") {
      const age = daysSince(e.meta.reviewed ?? e.meta.revised ?? e.meta.added, now);
      if (age !== null && age > THRESHOLDS.ruleReviewDays) add(e, "unreviewed-rule", `not reviewed for ${age} days`);
      if (e.meta.form === "heuristic") add(e, "sharpen-rule", "heuristic: can it be stated as a property?");
    }
  }
  const scratch = project.files.find((f) => f.path === "scratch.md");
  const sessions = [...(scratch?.text ?? "").matchAll(/^# Session (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
  const oldest = sessions.sort()[0];
  if (oldest && (daysSince(oldest, now) ?? 0) > 0) {
    out.push({ kind: "scratch", id: null, file: "scratch.md", index: -1, message: `scratch has notes from ${oldest}` });
  }
  return out;
}

export interface Problem {
  file: string;
  id: string | null;
  message: string;
}

const REQUIRED: Record<string, string[]> = {
  "todo.md": ["priority", "added"],
  "done.md": ["done"],
  "questions.md": ["asked"],
  "answers.md": ["answered"],
  "rules.md": ["scope", "form", "status", "added"],
};

const EXPECTED_KIND: Record<string, string> = {
  "todo.md": "T",
  "done.md": "T",
  "questions.md": "Q",
  "answers.md": "A",
  "rules.md": "R",
};

const ENUMS: Record<string, string[]> = {
  priority: ["P1", "P2", "P3"],
  scope: ["code", "design", "agent", "process"],
  form: ["invariant", "property", "heuristic"],
  status: ["proposed", "active", "challenged", "retired"],
};

const DATE_KEYS = ["added", "done", "asked", "answered", "reviewed", "revised"];

// Keys whose values must be IDs of one kind; `same` means the entry's own kind.
const LINK_KINDS: Record<string, string> = { closes: "Q", amends: "A", supersedes: "same", "superseded-by": "same" };

// Where a stub goes to fill a gap in each sequence.
const GAP_HINT: [kind: Kind, file: string, hint: string][] = [
  ["T", "todo.md", "a todo was deleted or its number skipped: add a stub to done.md with `dropped: yes`"],
  ["A", "answers.md", "a question was deleted or its number skipped: add a stub answer"],
  ["R", "rules.md", "a rule was deleted or its number skipped: add a stub rule with `status: retired`"],
];

// With `ids`, only the checks on IDs and links (fast enough for a hook after every edit).
export function lint(project: Project, { ids = false } = {}): Problem[] {
  const problems: Problem[] = [];
  const report = (e: Entry | { file: string; id: string | null }, message: string) =>
    problems.push({ file: e.file, id: e.id, message });

  for (const [id, list] of project.byId) {
    if (list.length > 1) report(list[0], `duplicate id ${id} in ${list.map((e) => e.file).join(", ")}`);
  }

  // The answers that close each question: An closes Qn, plus its `closes:` list.
  const closers = new Map<string, Entry[]>();
  for (const a of project.entries) {
    if (a.kind !== "A" || !a.id) continue;
    for (const q of new Set(["Q" + a.id.slice(1), ...mentions(a.meta.closes ?? "")])) {
      closers.set(q, [...(closers.get(q) ?? []), a]);
    }
  }
  const exists = (id: string) => project.byId.has(id) || closers.has(id);

  for (const e of project.entries) {
    const base = e.file.startsWith("archive/") ? e.file.replace(/^archive\/(\w+)-\d{4}\.md$/, "$1.md") : e.file;
    if (!e.id) {
      report(e, `heading "${e.title}" is not "## <ID> · <title>"`);
      continue;
    }
    const kind = EXPECTED_KIND[base];
    if (kind && e.kind !== kind) report(e, `${e.id} does not belong in ${e.file} (expected ${kind}###)`);
    const text = e.raw.split("\n").slice(1).join("\n");
    for (const ref of mentions(text)) {
      if (ref !== e.id && !exists(ref)) report(e, `refers to ${ref}, which does not exist`);
    }
    for (const [key, want] of Object.entries(LINK_KINDS)) {
      const expected = want === "same" ? e.kind : want;
      for (const ref of mentions(e.meta[key] ?? "")) {
        if (ref[0] !== expected) report(e, `${key}: ${ref} is not a ${expected} id`);
      }
    }
    for (const target of mentions(e.meta.supersedes ?? "")) {
      const old = project.byId.get(target)?.[0];
      if (old && !mentions(old.meta["superseded-by"] ?? "").includes(e.id)) {
        report(e, `supersedes ${target}, but ${target} has no "superseded-by: ${e.id}"`);
      }
      if (old && e.kind === "R" && old.meta.status !== "retired") report(e, `supersedes ${target}, but ${target} is not retired`);
    }
    if (ids) continue;
    for (const key of REQUIRED[base] ?? []) {
      if (!e.meta[key]) report(e, `missing "${key}:"`);
    }
    for (const [key, allowed] of Object.entries(ENUMS)) {
      if (e.meta[key] && !allowed.includes(e.meta[key])) report(e, `${key}: "${e.meta[key]}" is not one of ${allowed.join("|")}`);
    }
    for (const key of DATE_KEYS) {
      if (e.meta[key] && daysSince(e.meta[key]) === null) report(e, `${key}: "${e.meta[key]}" is not YYYY-MM-DD`);
    }
    if (e.kind === "A" && !/\*\*Question\*\*/.test(e.body)) report(e, `answer has no **Question** section`);
  }

  for (const q of inFile(project, "questions.md")) {
    const by = q.id ? closers.get(q.id) : undefined;
    if (by) report(q, `${q.id} is still open but ${by.map((a) => a.id).join(" and ")} ${by.length > 1 ? "close" : "closes"} it`);
  }
  // A question has one current answer; a superseded one no longer counts.
  for (const [q, by] of closers) {
    const current = by.filter((a) => !a.meta["superseded-by"]);
    if (current.length > 1) report(current[1], `${q} is closed by both ${current[0].id} and ${current[1].id}`);
  }

  // Numbers are never freed, so every number up to the highest must still be in use.
  for (const [kind, file, hint] of GAP_HINT) {
    const used = usedNumbers(project, kind);
    const max = Math.max(0, ...used);
    for (let n = 1; n <= max; n++) {
      if (used.has(n)) continue;
      const from = n;
      while (n < max && !used.has(n + 1)) n++;
      report({ file, id: padId(kind, from) }, `no entry has number ${from === n ? n : `${from}–${n}`}; ${hint}`);
    }
  }
  if (ids) return problems;

  const openQuestionText = inFile(project, "questions.md").map((q) => q.raw).join("\n");
  for (const r of inFile(project, "rules.md")) {
    if (r.meta["enforced-by"]) {
      const path = r.meta["enforced-by"].split(/[:\s]/)[0];
      if (path && !existsSync(join(project.root, path))) report(r, `enforced-by ${path} does not exist`);
    }
    if (r.meta.status === "challenged" && !mentions(openQuestionText).includes(r.id!)) {
      report(r, `challenged, but no open question mentions ${r.id}`);
    }
  }
  return problems;
}
