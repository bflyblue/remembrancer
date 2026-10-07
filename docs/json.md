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

## `new`, `done`, `drop`, `edit`, `set`, `append` with `--json`

```json
{ "ok": true, "id": "T012", "file": "done.md", "hash": "3f9a…" }
```

`hash` is the entry's hash after the write, for the next `--if`. A refusal is an error as above, exit 2.

## `lint --json`

```json
{ "ok": false, "problems": [ { "file": "todo.md", "id": "T001", "message": "refers to T404, which does not exist" } ] }
```

## `doctor [--fix] --json`

```json
{ "ok": true, "problems": [], "fixed": [ "added /.remembrancer/.lock to .gitignore" ] }
```

`problems` is what is still wrong after any fixes; exit 1 when it is not empty.
