---
name: remembrancer
description: |
  Keeps a project's working memory in `.remembrancer/`: numbered todos (T###),
  done work with findings, open questions (Q###) and their answers (A###),
  curated rules (R###) to check code and agent behaviour against, and a
  per-session scratch file. Use at the start of every session in a project that
  has a `.remembrancer/` folder, and whenever a task is found, finished or
  blocked by an open question; when a bug's root cause, a repeated agent
  mistake or a good pattern suggests a rule; before a review or commit (check
  the change against the rules); and when stuck. Also use when the user says
  "remembrancer", "add a todo", "what's next", "open question", "park that",
  "make that a rule", "check the rules", "curate", or runs /remembrancer
  (init | status | review | curate | stuck).
---

# Remembrancer

The user has a poor memory for project state. You keep it for them in plain markdown under `.remembrancer/`, so that they can see what to do next, what is done, what is unresolved, and what the project has learned. The user also browses and curates these files by hand (`remembrancer serve`), so keep them tidy, short and accurate.

The files, with the exact format in [references/format.md](references/format.md):

| File | Holds | ID |
|---|---|---|
| `todo.md` | open tasks, with `priority: P1\|P2\|P3` and optional `after: T###` | T### |
| `done.md` | finished tasks, newest first, with outcome and findings | same T### |
| `questions.md` | open questions that must not block current work | Q### |
| `answers.md` | resolved questions and decisions: answer, why, alternatives, `revisit-if` | A### = its Q number |
| `rules.md` | laws for code, design, process and agent behaviour | R### |
| `scratch.md` | this session's plan and notes, nothing longer-lived | none |
| `archive/` | distilled old done entries (read-only history) | kept |

Entry shape: `## T012 · title`, then one metadata line `key: value · key: value`, a blank line, then a short markdown body. IDs have at least 3 digits, are never reused, and every ID mentioned anywhere links to its entry.

## Getting IDs

Run `remembrancer next T --claim "title"` (or `Q`, `R`, or `A` for a decision no question asked for). It prints the ID and appends a stub entry under a lock, so no other agent gets the same number. Then fill in the stub. Plain `remembrancer next T` only prints the number. If the CLI is missing, take the highest number of that letter among the entry headings in `.remembrancer/` (archive included; Q and A share a sequence) and add one. Never renumber existing entries.

**Never delete an entry that has an ID**: its number would be handed out again. Drop a task to `done.md` with `dropped: yes`, close a question with an answer (even one that just says it was dropped), and retire a rule. Run `remembrancer lint` after editing; it reports duplicate IDs and numbers that no entry uses.

## When to act

**Session start.** Run `remembrancer brief` (or read todo, questions and rules). Tell the user in two or three lines what is next and anything that needs attention. If `scratch.md` holds an old session, move anything durable into todo, questions, answers or rules, then reset scratch to its header and a `# Session YYYY-MM-DD` heading.

**While working.** Update the files as things happen, not in a batch at the end:
- New work found that is not part of the current task → add a T entry with a priority. Add `after:` when order matters.
- Something needs investigation but should not block you → add a Q entry with `context: T###` (or the A### that raised it), say so in one line, and continue.
- A task is finished → move its entry to the top of `done.md`, add `done:` and write the outcome. Record the findings that later tasks need (decisions, gotchas, where things live), and leave out narration. A task that is no longer wanted moves the same way with `dropped: yes` and the reason.
- A question is resolved → write the A entry with the same number. Copy the question into **Question**, then write **Answer**, **Why**, **Alternatives considered**, and a `revisit-if:` condition that would make the answer worth revisiting. Delete the Q entry.
  - The same decision settles other open questions too → list them in `closes:` on that answer and delete them as well.
  - An answer settles only part of a question → split the question into narrower ones first. The answer that settles the last part closes it and lists the partial answers in `refs:`. Note progress on a question that stays open as a dated **History:** line citing the answer.
  - A new answer changes an earlier one → `amends: A###` if both still stand; `supersedes: A###` (and `superseded-by:` on the old one) if the old one no longer does.
- Before you answer a new question, search `answers.md` and the archive. If it was already settled, follow that answer or say why its `revisit-if` now applies.
- Keep short plans and working notes in `scratch.md`.

**Rules: the part that matters most.** Rules are how the project stops repeating mistakes. Keep the set small and sharp.
- A new rule can come from a bug's root cause, a mistake you (or other agents) keep repeating, a pattern that clearly works, or an investigation's result. Add it as `status: proposed` with `source:` (the T, Q or A IDs that led to it). Tell the user, and never make it `active` yourself.
- State a rule as precisely as the knowledge allows, and prefer the strongest form that is true:
  - `form: invariant`: a property that must always hold and can be checked mechanically ("for every cursor c, decode(encode(c)) == c"). Propose a test that encodes it (property-based where that fits). Once the test exists, set `enforced-by:` to its path.
  - `form: property`: precise, but checked by reading or review ("every public handler validates input before touching storage").
  - `form: heuristic`: guidance that needs judgement ("prefer deleting code to adding flags"). Treat each heuristic as a candidate for sharpening. When later work shows the precise version, rewrite it and move it up a form.
- Every rule body has the rule, then **Why:**, then **Check:** (how a reviewer verifies it).
- Merge overlapping rules and retire dead ones rather than letting the list grow.
- **Rules can be wrong.** When work shows a rule is wrong or insufficient, do not quietly ignore it and do not quietly obey it. Set `status: challenged`, open a Q that links the rule and the evidence, and tell the user. When that Q is answered, either revise the rule in place (same meaning, sharper or corrected: bump `revised:` and add a dated line under **History:**), or retire it (`status: retired`, `superseded-by: R###`) and add a new rule with `supersedes: R###`.

**Before a review or commit.** Read the `active` and `challenged` rules. Run the `enforced-by` checks for the rules the change touches. Check the diff against the property and heuristic rules. Report which R IDs apply, which pass, and which are broken, and fix the broken ones or say why not. Bump `reviewed:` on the rules you actually checked.

**When stuck** (the same fix has failed twice, or you are going in circles):
1. Stop editing code.
2. Write your current assumptions in scratch.
3. Re-read the rules and the answers related to the area. Ask whether a rule is being broken, or whether a rule (or a past answer) is itself wrong for this case.
4. Check the `revisit-if` conditions of the related answers.
5. Tell the user what you found before you continue.

## Commands (`/remembrancer <cmd>`)

- `init`: run `remembrancer init` (add `--local` for shared repos, so the rules pointer goes into `CLAUDE.local.md`). Without the CLI, copy `templates/*.md` into `.remembrancer/`, add `/.remembrancer/` to `.git/info/exclude`, and add a short section to `AGENTS.md` telling agents to check `.remembrancer/rules.md` before review and commit.
- `status`: the session-start summary, plus `remembrancer lint` problems.
- `review`: the before-commit check above, run against the staged or working diff.
- `curate`: for each done entry older than about 30 days, move any lasting knowledge into an answer or a proposed rule, then archive it (`archive/done-YYYY.md`). Also flag stale todos and questions, proposed rules awaiting a decision, and rules not reviewed in 90 days. Propose the changes to the user and let them decide.
- `stuck`: the procedure above.

## Style

- Titles are short and specific. Bodies are a few lines. The files are for scanning, not prose.
- Always write dates as `YYYY-MM-DD`.
- Reference other entries by ID (`T012`, `R003`) so the UI and the user can follow the links.
- Do not duplicate: update the existing entry instead of adding a near-copy.
- Run `remembrancer lint` after bulk edits if the CLI is available.
