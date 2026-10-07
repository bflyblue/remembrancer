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

For Claude Code there is also a mod, `integrations/claude-code/`, that does all three plus an `/rmb` pane (what waits on you, the plan's next tasks, the rules with their checks, search), `/rmb waiting | done T### | search …`, and a refusal of direct edits under `.remembrancer/` that names the command to use. Mods are early access. Try it for a session, or install it from this checkout (then drop the three settings hooks above):

```sh
claude --plugin-dir ~/devel/personal/remembrancer/integrations/claude-code
# or, to keep it:
claude plugin marketplace add ~/devel/personal/remembrancer && claude plugin install remembrancer@remembrancer
```

See [integrations/claude-code/README.md](integrations/claude-code/README.md).

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
remembrancer check [R003]     # run the rules' machine checks (enforced-by: file: "test", or cmd: …);
                             # a pass sets checked:; exit 1 on a failure
remembrancer anchors [--unused]  # code anchors (a comment "anchor: a-name"), where, and which entries
                             # cite them (anchor:a-name); lint reports cited paths and anchors gone
remembrancer curate --mode gather --out packet.json   # a packet of small cases for a curator (below)
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

### Curation with a local model

`remembrancer curate --mode gather` writes a **packet**: small, independent cases (entries whose cited files or anchors have gone, rules not reviewed, answers whose `revisit-if` may now hold, inbox captures, groups of alike entries, stale entries). Each case carries its entries' full text, the evidence, and the actions allowed, and stays under about 6 KB of text, so a small model can take one case per prompt. Gather mode only classifies: `cluster` (a `c-<label>` tag on each member), `retag`, `link`, `flag` (waits on the owner) and `archive`, which lands as `suggest: archive`, never a move. The format is `schema/packet.json`; the answer is a proposals file (`schema/proposals.json`).

With `--curator "CMD"`, the packet goes to CMD's stdin, its stdout is read as proposals, and `apply --dry-run` checks them. Nothing is applied: `--save F` keeps them for `remembrancer apply F`.

Two example curators live in `curators/` (the system prompt is `curators/gather.md`):

- **`curators/openai-compatible.ts`**: any OpenAI-compatible chat-completions server (vLLM, llama.cpp, ollama, LM Studio, OpenAI). One request per case, with the answer's JSON schema as structured output (`response_format: json_schema`); a wrong answer is retried once with its problems named.

  | variable | meaning |
  |---|---|
  | `REMEMBRANCER_LLM_URL` | the base URL, up to `/v1`, e.g. `http://ceres:8000/v1` (required) |
  | `REMEMBRANCER_LLM_MODEL` | the model's ID on that server, e.g. `qwen3.8-flash-next` (required) |
  | `REMEMBRANCER_LLM_KEY` | an API key, sent as a Bearer token (optional) |
  | `REMEMBRANCER_LLM_FORMAT` | `json_schema` (default), `json_object`, or `none` for servers without structured output |
  | `REMEMBRANCER_LLM_EXTRA` | JSON merged into each request, e.g. `{"chat_template_kwargs": {"enable_thinking": false}}` for a thinking model |

- **`curators/pi.sh`**: the same through Pi (`pi -p`), for a model Pi already reaches. `REMEMBRANCER_PI_MODEL` (optional: Pi's default model when unset; e.g. `ceres-vllm-0/qwen3.8-flash-next`) and `REMEMBRANCER_PI_THINKING` (default `off`). Pi has no structured output, so the schema goes in the prompt.

For example, from a project's root:

```sh
REMEMBRANCER_LLM_URL=http://ceres:8000/v1 REMEMBRANCER_LLM_MODEL=qwen3.8-flash-next REMEMBRANCER_LLM_KEY=local \
  remembrancer curate --mode gather --curator "bun ~/devel/personal/remembrancer/curators/openai-compatible.ts" --save /tmp/gather.json
remembrancer apply /tmp/gather.json   # after reading it
```

**Watching a long run.** While a curator runs, each case's answer is appended to `.remembrancer/log/partial-<packet>.jsonl` as it is made, with the packet beside it: `remembrancer proposals partial` shows the newest run so far, grouped by case with titles, and how many cases it has answered. A run that dies keeps what it finished there.

**What happens to a run's proposals.** `--save F` keeps them in a file. `--queue` puts them in `.remembrancer/proposals/` for review: `remembrancer proposals` lists the queue, `proposals show NAME` groups a file's actions by case with the entries' titles, `apply NAME` applies one (it moves to `proposals/applied/`), and `proposals reject NAME --why "…"` moves it to `proposals/rejected/` with a line in the curation log. `--apply` applies a gather run at once when its dry run is clean, and changes nothing when it is not: gather actions are reversible metadata (a tag, a link, a flag, a suggestion), so they need no review. Stronger runs that rewrite or move entries go through the queue.

**The weekly insight run.** `remembrancer curate --mode insight` writes a packet for a strong model: the gather runs' clusters (with each run's label and reason, read from the curation log), supersession chains that an entry still cites at an old link, the entries a gather run suggested archiving, then the gather kinds. Every action is allowed, including `condense`: several entries become one theme entry (`kind: theme`, `condensed-from:`), and each source moves to the archive with `condensed-into:`, so its ID still resolves and `show --links` leads from it to the theme. `apply` refuses a condense whose text names none of its sources, drops a reason a source gave (**Why**), or moves the newest entry of a supersession chain without the entries it supersedes. An insight run never applies directly: with `--curator` it is always queued.

Usually the insight curator is the agent you work with (Claude, say): it reads the packet a case at a time, writes a proposals file in insight mode by the rules in `curators/insight.md`, and queues it with `remembrancer proposals add FILE`; you read it with `proposals show` and apply or reject it. The example curators also take an insight packet (they switch to `curators/insight.md`), for a strong model behind an API.

**Is a model good enough to run unattended?** Score it against a packet with known good answers:

```sh
remembrancer curate --eval ~/devel/personal/remembrancer/eval/iapetus-gather-1 \
  --curator "bun ~/devel/personal/remembrancer/curators/openai-compatible.ts" [--curator "…another…"]
```

For each curator it prints precision and recall per action (an action matches gold when its kind and the IDs it names match; labels and reasons are not compared), the cluster agreement (each gold cluster's best overlap with a proposed one), how many actions a dry run accepts, and how many of the cases gold leaves alone it also left alone. `eval/iapetus-gather-1/` holds 12 iapetus cases and a first gold answer to correct (its README says why each answer is what it is). Pass several `--curator`s to compare models on one packet.

**A daily gather run** with systemd, once a model scores well enough (a user unit, here for iapetus):

```ini
# ~/.config/systemd/user/remembrancer-gather.service
[Service]
Type=oneshot
WorkingDirectory=%h/devel/personal/iapetus
Environment=REMEMBRANCER_LLM_URL=http://ceres:8000/v1 REMEMBRANCER_LLM_MODEL=qwen3.8-flash-next REMEMBRANCER_LLM_KEY=local
ExecStart=/bin/sh -lc 'remembrancer curate --mode gather --curator "bun %h/devel/personal/remembrancer/curators/openai-compatible.ts" --apply'

# ~/.config/systemd/user/remembrancer-gather.timer
[Timer]
OnCalendar=*-*-* 06:40
Persistent=true

[Install]
WantedBy=timers.target
```

Then `systemctl --user enable --now remembrancer-gather.timer`. Use `--queue` instead of `--apply` to review each run first.

### Serving from a headless machine

By default the UI listens on 127.0.0.1 only. `--host ADDR` binds another address, such as `0.0.0.0`, a LAN IP or a Tailscale IP. Beyond loopback, every request needs an **access key**, because anyone who can edit `rules.md` can steer the agents that read it:

- `serve` prints `http://<host>:<port>/?key=…` and, in a terminal, a QR code of that link to scan with a phone. Open it once per browser. It sets an HttpOnly, SameSite=Strict cookie and reloads the plain URL (a same-site refresh rather than a redirect, so it also works when opened from a phone's QR scanner).
- The key comes from `REMEMBRANCER_KEY` if that's set. Otherwise it is generated once into `~/.config/remembrancer/key` (mode 600), so cookies keep working across restarts. Delete that file to revoke every browser.
- It's plain HTTP, so use a network you trust (LAN, VPN) or skip `--host` and tunnel instead: `ssh -L 4747:127.0.0.1:4747 server`, then open http://127.0.0.1:4747.

In the agent: `/remembrancer init | status | plan | review | curate | stuck`, or just work. The skill records tasks, questions, answers, resources and rule proposals as they come up. `plan` groups a few related todos into a wave under a `Plan: …` task.

### Committed or private

`init` excludes `.remembrancer/` from git, so you can use it on a shared repo without the team having to adopt it. In that case its IDs mean nothing to anyone reading the history, and the brief tells the agent to keep T/Q/A/R/K IDs out of commit messages, PRs and code, and the PreToolUse guard enforces it. To commit the folder instead (a personal project), delete its line from `.git/info/exclude`. The brief then tells the agent it may cite IDs. It checks with `git check-ignore`, so a `.gitignore` entry counts too.

### The UI

The UI is for reading: what is outstanding, what was decided, and how the rules stand. Its writes are few and basic, and each takes the same lock and checks as the CLI.

- There are tabs for each file, an **Attention** view, a **Queue** view and a search over everything, archive included (press `/` to search). Search is ranked (the same index as `remembrancer search`): a superseded or condensed hit brings its current entry, marked *via*.
- **Signals are badges and banners:** *waits on shaun* (`waiting-on`), each rule's last machine check (*check pass*, *check FAIL*, *check not run*), *theme* entries and *→ T269* on an entry condensed into one, *suggest archive*, and the first tags. The overview and the Rules tab open with the checks' summary (`remembrancer check` runs them).
- Links in entries work inside the app:
  - IDs open the entry, and web links open in a new tab.
  - A file path, as a link or in backticks, opens the file when it exists. It is tried from the entry's own file first, then from the project root, then from the git root.
  - A resource gets an **Open resource** button.
  - Only files that some entry links to are served (never `.git` or `.env*`), and they are sandboxed.
  - A link to a missing file, or with an unsafe scheme, shows as broken.
- Every `T/Q/A/R` ID is a link. Each entry shows what refers to it, questions and answers link to each other, and a rule shows its lineage (what it supersedes and what supersedes it).
- The Attention view lists, first, what waits on the owner, failing checks, the inbox, entries suggested for archiving and stale entries; then:
  - stale todos and questions
  - done entries due for curation
  - proposed and challenged rules
  - rules not reviewed in the last 90 days
  - heuristics worth sharpening
  - lint problems
- The Queue view lists curator runs waiting for review and shows each one by case, with titles; **Apply** and **Reject** do what `remembrancer apply` and `proposals reject` do.
- You can edit an entry in place (only that entry's text changes), mark a todo done or drop it, archive, **mark stale** (`suggest: archive`, for a person or the weekly run to decide), clear `waiting-on`, **answer** a question (its sections filled in, saved through `remembrancer answer`), delete a malformed entry (never one with an ID), change a rule's status, or mark a rule reviewed.
- If the agent changed a file after you loaded it, your write is refused rather than overwriting its change. The page reloads live when the files change on disk.
- The server listens on 127.0.0.1 unless you pass `--host`, and then it requires the access key. Writes need a per-run token, and pages are served with a strict CSP.

## Develop

```sh
nix develop    # or direnv: bun on PATH
bun test
bun src/cli.ts serve
```

There are no npm dependencies. Markdown rendering uses Bun's built-in `Bun.markdown`.
