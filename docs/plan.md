# Execution plan

*2026-10-07. Slices from `docs/review.md`. Each is useful alone and lands with its tests, its docs (`README.md`,
`skill/SKILL.md`, `skill/references/format.md`) and a migration note. Run tests with `nix develop path:. -c bun test`.
Every command takes `--json`; errors exit 1 with one line on stderr; a refused write (stale `--if`, lint failure, bad
value) exits 2 and changes nothing.*

## Decisions already made, and the one left

Shaun's answers in `docs/wishlist.md` fix: the UI stays small (slice 12); the knowledge base is opt-in by config,
`archive/` otherwise (slice 5); the example curator targets an OpenAI-compatible endpoint from the environment, with a
Pi invocation second (slice 9); curation has two modes, `gather` (cheap model: `cluster`, `retag`, `link`, `flag`,
`archive` as a suggestion) and `insight` (Opus or Fable: everything, including `condense`), enforced by `apply`
(slices 9 to 11); the skill tells agents to make every change through the CLI, with the lint hook as the safety net
and no refusing hook (slice 2 onward).

- **D1, decided (Shaun, 2026-10-07): yes.** Gather runs apply directly; insight runs queue for review.
- **D1 (slice 10):** gather runs apply directly (reversible metadata) and only insight runs queue? Recommended; the
  alternative queues both.

## Conventions for every slice

- Entries are located by ID (a duplicate ID is refused: "run lint"). The entry hash is `hashText(e.raw)`, shown by
  `show` as `hash:` and accepted as `--if HASH`; `EntryRef` gains optional `entry` (hash), and `checkedEntry` checks it
  when present, else the file hash and index as today.
- Every command that changes an entry stamps `touched: YYYY-MM-DD` through `withMeta`, runs `lint --ids` on the
  result, and on failure writes the old text back and exits 2 with the problems.
- Bodies: `--body -` (stdin), `--body-file F`, or `--body "text"`; exactly one.
- Field values may not contain ` · ` or a newline (exit 2).
- The lock is held only across read, check and write; never across a subprocess.
- No new key is required; lint checks a new key only when present. Old files pass unchanged.

## Slice 1: the command layer and `show`

**Goal.** One module every writer shares, and a way to read one entry without grepping.

**Files.** New `src/commands.ts` (locate, `withEntry`, stamping, lint-and-rollback); `src/project.ts` (`Entry.hash`,
`EntryRef.entry`, `checkedEntry` by ID); `src/server.ts` (ops call `commands.ts`); `src/cli.ts`; `src/init.ts`.

**Commands.**
- `show ID… [--links] [--json]`: the raw entry, then `hash: <entry hash>`; `--links` adds "links out" (each meta link
  key and body mention, as `rel: ID title`) and "links in" (entries whose meta or body mention it), and `current:
  A205` when a supersession chain leads on (cycle-safe). JSON: `{id, kind, file, index, title, meta, body, raw, hash,
  links: {out: [{rel, id, title}], in: [...]}, current}`.
- `doctor [--fix]`: reports `.lock`, `*.tmp-*`, `.index.db`, `log/`, `proposals/` not ignored when the folder is
  committed, a stale `.lock`, duplicate IDs; `--fix` adds the lines to `.gitignore` (committed) or `.git/info/exclude`
  (private). `init` adds the same lines.

**Tests** (`test/commands.test.ts`). `show` hash equals `hashText(raw)`; `--links` lists in and out; `current` follows
`superseded-by` twice and stops on a cycle; `checkedEntry` with `entry` passes when another entry in the file changed
and fails when this one did; the server's `meta` op still 409s on a stale file hash; `doctor --fix` appends the lines
once.

**Docs.** README usage; SKILL.md: "read an entry with `show`, never grep".

**Done.** The UI's ops run through `commands.ts`; `show` works on iapetus for each kind.

## Slice 2: edit commands for tasks and entries

**Goal.** No hand edits for the daily moves, and the skill says so.

**Files.** `src/commands.ts`, `src/cli.ts`, `src/analyse.ts`, `skill/SKILL.md`.

**Commands.**
- `new T|Q|R|K "title" [--k=v]… [--body …] [--inbox] [--json]`: claims the ID and writes the whole entry in one locked
  step, appended to its file. T needs `priority` unless `--inbox` (`status: inbox`); K needs `link` and
  `consult-when`; R gets `status: proposed`; dates are filled. Prints the ID.
- `done T### [--outcome …]`: `completeEntry`, the body replaced by the outcome when given.
- `drop T### --reason "…"`: `completeEntry({dropped})`, `Dropped: <reason>` prepended to the body.
- `edit ID --if HASH [--title "…"] [--body …]`: `--if` required.
- `set ID k=v… [--unset k…] [--if HASH]`.
- `append ID --section Name --line "text"`: adds `- YYYY-MM-DD: text` under `**Name:**`, created at the end if absent.
- The PostToolUse lint hook's message gains one line naming the command that would have made the edit.

**Format.** `touched:` (date, optional, all files); `status: inbox` on todo, where `priority` becomes optional. Lint:
`REQUIRED` and `ENUMS` keyed per file; `status` on `todo.md` allows only `inbox`.

**Tests.** `new T` with and without `--inbox`; `new K` without `link` exits 2 and writes nothing; `done --outcome`
replaces the body and stamps `done` and `touched`; `drop` keeps the number; `edit` without `--if` exits 2; `set`
refuses ` · `; `append` creates the section once; a body mentioning `T999` is rolled back; two concurrent `new T` get
different IDs; lint accepts `status: inbox`.

**Docs.** SKILL.md gains the standing rule, scoped to this slice: "Make every change to `.remembrancer/` through the
CLI; edit by hand only when no command does the job, and run `remembrancer lint` after." "Getting IDs" becomes `new`;
the task bullets become `new`, `done`, `drop`, `set`, `append`, `edit`; question and answer bullets stay hand edits
until slice 3. format.md: the two keys. README: the commands.

**Done.** A day on iapetus with no hand edit of todo or done.

## Slice 3: questions, answers and rules

**Goal.** The multi-step edits that went wrong by hand.

**Files.** `src/commands.ts`, `src/cli.ts`, `src/analyse.ts`.

**Commands.**
- `answer Q### "title" --body … [--revisit-if "…"] [--closes Q…] [--amends A…] [--supersedes A…] [--partial] [--if HASH]`:
  the body must contain **Answer**, **Why** and **Alternatives considered** (colon or not); the command writes
  `**Question** <Q title> (Q###)` and the Q's body above it; A takes the Q's number; the Q and every `--closes` Q are
  removed in the same locked step. `--partial`: a fresh number, the Q stays with a History line `A### settles part of
  this`. `--supersedes` also sets `superseded-by` on the old answer.
- `decide "title" --body …`: `new A` with a fresh number; **Question** reads `(a decision; no question asked)`.
- `supersede OLD --by NEW`, `amend OLD --by NEW` (A or R): both ends set, lists extended; for R, `supersede` also
  retires the old rule.
- `rule R### activate|retire [--by R###]|challenge --question Q###|reviewed`: status plus a History line.
- `move ID --to archive`: `archiveEntry` for any file (year from `done`, `answered`, `added`).

**Format.** `amended-by:` as the inverse of `amends:`; lint reports a missing inverse for both pairs; `doctor --fix`
adds them.

**Tests.** `answer` removes the Q and the closed Qs and lints clean; a body without **Why** exits 2; `--partial`
leaves the Q with a History line; `supersede` sets both ends and retires an R; `rule challenge` without the Q mention
exits 2; `doctor --fix` adds `amended-by`.

**Docs.** SKILL.md: the answer, decision, supersede and rule sections become commands; the hand-edit exception narrows
to `scratch.md` and repairs. format.md: `amended-by`.

**Migration.** iapetus gains four inverse reports; `doctor --fix` clears them.

**Done.** A question answered and an answer superseded on iapetus by commands only.

## Slice 4: signals, waiting-on, plans, the brief

**Goal.** Growth can be seen and cleared; decisions waiting on Shaun are tracked.

**Files.** New `src/signals.ts`; `src/brief.ts`; `src/analyse.ts`; `src/cli.ts`; `src/project.ts` reads
`.remembrancer/config.json` (`{"owner": "shaun"}`, optional).

**Commands.**
- `stale [--days N] [--kind T|Q|A|R|K]`: entries whose effective date (`touched`, else the newest date key) is older
  than N (default: `THRESHOLDS` per kind) and that no active entry cites in meta or body.
- `waiting [--on WHO]`: entries with `waiting-on:`, grouped by name; `WHO` defaults to the owner.
- `plan T###`: the tree through `after:` (nested plans recurse; cycles reported), each child with `open|done|dropped`
  and its open blockers.
- `new Q … --waiting-on NAME`; `answer` and `done` clear it by removing the entry.

**Format.** `waiting-on:` (a word), `tags:` (comma-separated `[a-z0-9-]+`; `area:` is read as one more tag wherever
tags are read), `phase:` (free text), `done-when:` on plan tasks.

**Brief order.** Waiting on you; the current phase (the open plan with `phase:` whose `after:` has the most done
children, else the first P1 plan) and its next tasks; inbox count; proposed and challenged rules; one line from
`stale`; resources whose `consult-when` or `tags` share a word with the phase's tags; then today's sections, shortened.

**Tests.** `stale` ignores an entry cited by an open todo; `waiting --on` groups; `plan` reports a cycle and a nested
plan; the brief lists waiting entries first and names the phase; `area:` counts as a tag.

**Docs.** format.md: the four keys; SKILL.md: raise a question for the owner with `--waiting-on`; plans gain
`done-when:`.

**Done.** The iapetus brief opens with what waits on Shaun.

## Slice 5: `apply`, the proposals format, the opt-in knowledge base (replaces `triage`)

**Goal.** Any list of dispositions, from an agent or a curator, applied in one locked step with provenance.

**Files.** New `src/proposals.ts`, `schema/proposals.json`, `schema/action.json`; `src/cli.ts`; `src/project.ts`: a
`DIRS` list `["", "archive/", "kb/"]` drives `listFiles`, `isValidFile`, the server signature and lint's kind map by
stem; `kb/` is listed only when `config.json` has `"knowledge-base": true`. New `.remembrancer/log/curation.md`,
append-only, outside the parsed set.

**Format.** `proposals.json`:
```json
{ "mode": "manual", "packet": "<hash or null>", "made": "2026-10-07", "by": "claude|script",
  "actions": [ { "action": "archive", "id": "T079", "if": "<entry hash>", "importance": "low", "why": "…" } ] }
```
`mode` is `manual` (agent or human: every action), `gather` or `insight` (slices 9 and 11); the schema lists each
mode's allowed actions and `apply` enforces it. Actions now: `keep {id}` (stamps `touched`), `archive {id,
importance?}`, `drop {id, reason}`, `set {id, fields, unset?}`, `retag {id, add, remove}`, `link {from, rel, to}` (rel
in `refs|amends|supersedes|closes`, inverses set), `flag {id, note}` (sets `waiting-on: <owner>`, appends a History
line). `if` optional, `why` required.

**Command.** `apply FILE [--dry-run]`: validates every action against the schema, the mode and the project (unknown
ID, stale `if`, bad rel, action outside the mode); refuses the whole file naming each bad action; else computes every
file's new text in memory, writes under one lock, lints, rolls back on failure, logs one line per action. `move --to
archive` and `archive` go to `kb/<stem>.md` when the knowledge base is on, else `archive/<stem>-<year>.md`.

**Format changes.** `importance: high|normal|low`, `condensed-from:`, `condensed-into:` on moved entries;
`archive/<stem>-<year>.md` for every stem; `kb/<stem>.md`; `config.json` `"knowledge-base"`.

**Tests.** A stale `if` changes nothing and is named; `--dry-run` writes nothing; mixed actions over three files land
atomically and lint clean; one log line per action; `link supersedes` sets both ends; an unknown action and a
`condense` (undefined until slice 11) are refused; with the knowledge base on, `archive` writes `kb/answers.md` and
`show`, lint and the server read it; off, `kb/` is ignored even if present.

**Docs.** README: `apply`, the knowledge base switch; SKILL.md `curate`: write a proposals file, `apply --dry-run`,
`apply`; format.md: the keys, `kb/`, the log.

**Done.** A hand-written proposals file clears a dozen stale iapetus todos in one command.

## Slice 6: search

**Goal.** Ranked whole entries, widened by the graph, instead of grep.

**Files.** New `src/search.ts` (in-memory `bun:sqlite` FTS5, `tokenize='porter unicode61'`, columns `id, kind, title,
tags, body`, title weighted 3); `src/cli.ts`; `src/server.ts` (`/api/p/N/search?q=`).

**Command.** `search "terms" [--kind K] [--tag t] [--phase p] [--all] [--k 12] [--neighbours]`: FTS5 syntax passes
through; whole entries in BM25 order; each hit pulls in the end of its supersession chain and what it closes, marked
`via`; `--all` includes `archive/` and `kb/`; `--neighbours` adds each hit's in and out links (the wishlist's `ask`).
JSON: `{query, hits: [{id, score, via?, entry, neighbours?}]}`.

**Tests.** A hit on a superseded answer returns the current one marked `via`; "seeding" finds "seed"; `--kind` and
`--tag` filter; archive only with `--all`; the UI endpoint returns the same hits.

**Docs.** SKILL.md: "before answering a question, `search` it"; README.

**Done.** `search "re-seed crossing"` on iapetus lands on A205 in the top three.

## Slice 7: path and anchor drift

**Goal.** References to code stop going stale silently.

**Files.** `src/analyse.ts` (full lint only), new `src/anchors.ts`, `src/cli.ts`.

**Checks.** Cited paths: backtick and markdown-link candidates (the regex from `links.ts`, over raw bodies and
`link:`), resolved from the entry's file, the project root and the git root; a bare file name counts when one tracked
file ends with it. Anchors: definitions `anchor: name` (space) in `git ls-files` content minus `.remembrancer/` and
binaries; citations `anchor:name` in entries. Lint reports a cited anchor with no definition and a cited path with no
file. `anchors [--unused]` lists definitions and the entries citing each.

**Tests.** A fixture repo with one defined and one missing anchor and one moved file: lint names both; `lint --ids`
reports neither; `anchors --unused` lists the uncited one.

**Docs.** format.md: citing paths and anchors; SKILL.md: prefer an anchor where the code will move.

**Done.** Full lint on iapetus lists its stale paths (about 18 today).

## Slice 8: `check`

**Goal.** Rule checks run by a command, not goodwill.

**Files.** New `src/check.ts`; `src/analyse.ts`; `src/cli.ts`; `config.json` gains
`"check": {"test": "nix develop path:. -c sh -c '$(cabal list-bin iapetus-test) -p \"{name}\"'"}`.

**`enforced-by` forms.** `path: "name"` (today's form; `check` runs `check.test` with `{file}` and `{name}`), `cmd:
shell command` (`sh -c` from the project root), or a bare path (lint only; `check` reports "no runner"). Lint accepts
all three.

**Command.** `check [R###…]`: runs each machine form outside the lock; prints pass, fail (last 20 lines) or skipped per
rule; exit 1 on any failure; a pass sets `checked: today` under the lock. The brief says "checks: N pass, M fail, K
unrunnable"; attention treats `checked` like `reviewed`.

**Tests.** A fixture with `cmd: true` and `cmd: false`: pass and fail reported, `checked` stamped only on the pass; a
`test` rule without `check.test` is skipped with a message; lint accepts `cmd:`.

**Docs.** format.md: the forms and `checked:`; SKILL.md "before a review or commit": run `check`, then review the
property and heuristic rules by hand.

**Done.** `check` on iapetus runs the six tested rules.

## Slice 9: `curate` in gather mode, with the example curators

**Goal.** A packet a cheap model works through case by case, producing only clusters, tags, links, flags and
suggestions.

**Files.** New `src/curate.ts`, `schema/packet.json`; `src/proposals.ts` (`cluster`, mode enforcement); new
`curators/openai-compatible.ts` (env `REMEMBRANCER_LLM_URL`, `_MODEL`, `_KEY`), `curators/pi.sh` (the same prompt
through a Pi invocation), `curators/gather.md` (the system prompt); `src/cli.ts`.

**Packet.** `{ "packet": "<hash of the cases>", "mode": "gather", "made", "owner", "cases": [ { "case": "c12", "kind":
"stale|similar|inbox|drift", "evidence": "shared tag planner; 3 shared refs", "allowed": ["cluster", "retag", "link",
"flag", "archive"], "entries": [ { "id", "kind", "file", "title", "meta", "body", "hash" } ] } ] }`. Cases: stale
(from `stale`); similar (union-find over shared tags, shared refs, and each title as an FTS query against the rest
above a BM25 cut; at most 12 members); inbox; drift (slice 7's findings, rules unreviewed 90 days, answers whose
`revisit-if` words match a newer done or answered entry). Every entry is in at most one case; a case holds at most
about 6 KB of body text, so a small context fits it.

**Command.** `curate --mode gather [--scope active|archive|all] [--out F] [--curator "CMD"]`: writes the packet; with
`--curator`, pipes it to CMD's stdin, reads proposals from stdout, validates them with `apply --dry-run` and prints
the result, applying nothing. The script sends one chat request per case with `response_format: {type:
"json_schema", json_schema: schema/action.json}`, retries once on an invalid answer, and emits `mode: gather`.

**`cluster`.** `{ "action": "cluster", "case": "c12", "label": "crossing re-seeds", "members": [...], "why" }`: code
slugifies the label to `c-crossing-re-seeds`, adds it to each member's `tags:`, and logs the group. In gather mode
`archive` is applied as `set suggest: archive` plus a log line, never a move; `apply` refuses `condense`, `drop`,
`set` and `keep`.

**Tests.** The packet validates against its schema; no entry is in two cases; a similar case forms from shared tags;
`cluster` tags every member and lints clean; a gather file with `condense` is refused by name; a gather `archive`
moves nothing and sets `suggest`; the script, against a stub HTTP server, yields proposals `apply --dry-run` accepts.

**Docs.** README: the tiers and both curators; SKILL.md `curate`: `curate --mode gather`, read the packet, write
proposals (gather or manual), `apply --dry-run`, `apply`.

**Done.** Shaun's local model produces a gather file for iapetus that `apply --dry-run` accepts.

## Slice 10: evaluation of gather mode, and the queue (D1 decided: gather applies, insight queues)

**Goal.** A score table that says whether the cheap model may run unattended, and runs that apply nothing unseen.

**Files.** New `src/eval.ts`; `src/curate.ts`; `src/cli.ts`; `eval/iapetus-gather-1/{packet.json,gold.json}`,
written by the agent and corrected by Shaun.

**Commands.** `curate --eval DIR --curator CMD…`: per curator, precision and recall per action type (action and ID
set, never `why`), cluster agreement (best-match Jaccard of member sets against gold), dry-run acceptance rate, as a
table. `curate --curator CMD --queue` writes `.remembrancer/proposals/<timestamp>-<mode>.json`; `proposals [list]`,
`proposals show F` (by case, with titles), `proposals reject F --why "…"` (logged, moved to `proposals/rejected/`);
`apply F`. With D1 as recommended, `curate --mode gather --curator CMD --apply` applies when the dry run is clean.

**Tests.** A curator echoing gold scores 1.0, an empty one 0, a cluster off by one member below 1.0; `--queue` applies
nothing; `reject` logs; `--apply` refuses a failed dry run.

**Docs.** README: the eval procedure, the queue, a systemd timer for the daily gather run.

**Done.** Two local models compared on one iapetus gather packet.

## Slice 11: insight mode and `condense`

**Goal.** The weekly run by a strong model: condensing, merging, meaning across clusters.

**Files.** `src/curate.ts`, `src/proposals.ts`, `curators/insight.md`.

**Packet.** `curate --mode insight` adds case kinds `cluster` (entries sharing a `c-` tag, with the gather run's label
and `why` from the log), `chain` (supersession chains of two or more whose head is still cited) and `suggested`
(`suggest: archive`), and allows every action.

**`condense`.** `{ "action": "condense", "case", "from": [...], "into": { "kind": "T", "title", "fields", "body" },
"dest": "active|archive", "importance", "why" }`: `new` with `kind: theme`, `condensed-from:` and `refs:` listing the
members; each member moved with `condensed-into:`, its `c-` tag removed and `suggest:` cleared. Insight runs always
queue.

**Tests.** A cluster case carries its gather label; `condense` creates the theme entry and moves members atomically,
lints clean, clears the tag; an insight `archive` is a real move; the eval scores `condense` on `from` sets only.

**Docs.** README and SKILL.md: the weekly run, with the calling agent as the usual insight curator.

**Done.** One insight run on iapetus condenses a gather cluster into a theme entry Shaun accepts.

## Slice 12: the UI, kept small

Reading and search: the search box uses slice 6's endpoint; entries show tags, `touched`, `waiting-on`, `suggest`;
Attention lists waiting, inbox, stale and suggested entries. Basic locked operations only: today's, plus "mark stale"
(`suggest: archive`) and "close" on a question (the raw editor pre-filled with the answer's sections, saved through
`answer`). A Proposals tab lists the queue with show, apply and reject. Tests in `test/server.test.ts` per endpoint.

## Slice 13: the Claude Code mod (optional, late)

**Goal.** One install that gives `/rmb`, the three hooks and the refusal of direct edits, as a thin layer over the
CLI's `--json`. The mod runs the CLI with `$.process.run` and renders; it holds no logic of its own, because the mod
API is early access and the CLI is the stable part.

**Files.** New `mod/` in this repo: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`,
`types/index.d.ts` (the pane's state contract), `hooks/register.test.ts`; README install line (`claude --plugin-dir
mod`).

**Hooks.**
- `session.start`: registers `/rmb`; runs `brief --json` and, when a `.remembrancer/` exists, adds the brief's text
  as a session-scoped section through `prompt.compose` (replacing the `SessionStart` settings entry).
- `command.run` for `rmb`: no argument opens or refreshes the pane; `rmb waiting`, `rmb done T### …`, `rmb search …`
  run the CLI command of that name and return its text.
- `tool.call` on `Edit|Write|MultiEdit`: resolve `file_path` with `$.fs.stat(path, {resolve: true})`; a `realPath`
  under `<root>/.remembrancer/` other than `scratch.md` is denied, naming the command (the mod is where the refusal
  Shaun asked for lives; the plain hooks stay non-refusing per his answer 5). After an allowed edit under the folder,
  run `lint --ids --json` and toast the problems.
- `tool.call` on `Bash`: before, `guard --json COMMAND`, deny with its reason on exit 2; after, if the command names
  `remembrancer` or `rmb`, refresh the pane's atom from `brief --json`.
- `ui.render` for the pane: waiting on you; the current plan's next tasks; rules with challenged and proposed ones
  flagged and `checked` dates; a search box whose submit runs `search --json` and lists titles.

**What earlier slices must provide.** `brief --json` (slice 4) with a fixed shape: `{project, visibility, waiting:
[entry…], phase: {plan, next: [entry…]}, inbox, rules: [{id, title, status, form, checked, reviewed}], stale: {count,
byKind}, checks: {pass, fail, unrunnable}}`; `guard --json` and `lint --json` with `{ok, problems: [{file, id,
message}]}` on stdout even when exiting 2 (slice 1 sets this convention for every `--json` error); `search --json` as
in slice 6. These shapes are written in `docs/json.md` as each lands and covered by a test that parses the output.

**Tests.** `claude plugin test mod`: the Edit hook denies `.remembrancer/todo.md` and allows `scratch.md`; the Bash
hook denies when a stub `guard` exits 2; the pane renders from a fixture `brief --json`; `/rmb search` returns titles.

**Done.** `claude --plugin-dir mod` on iapetus shows the pane and refuses a direct edit.

## Migration note for existing projects

Nothing is rewritten. New keys are optional; `touched` falls back to the newest date; `area:` is read as a tag; lint's
new checks fire only on keys present, except the `amends`/`amended-by` inverse, which `doctor --fix` repairs; a
committed `.remembrancer/` needs the ignore lines `doctor --fix` adds; `enforced-by` values in today's form keep
working; `archive/*.md` files without the `<stem>-<year>` name are left alone; the knowledge base is off until
`config.json` turns it on, and `kb/` stays empty until a curation run fills it.
