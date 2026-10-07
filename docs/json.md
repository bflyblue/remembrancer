# JSON output

Shapes printed with `--json`, kept stable for scripts and the Claude Code mod. Each is covered by a test that parses
it. Added to as each slice lands.

## Errors

Any command run with `--json` that fails prints, on stdout, as well as one line on stderr:

```json
{ "ok": false, "error": "no entry T404", "problems": [] }
```

Exit 1 for an error (an unknown ID); exit 2 for a refused or stale write, which changed nothing. A write refused by
lint lists the problems it would have added in `problems`, each `{file, id, message}`.

## `show ID… [--links] --json`

One ID prints one object; several print an array of them, in the order asked.

```json
{ "id": "A205", "kind": "A", "file": "answers.md", "index": 168, "title": "…",
  "meta": { "answered": "2026-10-07", "supersedes": "A203" }, "body": "…", "raw": "## A205 · …\n…",
  "hash": "f2330ae1122891b1",
  "links": { "out": [ { "rel": "supersedes", "id": "A203", "title": "…" } ],
             "in":  [ { "rel": "superseded-by", "id": "A203", "title": "…" } ] },
  "current": null }
```

`links` and `current` appear only with `--links`. `rel` is the meta key holding the ID, or `mentions` for the body;
`title` is null when no entry has the ID (an answered question reads as its answer's title). `current` is where a
chain of `superseded-by` leads, or null.

## Writes with `--json`: `new`, `done`, `drop`, `edit`, `set`, `append`, `answer`, `decide`, `supersede`, `amend`, `rule`, `move`

```json
{ "ok": true, "id": "T012", "file": "done.md", "hash": "3f9a…" }
```

`hash` is the entry's hash after the write, for the next `--if`. `id` is the entry written: the answer for `answer` and `decide`, the newer entry for `supersede` and `amend`, the rule for `rule`. A refusal is an error as above, exit 2.

## `lint --json`

```json
{ "ok": false, "problems": [ { "file": "todo.md", "id": "T001", "message": "refers to T404, which does not exist" } ] }
```

## `doctor [--fix] --json`

```json
{ "ok": true, "problems": [], "fixed": [ "added /.remembrancer/.lock to .gitignore" ] }
```

`problems` is what is still wrong after any fixes; exit 1 when it is not empty.

## `brief --json`

```json
{ "project": "iapetus", "visibility": "committed", "owner": "shaun",
  "waiting": [ { "id": "Q208", "kind": "Q", "file": "questions.md", "title": "…", "meta": { "waiting-on": "shaun" } } ],
  "waitingOthers": 0,
  "phase": { "plan": { "id": "T030", … }, "phase": "B", "done": 2, "total": 5, "next": [ … ], "resources": [ … ] },
  "inbox": 1,
  "rules": [ { "id": "R003", "title": "…", "status": "active", "form": "property", "tested": true, "checked": null, "reviewed": "2026-10-01" } ],
  "stale": { "count": 12, "byKind": { "T": 8, "A": 4 } },
  "checks": null,
  "todos": [ { "id": "T031", …, "blockedBy": [] } ], "questions": [ { "id": "Q201", …, "age": 3 } ], "resources": [ … ],
  "attention": { "curate": 4 } }
```

Entries are `{id, kind, file, title, meta}`. `phase` is null without a plan; `checks` is null until rule checks run.
`rules` holds the active, challenged and proposed rules.

## `stale --json`, `waiting --json`, `plan T### --json`

```json
{ "count": 1, "entries": [ { "id": "A004", "kind": "A", "file": "answers.md", "title": "…", "date": "2026-01-01", "age": 279 } ] }
{ "on": "shaun", "groups": { "shaun": [ { "id": "Q208", "kind": "Q", "file": "questions.md", "title": "…" } ] } }
{ "id": "T030", "title": "…", "state": "open", "blockers": [], "children": [ { "id": "T031", "state": "done", …, "children": [] } ] }
```

A plan node marked `"cycle": true` is its own ancestor and is not expanded again.

## `apply FILE [--dry-run] --json`

```json
{ "ok": true, "dryRun": false, "applied": [ { "index": 3, "action": "archive", "id": "T004", "result": "→ archive/done-2025.md" } ] }
```

A refused file exits 2 with `{ok: false, error, problems: [{file: null, id: null, message: "action 2 (keep T001): stale if: …"}]}`.
The input format is `schema/proposals.json`, each action `schema/action.json`.
