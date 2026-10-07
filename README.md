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
| `resources.md` | key references (links, papers, PDFs) with the takeaways and when to read them | `K002` |
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

Optional: three hooks in `~/.claude/settings.json`:
- **SessionStart** briefs the agent at the start of every session in a project that has `.remembrancer/`.
- **PostToolUse** checks IDs and links after every edit under `.remembrancer/`, and shows any problems to the agent that made the edit.
- **PreToolUse** is the commit guard. When git ignores `.remembrancer/`, it refuses a `git commit`, `git tag` or `gh pr`/`gh issue` command whose message, or whose staged changes, would publish one of the project's IDs, and tells the agent which ones. Only IDs that exist in the project count, so `T800` in ordinary text passes.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "remembrancer brief --hook" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "remembrancer lint --ids --hook" }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "remembrancer guard --hook" }] }
    ]
  }
}
```

In a project without `.remembrancer/`, `--hook` prints nothing.

For the [pi](https://github.com/earendil-works/pi) agent, `integrations/pi/remembrancer.ts` does the same three things as an extension:

```sh
ln -s ~/devel/personal/remembrancer/integrations/pi/remembrancer.ts ~/.pi/agent/extensions/
ln -s ~/devel/personal/remembrancer/skill ~/.pi/agent/skills/remembrancer
```

## Use

```sh
remembrancer init            # create .remembrancer/, exclude it via .git/info/exclude,
                             # add a "check the rules" section to AGENTS.md
remembrancer init --local    # the same, but the section goes into CLAUDE.local.md (shared repos)
remembrancer brief           # what's next, open questions, rules, resources, what needs attention,
                             # and whether git ignores .remembrancer/ (so IDs stay out of commits)
remembrancer next T          # next free ID (T, Q, A, R or K; an answer to Qn is An)
remembrancer next Q --claim "title"  # take the next ID and append a stub for it, under a lock
remembrancer new T "title" --priority=P2 [--after=T010] [--body "…" | --body - | --body-file F]
                             # claim the next ID and write the whole entry (Q, R and K too:
                             # K needs --link= and --consult-when=; R starts proposed)
remembrancer new T "idea" --inbox     # quick capture: status: inbox, no priority yet
remembrancer done T012 --outcome "…"  # move to done.md, dated; the outcome replaces the body
remembrancer drop T012 --reason "…"   # move to done.md as dropped, with the reason
remembrancer set T012 priority=P1 [--unset area] [--if HASH]   # change fields
remembrancer append R003 --section History --line "…"  # add a dated line under **History:**
remembrancer edit T012 --if HASH --title "…" [--body -]  # HASH from show: refuses a stale edit
remembrancer answer Q014 "title" --body - [--revisit-if "…"] [--closes Q015] [--supersedes A009] [--partial]
                             # write A014 (Question copied from Q014) and remove the question
remembrancer decide "title" --body -  # an answer no question asked for
remembrancer supersede A009 --by A014 # both ends set; a superseded rule is retired (also: amend)
remembrancer rule R003 activate|retire [--by R012]|challenge --question Q020|reviewed
remembrancer move T012 --to archive  # into archive/done-2026.md
remembrancer brief --json    # the brief as data (docs/json.md)
remembrancer stale [--days N] [--kind T]  # old entries nothing live cites: candidates to archive
remembrancer waiting [--on WHO | --all]   # entries with waiting-on:, by who (default: the owner)
remembrancer plan T030       # a plan's tree through after:, with each task's state and blockers
remembrancer search "re-seed crossing" [--kind A] [--tag t] [--all] [--neighbours] [--list]
                             # ranked whole entries (stemmed, titles weighted); a superseded
                             # hit brings its current entry; FTS5 syntax passes through
remembrancer apply plan.json --dry-run  # check a proposals file (schema/proposals.json) and say what it
                             # would do; without --dry-run, apply it in one step or refuse it whole
remembrancer lint            # broken links, bad fields, duplicate IDs, unused numbers, unresolved challenges…
remembrancer lint --ids      # IDs and links only (fast; `--hook` reads a PostToolUse call on stdin)
remembrancer show A012 T004  # whole entries, each with its hash (`--json` for data)
remembrancer show A012 --links  # plus links out, links in, and `current:` where a chain of
                             # superseded-by leads
remembrancer doctor          # tool files a committed .remembrancer/ would publish (.lock, *.tmp-*,
                             # .index.db, log/, proposals/), a stale lock, duplicate IDs
remembrancer doctor --fix    # add the ignore lines (.gitignore when committed, .git/info/exclude
                             # when private) and remove a stale lock; init adds them too
remembrancer guard "git commit -m …"   # exit 2 if the command would publish IDs (see hooks above)
remembrancer serve [dirs…]   # web UI on http://127.0.0.1:4747 (several projects → a switcher)
remembrancer serve --host 0.0.0.0 --port 4747   # reachable from other machines (see below)
```

Optional `.remembrancer/config.json`: `{"owner": "shaun"}` names whose `waiting-on:` entries the brief lists first; `"stale": {"T": 30, …}` changes the staleness thresholds; `"knowledge-base": true` archives into `kb/<file>.md` (read as part of the project) instead of `archive/<file>-<year>.md`. See [format.md](skill/references/format.md#configjson).

Every write command takes the lock, checks the entry (against `--if HASH` when given), stamps `touched:`, and lints the result: a write that would add a lint problem exits 2 and changes nothing. Agents should make every change this way; the PostToolUse lint hook catches hand edits and names the command that would have made them.

### Serving from a headless machine

By default the UI listens on 127.0.0.1 only. `--host ADDR` binds another address, such as `0.0.0.0`, a LAN IP or a Tailscale IP. Beyond loopback, every request needs an **access key**, because anyone who can edit `rules.md` can steer the agents that read it:

- `serve` prints `http://<host>:<port>/?key=…` and, in a terminal, a QR code of that link to scan with a phone. Open it once per browser. It sets an HttpOnly, SameSite=Strict cookie and reloads the plain URL (a same-site refresh rather than a redirect, so it also works when opened from a phone's QR scanner).
- The key comes from `REMEMBRANCER_KEY` if that's set. Otherwise it is generated once into `~/.config/remembrancer/key` (mode 600), so cookies keep working across restarts. Delete that file to revoke every browser.
- It's plain HTTP, so use a network you trust (LAN, VPN) or skip `--host` and tunnel instead: `ssh -L 4747:127.0.0.1:4747 server`, then open http://127.0.0.1:4747.

In the agent: `/remembrancer init | status | plan | review | curate | stuck`, or just work. The skill records tasks, questions, answers, resources and rule proposals as they come up. `plan` groups a few related todos into a wave under a `Plan: …` task.

### Committed or private

`init` excludes `.remembrancer/` from git, so you can use it on a shared repo without the team having to adopt it. In that case its IDs mean nothing to anyone reading the history, and the brief tells the agent to keep T/Q/A/R/K IDs out of commit messages, PRs and code, and the PreToolUse guard enforces it. To commit the folder instead (a personal project), delete its line from `.git/info/exclude`. The brief then tells the agent it may cite IDs. It checks with `git check-ignore`, so a `.gitignore` entry counts too.

### The UI

- There are tabs for each file, an **Attention** view and a search over everything, archive included (press `/` to search).
- Links in entries work inside the app:
  - IDs open the entry, and web links open in a new tab.
  - A file path, as a link or in backticks, opens the file when it exists. It is tried from the entry's own file first, then from the project root, then from the git root.
  - A resource gets an **Open resource** button.
  - Only files that some entry links to are served (never `.git` or `.env*`), and they are sandboxed.
  - A link to a missing file, or with an unsafe scheme, shows as broken.
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
