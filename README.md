# Remembrancer

> *The Remembrancer: an old office of the City of London whose holder reminds the council of its past decisions and duties.*

Per-project working memory for you and your coding agent. It is plain markdown in a `.remembrancer/` folder, kept up to date by an agent skill, and you can browse and curate it by hand in a small local web UI.

| File | Holds | ID |
|---|---|---|
| `todo.md` | open tasks, with `priority` and `after:` dependencies | `T012` |
| `done.md` | finished tasks, with their outcome and findings | same `T012` |
| `questions.md` | open questions that shouldn't block the current work | `Q004` |
| `answers.md` | resolved questions: the answer, why, the alternatives, and when to revisit | `A004` |
| `rules.md` | invariants, properties and heuristics for code, design, process and agent behaviour | `R003` |
| `scratch.md` | this session's notes only | none |
| `archive/` | curated old done entries | kept |

**Rules** are the main payoff. Each one starts as `proposed`, and only you can make it `active`. Rules are stated as precisely as possible:
- an **invariant**, ideally encoded as a test via `enforced-by:`
- a **property** checked in review
- a **heuristic**, which should be sharpened over time

Rules are checked before every review and commit. They can be `challenged` when work shows they're wrong, and are then either revised in place or superseded. See [skill/references/format.md](skill/references/format.md) for the full format.

## Install

```sh
# CLI (remembrancer + rmb alias)
nix profile install ~/devel/personal/remembrancer
# or run from a checkout: bun src/cli.ts …   (bun run build → dist/remembrancer single binary)

# Agent skill
ln -s ~/devel/personal/remembrancer/skill ~/.claude/skills/remembrancer
```

Optional: two hooks in `~/.claude/settings.json`. The first briefs the agent at the start of every session in a project that has `.remembrancer/`. The second checks IDs and links after every edit under `.remembrancer/`, and shows any problems to the agent that made the edit:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "remembrancer brief --hook" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "remembrancer lint --ids --hook" }] }
    ]
  }
}
```

In a project without `.remembrancer/`, `--hook` prints nothing.

## Use

```sh
remembrancer init            # create .remembrancer/, exclude it via .git/info/exclude,
                             # add a "check the rules" section to AGENTS.md
remembrancer init --local    # the same, but the section goes into CLAUDE.local.md (shared repos)
remembrancer brief           # what's next, open questions, rules, what needs attention
remembrancer next T          # next free ID (T, Q, A or R; an answer to Qn is An)
remembrancer next Q --claim "title"  # take the next ID and append a stub for it, under a lock
remembrancer lint            # broken links, bad fields, duplicate IDs, unused numbers, unresolved challenges…
remembrancer lint --ids      # IDs and links only (fast; `--hook` reads a PostToolUse call on stdin)
remembrancer serve [dirs…]   # web UI on http://127.0.0.1:4747 (several projects → a switcher)
remembrancer serve --host 0.0.0.0 --port 4747   # reachable from other machines (see below)
```

### Serving from a headless machine

By default the UI listens on 127.0.0.1 only. `--host ADDR` binds another address, such as `0.0.0.0`, a LAN IP or a Tailscale IP. Beyond loopback, every request needs an **access key**, because anyone who can edit `rules.md` can steer the agents that read it:

- `serve` prints `http://<host>:<port>/?key=…` and, in a terminal, a QR code of that link to scan with a phone. Open it once per browser. It sets an HttpOnly, SameSite=Strict cookie and reloads the plain URL (a same-site refresh rather than a redirect, so it also works when opened from a phone's QR scanner).
- The key comes from `REMEMBRANCER_KEY` if that's set. Otherwise it is generated once into `~/.config/remembrancer/key` (mode 600), so cookies keep working across restarts. Delete that file to revoke every browser.
- It's plain HTTP, so use a network you trust (LAN, VPN) or skip `--host` and tunnel instead: `ssh -L 4747:127.0.0.1:4747 server`, then open http://127.0.0.1:4747.

In the agent: `/remembrancer init | status | review | curate | stuck`, or just work. The skill records tasks, questions, answers and rule proposals as they come up.

### The UI

- There are tabs for each file, an **Attention** view and a search over everything, archive included (press `/` to search).
- Every `T/Q/A/R` ID is a link. Each entry shows what refers to it, questions and answers link to each other, and a rule shows its lineage (what it supersedes and what supersedes it).
- The Attention view lists:
  - stale todos and questions
  - done entries due for curation
  - proposed and challenged rules
  - rules not reviewed in the last 90 days
  - heuristics worth sharpening
  - lint problems
- You can edit an entry in place (only that entry's text changes), mark a todo done or drop it, archive, delete a malformed entry (never one with an ID), change a rule's status, or mark a rule reviewed.
- If the agent changed a file after you loaded it, your write is refused rather than overwriting its change. The page reloads live when the files change on disk.
- The server listens on 127.0.0.1 unless you pass `--host`, and then it requires the access key. Writes need a per-run token, and pages are served with a strict CSP.

## Develop

```sh
nix develop    # or direnv: bun on PATH
bun test
bun src/cli.ts serve
```

There are no npm dependencies. Markdown rendering uses Bun's built-in `Bun.markdown`.
