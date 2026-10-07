# Review of the first insight run (iapetus, 2026-10-07)

*Opus 5.5 as the insight curator over 117 cases after an Opus gather pass. Reviewed by Shaun and the lead; the run was
rejected as a test of the method, its real findings raised in iapetus as questions. To act on when remembrancer is
next worked on.*

## What it produced

163 actions after stale ones were dropped: 20 condense, 35 archive, 18 flag, 23 link, 6 cluster, 61 keep.

## Findings

1. **Condensing did not condense.** Themes averaged about 110% of their sources' length (83% to 133%). They were
   faithful: the one read in full cited every fact and invented no reason (its **Why:** came from a source's prose).
   But a faithful merge of two entries into one of the same size cuts the ID count, not the reading.
2. **The value was in the flags that read across the record:** a contradiction between two rules, a `revisit-if` that
   had come true, a decision contradicted by a later review. That is derive mode's work (`docs/derive.md`).
3. **A third of the flags were an agent's work:** "find where this cited file moved". Path drift is lint's finding and
   an agent's fix, never an owner's decision.
4. **Legacy-era entries were treated as live.** In a project rebuilt beside a frozen old version, answers about the old
   code got `revisit-if` checks nobody will act on. The record has no notion of an entry's era.
5. **Records edited during a run made the whole proposals file refused** (51 actions on changed entries). Every answer
   survived in the partial file, but recovering it took manual stripping.

## Fixes to make

- **Stale actions:** `apply` and `proposals add` drop actions whose entries changed (or vanished), report the count and
  the IDs, and keep the rest; `curate` warns at the end of a run when the records changed since its packet.
- **Condense only when it shortens:** a theme must be meaningfully shorter than its sources and remove real repetition;
  `apply` checks the length ratio (a stated bound, in config) and refuses a condense over it; the prompt says so.
- **Path drift becomes an agent action** (re-point a citation, by `set` or `edit`), never a flag to the owner; insight
  cases for drift allow only that.
- **An era marker:** `era: legacy` (or any project's name for a superseded generation), set by gather or triage;
  insight skips `revisit-if` checks on such entries, and archiving them is their natural move.
- **Move the `revisit-if` and contradiction checks to derive mode,** and drop them from insight's flags.
