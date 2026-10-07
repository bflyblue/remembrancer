# Review of the wishlist design

*2026-10-07. A review of `docs/wishlist.md` against the code, the format and the iapetus instance (66 todos, 37
questions, 169 answers, 20 rules; 700 KB of markdown). The plan is in `docs/plan.md`.*

## Verdict

The direction is right: commands replace hand edits, markdown stays the truth, judgement is a swappable model. Two
things are over-built (an on-disk index, `triage` beside `apply`), several details conflict with the code, and the
curator format needs shaping for a small model. All are fixable without changing the value order, except that `apply`
moves up to step 2.

## Measurements that change the design

- **Parsing is not the cost.** `lint` and `brief` over iapetus's 700 KB take 19 ms. An index "rebuilt whenever a
  file's hash changes" would rebuild on nearly every call, since agents write constantly, and gain nothing. The cost
  that hurt is *tokens*: agents grepping 5,000 lines. `show` and `search` fix that; a database file does not.
- **The format is already extended by hand.** iapetus uses `area:` on 185 entries, `kind: theme` on condensed done
  entries (members in `refs:`), `legacy-id:`, `provisional:`, `amended-by:` and `blocks:`. Lint tolerates unknown
  keys, so new optional keys break nothing. The plan adopts the existing conventions: `area:` counts as a tag, and
  `condense` produces `kind: theme`.
- **Path drift is real now.** Of 38 distinct backtick paths cited in todo, rules and answers, 18 do not resolve
  (`lib/Iapetus/Solver/Crossing.hs`, `long-burns.md`, bare names like `Burn.hs`). A lint for cited paths pays at
  once; anchors can follow.
- **Answers are thinner than the format says.** 117 of 169 lack **Why** and **Alternatives considered**; lint checks
  only **Question**. The `answer` command must require all four sections, and lint should accept both heading styles
  in use (`**Why**`, `**Why:**`).
- **The committed folder leaks tool files.** On iapetus nothing ignores `.lock`, `*.tmp-*` or a future `proposals/`.
  `init` and a `doctor` command must add those lines to `.gitignore`.

## Conflicts with the code

1. **Hash unit.** `EntryRef` carries the *file* hash and the entry's *index*. With several agents on one 5,000-line
   `answers.md`, every command invalidates every other agent's `show`. Commands should locate entries by ID and check
   the *entry's* hash (`hashText(e.raw)`), passed as `--if`. `checkedEntry` accepts either form, so the UI keeps
   working unchanged.
2. **`--answer - --why -`** cannot both read stdin. One body (`--body -`, `--body-file`, or `--body "text"`) holds the
   sections; the command prepends **Question** from the Q and validates the headings.
3. **`enforced-by` forms.** Lint takes the value's first token as a path that must exist, so `test "…"` and `cmd "…"`
   would be reported as missing files. The existing `test/Rebuild.hs: "name"` form already *is* the test form (six
   iapetus rules use it); keep it, add `cmd: …`, and teach lint and `check` both.
4. **`status: inbox`** collides with lint: the `status` enum is checked on every entry, and `priority` is required on
   todo. Lint's enums and requirements must become per-file.
5. **The lock** is broken after 10 s of age by any waiter. `check` (minutes of tests) and `curate --curator` (minutes
   of model time) must run outside it; `apply` computes every new file text in memory, then writes briefly.
6. **New directories** (`kb/`) need `isValidFile`, `listFiles`, the server's change signature and lint's kind map.
   Make one `DIRS` list drive all four, with `kb/<stem>.md` mirroring the active stems.
7. **`·` in values.** `set` must refuse values containing ` · ` or newlines; the meta line is split on that separator.
8. **UI writes** already go through the lock and hash check. Keep them; route the server's ops through the new command
   functions so `touched:` is stamped the same way.
9. **The private-ID guard** is unaffected by anchors (names, not IDs). One trap: a *private* project whose test is
   named `"… (R009)"` cannot commit it; the skill should say to name tests without IDs there.
10. **The lint hook** stays as the safety net (Shaun's answer 5); no refusing hook. The skill carries the instruction,
    updated in the first slice that ships write commands and widened as each slice adds more.

## Over-built, and simpler forms

- **`kb/`.** Shaun has made it opt-in, which is right; built as above it is one list entry, not a second system.
- **`triage FILE` and `apply proposals.json`** are the same command. One proposals format from the start, used by
  agents, curators and later the UI. `apply` moves to step 2 with the simple actions; `condense` joins it in step 5.
- **The on-disk SQLite index.** Build an *in-memory* FTS5 table per call (`bun:sqlite` 3.53 has FTS5; verified):
  no file, no staleness, no rebuild logic, and FTS5's tokeniser, porter stemming and BM25 come free; a few ms for 400
  entries. This is the strongest form of "always git-ignored and rebuilt": there is nothing to ignore. `doctor` still
  ignores `.index.db`, so persisting the same table later is safe.
- **`ask`** is `search --neighbours --json`. **`decide`** is `new A`. **`curate --eval`** starts as a script over
  `apply --dry-run`, promoted to a command when the scoring settles.

## The curator: what a small model can produce

The packet as written (every cluster with full text) is hundreds of KB; a 7–14B model cannot read it in one prompt.
Shape it as **independent cases**: each self-contained (its entries' full text, the evidence, the actions allowed),
so a curator script loops over cases with one small prompt each, and the calling agent reads it the same way.
Proposals reference the case and copy its entry hashes into `if:` fields; `apply` refuses stale ones by name.

Publish a schema **per action** (`schema/action.json`), not only per file: OpenAI-compatible servers (llama.cpp,
ollama, Pi's) constrain output to a JSON schema, which turns "can the model emit valid proposals" from a hope into a
guarantee. Shaun's two tiers map onto the actions cleanly, carried as `mode`:
- **gather** (cheap, daily): `cluster`, `retag`, `link`, `flag`, and `archive` *as a suggestion*. All are
  classification, none writes entry text beyond a cluster's label, which code slugifies into a tag. A gather-mode
  `archive` lands as `suggest: archive` on the entry, not as a move, so the cheap model never relocates anything.
- **insight** (Opus or Fable, weekly): everything, plus `condense` and real moves. Its packet gets the gather runs'
  clusters as ready-made cases (entries sharing a cluster tag), which is how the tiers connect.

`cluster` stores nothing new: a tag on each member (`c-<label>`) and one log line; n² `refs:` between members would
be noise. `flag` sets `waiting-on: <owner>` and appends a History line. Evaluate gather mode first: its actions are
checkable by ID sets alone, and "may the cheap model run unattended" is answered there. `Bun.hash` is stable across
processes, so an overnight packet survives. Provenance goes to a plain log outside the parsed set.

## Smaller points

- `touched:` is fine; when absent, fall back to the newest date on the entry, so old files need no migration.
- A passing machine check stamps `checked:`, not `reviewed:`, which means a reader compared the rule with real work.
- `done --outcome` replaces the body (iapetus's done bodies are outcomes); without it the body is kept, as the UI does.
- `waiting-on` needs an owner: `.remembrancer/config.json` with `"owner"` (JSON, no parser), read by `waiting`,
  `flag` and the brief.
- `supersede` and `amend` set both ends; lint checks both inverses; `doctor --fix` adds missing ones (iapetus has 6
  `amends:` and 2 `amended-by:`).
- Anchors: a definition is `anchor: name` (space), a citation `anchor:name`; scan `git ls-files` minus
  `.remembrancer/`, 8 ms on iapetus's 685 files, in full lint only.

## The Claude Code mod

Right as a late, optional slice, and only as a thin shell: the mod API is early access and may change between
releases, so every decision stays in the CLI and the mod spawns it (`$.process.run`) and draws. Three things bear on
it. First, it is the one place a *refusal* of direct edits lives (the wishlist's side goal asks for it; Shaun's
answer 5 keeps the plain hooks non-refusing), done on the resolved real path so a symlink cannot slip past. Second,
it needs `--json` shapes that do not move: `brief --json`, `guard --json`, `lint --json`, `search --json`, each
written down and tested from slice 1 on, with errors reported on stdout as JSON even when the exit code is 2. Third,
refresh is cheap: re-run `brief --json` (18 ms) after any Bash call naming `remembrancer`, rather than watching files.

## Shaun's answers, and what stays open

His answers settle the UI (small: reading, search, rules, basic locked operations; the plan's last slice follows
that), the knowledge base (opt-in), the runner (OpenAI-compatible endpoint from the environment, a Pi invocation
second), the two tiers, and direct edits (discouraged by the skill, not refused). One thing remains his:

- **Gather runs apply directly, insight runs queue?** Recommended, since every gather action is reversible metadata;
  the alternative queues both.
