import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Entry, daysSince, mentions } from "./model";
import type { Project } from "./project";

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

export function lint(project: Project): Problem[] {
  const problems: Problem[] = [];
  const report = (e: Entry | { file: string; id: string | null }, message: string) =>
    problems.push({ file: e.file, id: e.id, message });

  for (const [id, list] of project.byId) {
    if (list.length > 1) report(list[0], `duplicate id ${id} in ${list.map((e) => e.file).join(", ")}`);
  }

  const exists = (id: string) =>
    project.byId.has(id) || (id[0] === "Q" && project.byId.has("A" + id.slice(1)));

  for (const e of project.entries) {
    const base = e.file.startsWith("archive/") ? e.file.replace(/^archive\/(\w+)-\d{4}\.md$/, "$1.md") : e.file;
    if (!e.id) {
      report(e, `heading "${e.title}" is not "## <ID> · <title>"`);
      continue;
    }
    const kind = EXPECTED_KIND[base];
    if (kind && e.kind !== kind) report(e, `${e.id} does not belong in ${e.file} (expected ${kind}###)`);
    for (const key of REQUIRED[base] ?? []) {
      if (!e.meta[key]) report(e, `missing "${key}:"`);
    }
    for (const [key, allowed] of Object.entries(ENUMS)) {
      if (e.meta[key] && !allowed.includes(e.meta[key])) report(e, `${key}: "${e.meta[key]}" is not one of ${allowed.join("|")}`);
    }
    for (const key of DATE_KEYS) {
      if (e.meta[key] && daysSince(e.meta[key]) === null) report(e, `${key}: "${e.meta[key]}" is not YYYY-MM-DD`);
    }
    const text = e.raw.split("\n").slice(1).join("\n");
    for (const ref of mentions(text)) {
      if (ref !== e.id && !exists(ref)) report(e, `refers to ${ref}, which does not exist`);
    }
    if (e.kind === "A" && !/\*\*Question\*\*/.test(e.body)) report(e, `answer has no **Question** section`);
  }

  for (const q of inFile(project, "questions.md")) {
    if (q.id && project.byId.has("A" + q.id.slice(1))) report(q, `${q.id} is still open but A${q.id.slice(1)} answers it`);
  }

  const openQuestionText = inFile(project, "questions.md").map((q) => q.raw).join("\n");
  for (const r of inFile(project, "rules.md")) {
    if (r.meta["enforced-by"]) {
      const path = r.meta["enforced-by"].split(/[:\s]/)[0];
      if (path && !existsSync(join(project.root, path))) report(r, `enforced-by ${path} does not exist`);
    }
    for (const target of mentions(r.meta.supersedes ?? "")) {
      const old = project.byId.get(target)?.[0];
      if (old && !mentions(old.meta["superseded-by"] ?? "").includes(r.id!)) {
        report(r, `supersedes ${target}, but ${target} has no "superseded-by: ${r.id}"`);
      }
      if (old && old.meta.status !== "retired") report(r, `supersedes ${target}, but ${target} is not retired`);
    }
    if (r.meta.status === "challenged" && !mentions(openQuestionText).includes(r.id!)) {
      report(r, `challenged, but no open question mentions ${r.id}`);
    }
  }
  return problems;
}
