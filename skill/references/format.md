# Remembrancer file format

All files live in `.remembrancer/` at the project root. Each file has a short preamble (a `#` title and one or two lines of guidance), followed by entries.

## Entries

```markdown
## <ID> · <title>
key: value · key: value · key: value

Body in markdown. Keep it short.
```

- The heading is `## `, the ID, ` · ` (a middle dot with spaces), then the title. The parser also accepts `-`, `—` or `:` as the separator. When you write a heading, use `·`.
- The metadata line comes directly after the heading. Keys are lowercase words with dashes, and pairs are separated by ` · `. Leave a key out when it has no value.
- A `## ` line inside a fenced code block is not a heading.
- IDs are a letter and at least three digits: `T001`, `Q014`, `A014`, `R003`. A 4th digit appears on its own after `999`.
- There are three number sequences: T, R, and Q and A together. An answer takes its question's number: Q014 is answered by A014. A decision that no question asked for takes a fresh number from the shared sequence.
- The next ID is one more than the highest number among entry headings (archive included) and `closes:` values. Get it from `remembrancer next`. Mentions in text never count, so a typo can't skip numbers.
- IDs are never reused or renumbered, so **an entry with an ID is never deleted**. A task is dropped to done.md (`dropped: yes`), a question leaves through an answer, and a rule is retired. `remembrancer lint` reports every number up to the highest that no entry uses. Fill a skipped number with a stub (for example `## A063 · Number unused`).
- Any ID written anywhere (in a body or in metadata) is a link in the UI. `remembrancer lint` reports mentions of IDs that do not exist.
- Dates are always `YYYY-MM-DD`.

## todo.md

Open tasks. Their order comes from `priority`, then from `after:`, then from file position.

| key | required | values |
|---|---|---|
| priority | yes | `P1` (next / urgent), `P2` (soon), `P3` (someday) |
| added | yes | date |
| after | no | the T IDs that must be done first |
| refs | no | related IDs |

```markdown
## T012 · Fix off-by-one in search pagination
priority: P1 · added: 2026-09-29 · after: T010 · refs: Q004, R003

Last page repeats the first item when total % pageSize == 0.
```

## done.md

Finished tasks, newest first. Keep the T ID and the original metadata, and add `done:`. The body records the **outcome** and any **findings** later tasks need. Leave out the story of how you got there.

A task abandoned rather than finished moves here too, with `done:` (the date it left the list) and `dropped: yes`. The body says why.

```markdown
## T010 · Add cursor pagination to search
done: 2026-09-28 · priority: P1 · added: 2026-09-20 · refs: A004, R003

Outcome: opaque base64 cursors (A004). Findings: the search index returns ties in unstable
order, so the cursor must include the doc id as a tiebreak. This led to R003.
```

Old entries are **curated**. Their lasting knowledge moves to answers or rules, and the entry moves to `archive/done-YYYY.md`, newest first.

## questions.md

Open questions that should not block the current work.

| key | required | values |
|---|---|---|
| asked | yes | date |
| context | no | the T ID, the A ID that raised it, or the area it came from |
| blocks | no | the T IDs that cannot finish until it is answered |

```markdown
## Q004 · Should cursors be opaque, or encode the sort key?
asked: 2026-09-21 · context: T010

Opaque is simpler for clients, but it hides the sort key from debugging.
```

When a question is answered, **delete** it here and write the A entry that closes it. That is the only way a question leaves. A question abandoned as not worth answering still gets a short answer that says so.

Progress that doesn't settle the question goes in its body as a dated line under **History:**, citing the answer (`- 2026-09-30: A088 settles the first half.`).

When a question turns out to have separate parts, split it into narrower questions before answering them one by one.

## answers.md

| key | required | values |
|---|---|---|
| answered | yes | date |
| revisit-if | recommended | the condition that would make the answer worth reconsidering |
| closes | no | other Q IDs this answer settles (An closes Qn without saying so) |
| amends | no | the A IDs this answer changes; both still stand |
| supersedes | no | the A ID this answer replaces; the old one no longer stands |
| superseded-by | no | on a replaced answer: the A ID that replaced it |
| refs | no | related IDs, including partial answers to the same question |

The body must contain **Question**, **Answer**, **Why** and **Alternatives considered**.

Which answer closes a question:
- Each question has exactly one current closing answer: An, or the answer that lists it in `closes:`. `remembrancer lint` reports a question closed by two answers, unless one is superseded.
- One answer can close several questions: the answer takes one of their numbers and lists the rest in `closes:`.
- When several answers settle parts of one question, the answer that settles the last part closes it and lists the earlier ones in `refs:`. A partial answer never uses `closes:`.

```markdown
## A004 · Opaque base64 cursors with a doc-id tiebreak
answered: 2026-09-24 · revisit-if: clients need to build cursors themselves · refs: T010

**Question** Should cursors be opaque, or encode the sort key? (Q004)

**Answer** Opaque base64 JSON of {sortKey, docId}.

**Why** Clients never parse them, and we can change the encoding freely.

**Alternatives considered** A plain offset breaks under concurrent inserts. An exposed sort key leaks the schema.
```

## rules.md

Rules are the curated core. Keep them few, precise and current.

| key | required | values |
|---|---|---|
| scope | yes | `code`, `design`, `agent` (how AI agents should work here), `process` |
| form | yes | `invariant`, `property`, `heuristic`. The strongest form that is true (see below) |
| status | yes | `proposed`, `active`, `challenged`, `retired` |
| added | yes | date |
| reviewed | no | the date the rule was last checked against real work |
| revised | no | the date the rule's text last changed |
| source | no | the IDs or incident that led to the rule |
| enforced-by | no | the test or check that encodes it: `path/to/test.ts: "test name"` |
| supersedes | no | the R ID this rule replaces |
| superseded-by | no | on a retired rule: the R ID that replaced it |

The three forms:
- **invariant**: must always hold, and a machine can check it. The goal is a test, recorded in `enforced-by`.
- **property**: precise and checkable, but by a human or agent reading the code or the design.
- **heuristic**: guidance that needs judgement. It is a candidate for sharpening into a property.

The body has the rule itself (stated as a property where possible), then **Why:**, **Check:**, and an optional **History:**. Put a blank line between these sections so that each renders as its own paragraph.

```markdown
## R003 · Pagination cursors round-trip and are stable under ties
scope: code · form: invariant · status: active · added: 2026-09-24 · reviewed: 2026-09-29 · source: T010, A004 · enforced-by: test/cursor.test.ts: "cursor round-trips"

For every cursor c: decode(encode(c)) == c. For any result set with equal sort keys, paging
through it yields every document exactly once.

**Why:** T010 shipped with duplicate rows on tied scores.

**Check:** run the property test; any new sort field must be added to the cursor.

**History:**
- 2026-09-27 revised: added the tie clause after Q006 showed duplicates on equal scores.
```

```markdown
## R007 · Re-read the failing test output before a second fix attempt
scope: agent · form: heuristic · status: active · added: 2026-09-15 · source: T004, T009

After one failed fix, the agent must quote the actual failure before it edits again.

**Why:** Twice the agent "fixed" a different error from the one the test reported.

**Check:** in review, each repeated fix commit cites the failure it addresses.
```

Challenging and replacing a rule:
- `status: challenged` means work has cast doubt on the rule. An open Q must mention the rule's ID.
- When the rule is revised in place, bump `revised:` and add a dated line under **History:**.
- When the rule is replaced, mark the old one `status: retired · superseded-by: R012`, and give the new one `supersedes: R003`.

## scratch.md

Free-form notes for one session, under a `# Session YYYY-MM-DD` heading. At the start of the next session, move anything worth keeping into the other files, then reset scratch.

## archive/

`archive/done-YYYY.md` holds curated done entries, grouped by the year of their `done:` date, newest first. The entries keep their IDs, so old links still resolve.
