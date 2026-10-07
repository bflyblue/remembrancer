# Wishlist and design: remembrancer as a shared tool

*2026-10-07. Shaun and the lead agent, after a long day's use on iapetus (about 100 open tasks and questions, 5,000
lines of answers, 20 rules, several agents working in parallel). A design to review, not a decision. Fable reviews it
and writes the execution plan in `docs/plan.md`.*

## What worked, and what hurt

**Worked:**
- IDs claimed under a lock: parallel agents never collided.
- Answers with **Why**, **Alternatives** and `revisit-if`: a chain of three answers amending and superseding each other
  stayed readable, and an old design failure was found in the record, not in anyone's memory.
- Rules that carry a check, and the brief at session start.

**Hurt, worst first:**
1. **Editing is done by hand.** Moving a task to done, answering a question, superseding an answer: the agent wrote ad
   hoc perl each time. It's error-prone (an entry belonging to another session was once deleted), slow, and costly in
   tokens, and edits take no lock.
2. **It only grows.** Nothing signals staleness, so the active files fill with work that no longer matters, and the brief
   can only show the top few.
3. **Decisions waiting on the owner aren't tracked.** On one day about fifteen lived only in chat.
4. **Reading costs too much.** Agents grep a 5,000-line file, and as it grows the record slips out of even a good
   agent's focus.
5. **References to code go stale silently.**
6. **Rule checks are never run** by anything but the agent's goodwill.

## Principles

- **Markdown stays the source of truth** for the active set: readable, diffable, hand-editable, committed with the code.
  Anything else (indexes, the knowledge base's database) is derived or holds what the markdown has handed over.
- **Code does mechanics; a model does judgement.** Locking, IDs, links, staleness, clustering candidates, validation and
  atomic writes are code. Deciding what a cluster means, what to condense, and what is still valuable is a model's, and
  that model is swappable.
- **Every write is a command:** locked, hash-checked against what the caller read, linted after. Agents stop editing the
  files directly; the PostToolUse hook stays as a safety net for hand edits.
- **Nothing with an ID is lost:** condensed or archived entries keep resolving through the graph.

## 1. Commands that take the editing off the agent

All writes take `.remembrancer/.lock`, refuse a stale write (the entry's hash must match what `show` returned, passed
back as `--if HASH`; omitted means "current"), splice through `spliceEntry`, stamp `touched:`, and run lint on the
result. Bodies come from `-` (stdin) or `--body-file`.

| Command | Does |
|---|---|
| `new T\|Q\|R\|K "title" [--field k=v]… [--body -]` | claim and write a whole entry in one step; `--status inbox` for quick capture |
| `done T### --outcome -` · `drop T### --reason "…"` | move a task to done, stamped, with its outcome or reason |
| `answer Q### --answer - --why - [--alternatives -] --revisit-if "…" [--closes Q…] [--partial]` | turn a question into its answer, removing the question, closing others |
| `decide "title" …` | an answer no question asked for (fresh number from the Q/A sequence) |
| `supersede A### --by A###` · `amend A### --by A###` | set both ends of the relation |
| `set ID k=v… [--unset k]` · `append ID --section History -` | change fields; add a dated line to a section |
| `rule R### activate\|challenge --question Q###\|retire --by R###\|reviewed` | a rule's life, with its history line |
| `move ID --to archive/<file>` | for curation and hand tidying |
| `show ID… [--links]` | whole entries, their hash, and what links to them (in and out) |
| `search "terms" [--kind] [--tag] [--phase] [--all]` | ranked whole entries (section 4) |
| `plan T###` | a plan task's tree of children with each one's state and blockers |
| `waiting [--on WHO]` | entries waiting on someone, grouped |
| `stale [--days N] [--kind]` | entries not touched for N days |
| `triage FILE` | apply a disposition table (keep, merge, drop, archive) in one locked step |
| `check [R###…]` | run the rules' machine checks (section 6) |

Every command prints JSON with `--json`, for agents and for the UI.

## 2. Signals, so growth can be cleared

New metadata keys, maintained by the commands:
- `touched: YYYY-MM-DD`: the last command that changed the entry.
- `phase:` (free text, such as `A` or `B`); `tags:` (comma-separated words); optional `owner:`.
- `status: inbox` for tasks captured quickly; the brief shows the inbox count, and triage promotes or drops them.

Capture stays loose, since losing things is what the tool exists to stop; clearing is made cheap: `stale` lists what has
sat untouched, and `triage` applies a whole table of dispositions at once.

## 3. `waiting-on`

A field on any entry: `waiting-on: shaun` (any name). The brief lists these first, under "waiting on you", and `waiting`
groups them by who. A question raised for the owner is created with it; answering clears it.

## 4. Reading: show, search, and a knowledge base

**Index.** A SQLite database (`bun:sqlite`) at `.remembrancer/.index.db`, git-ignored, rebuilt from the markdown and the
knowledge base whenever a file's hash changes. It holds:
- entries (ID, kind, title, metadata, body, file, hash, touched);
- typed edges: `refs`, `after`, `closes`, `supersedes`/`superseded-by`, `amends`/`amended-by`, `source`, `cites`
  (a mention in the body), `anchored-in` (section 5), `about` (a tag), `condensed-from`;
- an FTS5 table over titles and bodies.

**Search** ranks by BM25 and widens by the graph: a hit pulls in what supersedes it and what it closes, so an agent
asking about an old decision lands on the current one. Embeddings are a later, optional backend (a local model through
an embedding command, stored beside the FTS table), added only if lexical search measurably misses.

**The knowledge base.** The active files keep what the current work needs: open tasks of the current phase, open
questions, recent and still-cited answers, all rules, the resources. Everything else lives in `.remembrancer/kb/`, as
markdown entries in the same format with two more fields:
- `importance: high | normal | low`;
- `condensed-from:` the IDs an entry replaced.

It is committed like the rest, readable by hand, and fully indexed, so `show` and `search` find its entries as easily.
Moving an entry to the knowledge base is not deleting it: its ID resolves there.

**Asking.** `ask "question" [--k 12]` returns the top-k entries with their linked neighbours, as a packet for the calling
agent to judge relevance and answer from: the retrieve, then judge, then answer loop, with the judging done by whichever
model is asking.

### Why not OWL

OWL's strength is logical class membership and reasoning over it. The questions here are "what is relevant", "what is
stale", "what has been overtaken", which a typed property graph and full-text search answer directly. What is worth
borrowing from OWL is its vocabulary of properties: typed relations, declared inverses (`supersedes` and
`superseded-by` kept in step by the code), and transitivity where it holds (a chain of supersessions resolves to its
last).

## 5. Anchors in code

Entries cite code by **anchor**, a stable name placed in a comment: `-- anchor: capture-entry-rows` (any comment syntax;
the scan looks for `anchor:` followed by a kebab-case name). An entry cites it as `anchor:capture-entry-rows`. Lint scans
the project's tracked files (`git ls-files`, so it is fast and ignores builds) and reports:
- a cited anchor missing from the code: the code moved or went, so the entry is stale;
- an anchor no entry cites: noise, or a decision to record.

Anchors are names, not IDs, so they work even where `.remembrancer/` is private and its IDs must stay out of the code.
Paths in backticks stay as they are, and lint also reports cited paths that no longer exist.

## 6. Running the rules' checks

The prose stays for the model to read. The `enforced-by:` field gains a machine form:
- `enforced-by: test "R009 nothing names a body"` — a test name; or
- `enforced-by: cmd "scripts/check-units.sh"` — a command.

A per-project `.remembrancer/config.toml` (or json) maps `test` to how this project runs one:

```toml
[check]
test = "nix develop path:. -c sh -c '$(cabal list-bin iapetus-test) -p \"{name}\"'"
```

`check` runs every machine-checkable rule, reports pass or fail per rule, and bumps `reviewed:` on a pass. A rule
without a machine form stays the model's to check, and the brief says which kind each rule is.

## 7. Curation, with a swappable curator

Curation is three steps, and only the middle one needs judgement:

1. **`curate [--scope active|kb|all] [--out packet.json]`** (code) builds a work packet of candidates:
   - stale entries (untouched N days, not cited by anything active);
   - clusters: entries sharing tags, links or similar text (FTS similarity over titles and bodies), each with its
     members' full text;
   - chains: supersession and amendment chains that could collapse to their last;
   - drift: entries citing missing anchors or paths, rules unreviewed for 90 days, answers whose `revisit-if` names
     something now true (flagged by text match for the model to judge);
   - the inbox.
2. **The curator** (any agent, or a local model) reads the packet and writes a proposals file: a list of actions.
3. **`apply proposals.json [--dry-run]`** (code) validates every action, checks each touched entry's hash against the
   packet's (refusing stale ones by name), writes them all under one lock, and records provenance.

**The proposals format (JSON),** each action one of:
- `condense`: `{ into: { kind, title, fields, body, importance }, from: [IDs], dest: "active" | "kb" }`. The new entry
  takes a fresh ID, records `condensed-from`, and each source moves to the knowledge base marked `condensed-into`.
- `archive`: `{ id, importance, reason }`: move to the knowledge base.
- `retag`: `{ id, add: [], remove: [] }` · `link`: `{ from, rel, to }` · `set`: `{ id, fields }`.
- `drop`, `close`, `flag` (`{ id, note }`, for a human to look at).

Each action carries a one-line `why`, kept in the provenance log (`.remembrancer/kb/curation-log.md`).

**Swappable by design.** The packet and the proposals are files with a published JSON schema
(`schema/packet.json`, `schema/proposals.json`), so any curator works:
- the calling agent: run `curate`, read the packet, write proposals, run `apply`;
- a command: `curate --curator "CMD"` pipes the packet to CMD's stdin and reads proposals from its stdout. A local model
  works through a small script, so Shaun's cheap local LLM fits as one.

**Background runs.** `curate --curator "CMD" --queue` writes the proposals to `.remembrancer/proposals/<timestamp>.json`
as pending, applying nothing. `proposals` lists them, `proposals show F` renders them for a human, and `apply F` or
`reject F` disposes. A cron job or a systemd timer can then curate overnight, with nothing applied unseen.

**Evaluating models.** `curate --eval DIR --curator "CMD"…` runs several curators on the same packet and scores each
against a gold proposals file, written by the agent or by Shaun:
- precision and recall on actions;
- agreement on clusters;
- whether `apply --dry-run` accepts it.

The score table is the way to compare open models at curation, and decide whether a cheap one may run unattended.

## 8. Plans and scratch

- A plan stays a parent task with `after:`. It gains `done-when:` and `phase:`, and `plan T###` shows the tree. A
  roadmap's phases can be plan tasks, and the brief shows progress through the current one.
- `scratch.md` stays, for odds and ends that belong nowhere else.

## 9. The brief, revised

In order: waiting on you; the current phase's plan and its next tasks; the inbox count; rules challenged or proposed;
what `stale` and `check` last said, in one line each; resources matching the current phase's tags.

## Suggested order, by value

1. The edit commands, `show`, `waiting-on`, `touched` (sections 1 and 3): they remove today's worst friction.
2. Signals, `stale`, `triage`, the inbox, plans and phase (sections 2 and 8), and the revised brief (section 9).
3. The index, `search` and `ask` (section 4, without the knowledge base yet).
4. Anchors and `check` (sections 5 and 6).
5. The knowledge base, curation and its proposals format (sections 4 and 7), then the background queue and evaluation.

## Questions for Shaun

1. Should the UI gain the same commands (the server already writes through the lock), or stay a browser with its current
   edits?
2. Should the knowledge base be committed (as proposed), or kept private beside a committed active set?
3. Which local model and runner should the curator script target first (llama.cpp, ollama, or something else), so the
   example script works on your machine?
4. Should the skill tell agents to stop editing the files directly once the commands exist, with the hook refusing
   direct edits?

## Shaun's answers (2026-10-07)

1. **The UI stays small.** It is used to see outstanding tasks, to search questions and answers, and to watch the rules.
   Favour reading and search; add only basic operations (close a task, mark an item stale, and similar), and every
   write honours the lock.
2. **The knowledge base is opt-in.** Often `.remembrancer/` is not committed at all, only allowed in the project. The
   knowledge base's markdown is text; the index (`.index.db`) is binary, so it is always git-ignored and rebuilt. A
   project turns the knowledge base on in its config; without it, `search` and `show` index the active files and
   `archive/`, and curation's `archive` action moves entries to `archive/` as today.
3. **Local models run through Pi** (Shaun's agent), served over an OpenAI-compatible API; the model is "opus 3.8 flash
   infer", good for its size. The example curator should target an OpenAI-compatible endpoint (URL, model and key from
   the environment), and a Pi invocation as a second example.
4. **Two tiers of curation:**
   - **Gather, daily or more often, by the cheap local model:** find patterns and group similar entries together:
     cluster, tag, link, flag stale, suggest archiving. **No major rewrites:** it may not write new entry text beyond a
     cluster's short label.
   - **Condense and find insight, once or twice a week, by Opus or Fable:** condensing, merging into new entries,
     finding meaning across clusters.

   So the proposals format has modes, and `apply` enforces them: a run in `gather` mode may only `cluster` (a new action:
   a named group with members, stored as tags and links), `retag`, `link`, `flag` and `archive` (to suggest); `condense`
   and new entry text are refused unless the run is in `insight` mode. The gather runs' clusters become the insight
   runs' input.
5. **Agents are strongly discouraged from editing the files directly** once the commands exist. The skill's instructions
   say to make every change through the CLI, and the lint hook stays as a safety net for hand edits.

## Side goal: a Claude Code mod

*Added 2026-10-07 at Shaun's request.* Claude Code's mods
(https://github.com/anthropics/claude-code/blob/main/mods/README.md) are plugins whose behaviour lives in a TypeScript
hooks module, `register(on, options)`, hooking the engine's events as `($, e, next)`. They can:
- register commands;
- run processes;
- open panes beside the transcript, as the built-in `/diff` mod does;
- carry tests run with `claude plugin test`.

They are early access, and the API may change between releases. A remembrancer mod, as a thin layer over the CLI's
`--json` commands, could:
- **Open a pane, `/rmb`:**
  - what is waiting on you;
  - the current plan's next tasks;
  - the rules, with the challenged and proposed ones flagged;
  - a search box;
  - refreshing whenever Claude runs a remembrancer command (as `/diff` refreshes on edits).
- **Fold in the three hooks:** the session brief, lint after edits, and the commit guard, so one install replaces the
  `settings.json` entries.
- **Enforce the rule against direct edits (answer 5):** an agent's edit to `.remembrancer/` is refused, naming the
  command to use instead, rather than relying on the skill's wording alone.
- **Register composer commands:** `/rmb waiting`, `/rmb done T###`, `/rmb search …`.

To be built late, after the commands settle, since it depends on their JSON and on an API that may change. The built-in
mods' source (`mods/diff` especially) is the reference.
