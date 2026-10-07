import { attention, inFile, openTodos } from "./analyse";
import { daysSince } from "./model";
import type { Project } from "./project";

const MAX_TODOS = 8;
const MAX_QUESTIONS = 6;
const MAX_RULES = 15;
const MAX_RESOURCES = 10;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function more(total: number, shown: number): string[] {
  return total > shown ? [`  … ${total - shown} more`] : [];
}

const VISIBILITY = {
  private:
    "git ignores .remembrancer/, so its IDs mean nothing outside it: never write T/Q/A/R/K IDs in commit messages, PRs, code, comments or other files. Describe the task, rule or decision in words instead.",
  committed: ".remembrancer/ is committed with the code: cite IDs in commit messages and PRs where they help.",
};

// A short plain-text summary for the start of a session (and SessionStart hooks).
// `visibility` comes from project.visibility (git state, kept out of here so tests stay pure).
export function brief(project: Project, now = new Date(), visibility: "private" | "committed" | null = null): string {
  const todos = openTodos(project);
  const questions = inFile(project, "questions.md");
  const rules = inFile(project, "rules.md").filter((r) => r.meta.status === "active" || r.meta.status === "challenged");
  const lines: string[] = [
    `Remembrancer · ${project.name} · ${todos.length} todo · ${plural(questions.length, "open question")} · ${plural(rules.length, "rule")} (.remembrancer/)`,
  ];
  if (visibility) lines.push(VISIBILITY[visibility]);

  if (todos.length) {
    lines.push("", "Next up:");
    for (const t of todos.slice(0, MAX_TODOS)) {
      const blocked = t.blockedBy.length ? `  (after ${t.blockedBy.join(", ")})` : "";
      lines.push(`  ${t.meta.priority ?? (t.meta.status === "inbox" ? "inbox" : "P?")} ${t.id} ${t.title}${blocked}`);
    }
    lines.push(...more(todos.length, MAX_TODOS));
  }

  if (questions.length) {
    lines.push("", "Open questions:");
    for (const q of questions.slice(0, MAX_QUESTIONS)) {
      const age = daysSince(q.meta.asked, now);
      lines.push(`  ${q.id} ${q.title}${age !== null ? `  (${age}d)` : ""}`);
    }
    lines.push(...more(questions.length, MAX_QUESTIONS));
  }

  if (rules.length) {
    lines.push("", "Rules (check work against these):");
    for (const r of rules.slice(0, MAX_RULES)) {
      const tags = [r.meta.form, r.meta["enforced-by"] ? "tested" : "", r.meta.status === "challenged" ? "CHALLENGED" : ""]
        .filter(Boolean)
        .join(", ");
      lines.push(`  ${r.id} ${r.title}${tags ? `  [${tags}]` : ""}`);
    }
    lines.push(...more(rules.length, MAX_RULES));
  }

  const resources = inFile(project, "resources.md");
  if (resources.length) {
    lines.push("", "Resources (read the matching ones before non-trivial work on that area):");
    for (const k of resources.slice(0, MAX_RESOURCES)) {
      const when = k.meta["consult-when"];
      lines.push(`  ${k.id} ${k.title}${when ? `  (when: ${when})` : ""}`);
    }
    lines.push(...more(resources.length, MAX_RESOURCES));
  }

  const counts = new Map<string, number>();
  for (const a of attention(project, now)) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const labels: Record<string, [string, string]> = {
    "proposed-rule": ["proposed rule awaiting a decision", "proposed rules awaiting a decision"],
    "challenged-rule": ["challenged rule", "challenged rules"],
    curate: ["done entry due for curation", "done entries due for curation"],
    "stale-question": ["stale question", "stale questions"],
    "stale-todo": ["stale todo", "stale todos"],
    "unreviewed-rule": ["rule not reviewed recently", "rules not reviewed recently"],
  };
  const notes = [...counts]
    .filter(([k]) => labels[k])
    .map(([k, n]) => `${n} ${labels[k][n === 1 ? 0 : 1]}`);
  if (counts.has("scratch")) notes.push("scratch has leftovers from a past session");
  if (notes.length) lines.push("", `Needs attention: ${notes.join("; ")}.`);
  return lines.join("\n");
}
