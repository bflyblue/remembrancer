# Requirement: a derive mode, for knowledge rather than condensing

*2026-10-07. Shaun asked for curation that derives knowledge; gather (grouping) and insight (condensing) do not. To
be built another time. A requirement, not a design: the design and its plan come when it is built.*

## The need

Gather finds groups and insight merges them, one small case at a time. Neither reads *across* the record, so neither
can say what the record teaches: the lesson behind several mistakes, the rule a run of answers implies, the two
decisions that quietly disagree. That is the knowledge Shaun wants extracted, and the reason to spend a strong model
(Fable) on curation at all.

## What it must produce

Each output is a proposal in the queue, never applied unseen:

1. **Lessons as proposed rules.** A pattern across tasks, answers and falls ("a mechanism was built on a difference
   inside its noise", which became R020) written as a rule with **Why:** and **Check:**, `status: proposed`, its
   `source:` the entries it was drawn from. Only the owner makes a rule active.
2. **Challenges to existing rules.** Where the record contradicts a rule, or has outgrown it: a question that names the
   rule and the evidence, as the skill's challenge procedure asks.
3. **Contradictions and drift between answers.** Decisions that conflict; an answer whose `revisit-if` has come true by
   a later entry; a chain where a superseded answer is still cited as current.
4. **Unasked questions.** Questions the record implies but never raised, as open questions with their context.
5. **Syntheses per area.** "What we know about X, and why": a short entry of what is settled, what is open and the
   reasons, every claim citing the entries it rests on. A synthesis links to its evidence; it does not replace it
   (that is insight's job).

## Constraints

- **Input is whole areas, not small cases.** An area is a topic (a tag, an `area:`, a cluster family, or a search
  result set), with every active entry in it and the archived ones it cites, in full text. It is sized for a strong
  model's context, not a small one's.
- **Every claim cites its evidence by ID.** A proposal whose claims cite nothing is refused by `apply`, as a condense
  that names no source is today.
- **Nothing is rewritten.** Derive only adds: rules (proposed), questions, links, flags, and synthesis entries. It
  never edits, moves, condenses or drops an existing entry.
- **Decisions are reported, not made.** A contradiction or a challenge goes to the owner as a question or a flag; the
  curator never resolves it.
- **The queue always.** Derive runs are never applied with `--apply` (D1's reasoning: they write text).
- **Strong model by default.** It is meant for Fable or similar; no benchmark is built for it (as for insight): the
  owner's review of each queued run is the check.
- **Cost stated before running.** The packet's areas and their token sizes are shown before a curator is called, so
  the owner can choose which areas to derive.

## Open for the design

- How areas are formed: by tag and `area:`, by gather's clusters grouped further, or by a search the owner gives
  (`curate --mode derive --area "crossing"`).
- Whether a synthesis is its own kind of entry (`kind: synthesis` on a K or an A) and how it stays current as its
  evidence changes (a `stale` signal when a cited entry changes after it).
- Whether the calling agent should run derive in-session (as the skill's weekly insight procedure does), rather than
  through a curator command, since it needs the strongest reading.
