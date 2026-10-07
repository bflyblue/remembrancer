#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { briefData, renderBrief } from "./brief";
import { formatPlan, planTree, stale, waiting } from "./signals";
import { LOG, ProposalsRefusedError, apply, applyProposals, label, parseProposals } from "./proposals";
import { type Scope, buildPacket, packetSize, subjects } from "./curate";
import { formatHits, search } from "./search";
import { anchorCitations, anchorDefinitions, repoOf } from "./anchors";
import { type CheckResult, recordChecks, runChecks } from "./check";
import { guard } from "./guard";
import { LintRefusedError, type RuleAction, amend, answerQuestion, appendLine, archiveEntry, ruleAction, supersede, claimId, completeEntry, editEntry, formatShown, locate, newEntry, refTo, setMeta, show } from "./commands";
import { doctor, init } from "./init";
import { lint } from "./analyse";
import { ConflictError, DIR, NotFoundError, RefusedError, findRoot, loadProject, nextId, visibility } from "./project";
import { qrTerminal } from "./qr";
import { isLoopback, serve } from "./server";
import type { Kind } from "./model";

const USAGE = `remembrancer: per-project working memory for you and your agent

usage:
  remembrancer init [--local]        create ${DIR}/, exclude it from git, add the rules section
                                     to AGENTS.md (or CLAUDE.local.md with --local)
  remembrancer next T|Q|A|R|K [--claim TITLE]
                                     print the next free ID (Q and A share one sequence; A is for
                                     a decision with no question). --claim also appends a stub
                                     entry for it under a lock, so no one else gets the number
  remembrancer brief [--hook] [--json]
                                     session-start summary: what waits on the owner, the current
                                     phase, what needs a decision, then todos, questions, rules
                                     and resources; also whether git ignores ${DIR}/ (and so
                                     whether IDs may appear in commits). --hook: print nothing
                                     if there is no ${DIR}/
  remembrancer stale [--days N] [--kind T|Q|A|R|K]
                                     entries unchanged past their kind's threshold (or N days)
                                     that no open todo, open question or rule in force cites
  remembrancer waiting [--on WHO | --all]
                                     entries with waiting-on:, by who (default: config.json's owner)
  remembrancer plan T###             the tree a task opens through after:, each with its state
                                     (open, done, dropped) and open blockers; cycles marked
  remembrancer new T|Q|R|K "title" [--key=value]... [--body TEXT|- | --body-file F] [--inbox]
                                     claim the next ID and write the whole entry in one locked
                                     step. T needs --priority=P1|P2|P3 unless --inbox (status:
                                     inbox); K needs --link= and --consult-when=; R is proposed
  remembrancer done T### [--outcome TEXT|- | --outcome-file F]
                                     move a todo to done.md, dated; the outcome replaces its body
  remembrancer drop T### --reason "why"
                                     move a todo to done.md as dropped, the reason atop its body
  remembrancer edit ID --if HASH [--title "…"] [--body TEXT|- | --body-file F]
                                     change a title or body; HASH is what show printed
  remembrancer set ID key=value... [--unset key]... [--if HASH]
                                     change metadata fields
  remembrancer append ID --section Name --line "text" [--if HASH]
                                     add "- YYYY-MM-DD: text" under **Name:** (made if missing)
  remembrancer answer Q### "title" --body TEXT|- [--revisit-if "…"] [--closes Q…] [--amends A…]
                      [--supersedes A…] [--partial] [--if HASH] [--key=value]...
                                     write the answer A### (the body needs **Answer**, **Why** and
                                     **Alternatives considered**; **Question** is copied from the
                                     question) and remove the question and those it closes.
                                     --partial: a fresh number, the question stays with a History line
  remembrancer decide "title" --body TEXT|- [--revisit-if "…"] [--amends A…] [--supersedes A…]
                                     an answer no question asked for, with a fresh number
  remembrancer supersede OLD --by NEW | amend OLD --by NEW
                                     two answers or two rules: both ends set (a superseded rule is
                                     retired)
  remembrancer rule R### activate | retire [--by R###] | challenge --question Q### | reviewed
                                     a rule's status, with a History line (reviewed: the date only)
                                     Every write: locked, checked, stamped touched:, linted; a
                                     stale --if or a write that adds a lint problem exits 2 and
                                     changes nothing. --json on any of them prints {ok, id, file,
                                     hash}
  remembrancer apply FILE [--dry-run] [--json]
                                     apply a proposals file (schema/proposals.json: keep, archive,
                                     drop, set, retag, link, flag) in one locked step, or refuse it
                                     whole naming each bad action; logged in ${DIR}/log/curation.md.
                                     --dry-run: check it and say what it would do, writing nothing
  remembrancer move ID --to archive  archive/<file>-<year>.md, or kb/<file>.md when config.json has
                                     "knowledge-base": true
  remembrancer search "terms" [--kind K] [--tag t] [--phase p] [--all] [--k N] [--neighbours] [--list]
                                     ranked whole entries (BM25 over titles, tags and bodies,
                                     stemmed: "seeding" finds "seed"); a superseded hit brings its
                                     current entry (via). Plain words rank entries holding any of
                                     them; FTS5 syntax ("a phrase", AND, OR, NOT, pre*) passes
                                     through. --all: archive/ and kb/ too. --neighbours: each hit's
                                     links in and out. --list: titles only
  remembrancer anchors [--unused] [--json]
                                     each anchor defined in the code (a comment holding
                                     "anchor: a-name"), where, and the entries citing it
                                     (anchor:a-name). --unused: only those no entry cites
  remembrancer check [R###...] [--json]
                                     run the rules' machine checks (enforced-by: path: "test name"
                                     through config.json's check.test, or cmd: command); pass, FAIL
                                     with the last 20 lines, or skipped; a pass sets checked:.
                                     Exit 1 on any failure
  remembrancer curate --mode gather [--scope active|archive|all] [--out F] [--curator "CMD" [--save F]]
                                     a packet of small cases (drift, inbox, alike entries, stale)
                                     for a cheap model to classify. --out writes it (else stdout).
                                     --curator pipes it to CMD, reads proposals from CMD's stdout,
                                     and dry-runs them, applying nothing; --save keeps them for
                                     remembrancer apply. Example curators: curators/ (README)
  remembrancer show ID... [--links] [--json]
                                     print whole entries, each with its hash (the entry's version).
                                     --links: what each links to, what links to it, and where a
                                     chain of superseded-by leads (current:)
  remembrancer doctor [--fix] [--json]
                                     report tool files a committed ${DIR}/ would publish, a stale
                                     lock, duplicate IDs. --fix: add the ignore lines (.gitignore
                                     when committed, .git/info/exclude when private), drop the lock
  remembrancer lint [--ids] [--hook] [--json]
                                     check the files for broken IDs, fields and links
                                     (--ids: IDs and links only. --hook: read a PostToolUse call
                                     on stdin, check only edits under ${DIR}/, exit 2 on problems)
  remembrancer guard [--hook | COMMAND...]
                                     when git ignores ${DIR}/: refuse (exit 2) a git commit, git
                                     tag or gh pr/issue command whose message, or whose staged
                                     changes, would publish this project's IDs. --hook: read a
                                     PreToolUse Bash call on stdin
  remembrancer serve [dir...] [--port N] [--host ADDR]
                                     browse and curate in a web UI (default 127.0.0.1:4747).
                                     A non-loopback --host (e.g. 0.0.0.0) requires an access key:
                                     REMEMBRANCER_KEY, or one saved in ~/.config/remembrancer/key
`;

// A stable key, so browser cookies survive restarts. REMEMBRANCER_KEY wins;
// otherwise one is generated once into ~/.config/remembrancer/key (mode 600).
async function accessKey(): Promise<string> {
  if (process.env.REMEMBRANCER_KEY) return process.env.REMEMBRANCER_KEY;
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "remembrancer");
  const path = join(dir, "key");
  const file = Bun.file(path);
  if (await file.exists()) {
    const key = (await file.text()).trim();
    if (key) return key;
  }
  const key = randomBytes(24).toString("base64url");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, key + "\n", { mode: 0o600 });
  return key;
}

// One line on stderr and the exit code; with --json, also {ok: false, error, problems}
// on stdout, so a caller parsing the output always gets JSON.
function fail(code: number, message: string, json: boolean, problems: unknown[] = []): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message, problems }, null, 2));
  console.error(message);
  process.exit(code);
}

// The lint hook's last line: the commands that make by hand edits safely.
const HAND_EDIT_HINT: Record<string, string> = {
  "todo.md": "Make todo changes with the CLI: remembrancer new T, set, append, edit, done, drop.",
  "done.md": "Make done changes with the CLI: remembrancer done, drop, set, append, edit.",
  "questions.md": "Make question changes with the CLI: remembrancer new Q, set, append, edit.",
  "rules.md": "Make rule changes with the CLI: remembrancer new R, set, append, edit.",
  "resources.md": "Make resource changes with the CLI: remembrancer new K, set, append, edit.",
  "": "Make entry changes with the CLI where a command does the job: remembrancer set, append, edit.",
};

// Options that take a value; `--unset` may repeat. Any other `--key=value` is
// a field (for `new`), and any other `--flag` a switch.
const VALUED = new Set([
  "--body", "--body-file", "--outcome", "--outcome-file", "--reason", "--if", "--title", "--section", "--line", "--unset",
  "--revisit-if", "--closes", "--amends", "--supersedes", "--by", "--question", "--to",
  "--waiting-on",
]);

// `own`: options that take a value for this command only, so that elsewhere
// `--phase=B` stays a field (`new T … --phase=B`).
function parseArgs(args: string[], own: string[] = []) {
  const valued = new Set([...VALUED, ...own]);
  const pos: string[] = [];
  const opts = new Map<string, string[]>();
  const fields: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 2 ? a.slice(0, eq) : a;
    if (valued.has(name)) {
      const value = name === a ? args[++i] : a.slice(eq + 1);
      if (value === undefined) fail(2, `${name} needs a value`, args.includes("--json"));
      opts.set(name, [...(opts.get(name) ?? []), value]);
    } else if (a.startsWith("--") && eq > 2) fields[a.slice(2, eq)] = a.slice(eq + 1);
    else if (a.startsWith("--")) flags.add(a);
    else pos.push(a);
  }
  return { pos, fields, opt: (name: string) => opts.get(name) ?? [], has: (flag: string) => flags.has(flag) };
}

// A body given one way only: `--NAME -` (stdin), `--NAME-file F`, or `--NAME "text"`.
async function readText(opt: (name: string) => string[], name: string, json: boolean): Promise<string | undefined> {
  const inline = opt(`--${name}`);
  const files = opt(`--${name}-file`);
  if (inline.length + files.length > 1) fail(2, `give the ${name} once: --${name} TEXT, --${name} - (stdin) or --${name}-file F`, json);
  if (files.length) {
    const f = Bun.file(files[0]);
    if (!(await f.exists())) fail(1, `no file ${files[0]}`, json);
    return f.text();
  }
  if (inline[0] === "-") return Bun.stdin.text();
  return inline[0];
}

// After a write: the entry's new hash, for the next --if.
async function reportWrite(root: string, id: string, json: boolean, message: string) {
  const e = locate(await loadProject(root), id);
  if (json) console.log(JSON.stringify({ ok: true, id, file: e.file, hash: e.hash }, null, 2));
  else console.log(`${message} · hash: ${e.hash}`);
}

function requireRoot(): string {
  const root = findRoot();
  if (!root) {
    console.error(`no ${DIR}/ found here or in any parent directory (run: remembrancer init)`);
    process.exit(1);
  }
  return root;
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  const flag = (name: string) => args.includes(name);
  const json = flag("--json");
  // `remembrancer <cmd> --help` shows the one usage page rather than running the command.
  if (flag("--help") || flag("-h")) {
    console.log(USAGE);
    return;
  }
  switch (cmd) {
    case "init": {
      const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "ignore" });
      const root = top.exitCode === 0 ? top.stdout.toString().trim() : process.cwd();
      const log = await init(root, { local: flag("--local") });
      console.log(log.length ? log.join("\n") : "already set up");
      return;
    }
    case "next": {
      const kind = (args[0] ?? "").toUpperCase();
      const claim = args.indexOf("--claim");
      const title = claim >= 0 ? args.slice(claim + 1).join(" ").trim() : "";
      if (!["T", "Q", "A", "R", "K"].includes(kind) || (claim >= 0 && !title)) {
        console.error("usage: remembrancer next T|Q|A|R|K [--claim TITLE]  (an answer to Qn is An: no new number)");
        process.exit(2);
      }
      const root = requireRoot();
      console.log(claim >= 0 ? await claimId(root, kind as Kind, title) : nextId(await loadProject(root), kind as Kind));
      return;
    }
    case "new": {
      const { pos, opt, fields, has } = parseArgs(args);
      const kind = (pos[0] ?? "").toUpperCase();
      const title = pos.slice(1).join(" ").trim();
      if (kind === "A") fail(2, "a decision with no question: remembrancer next A --claim TITLE, then fill it in (answers get their own command later)", json);
      if (!["T", "Q", "R", "K"].includes(kind) || !title) fail(2, 'usage: remembrancer new T|Q|R|K "title" [--key=value]... [--body TEXT|- | --body-file F] [--inbox]', json);
      const root = requireRoot();
      const waitingOn = opt("--waiting-on")[0];
      if (waitingOn !== undefined) fields["waiting-on"] = waitingOn;
      const id = await newEntry(root, kind as Kind, title, { fields, body: (await readText(opt, "body", json)) ?? "", inbox: has("--inbox") });
      await reportWrite(root, id, json, id);
      return;
    }
    case "done":
    case "drop":
    case "edit":
    case "set":
    case "append": {
      const { pos, opt } = parseArgs(args);
      const id = (pos[0] ?? "").toUpperCase();
      if (!id) fail(2, `usage: ${USAGE.split("\n").find((l) => l.includes(`remembrancer ${cmd} `))?.trim()}`, json);
      const root = requireRoot();
      const project = await loadProject(root);
      const ref = refTo(project, locate(project, id));
      const given = opt("--if")[0];
      if (given !== undefined) ref.entry = given;
      if (cmd === "done") {
        const moved = await completeEntry(root, ref, { outcome: await readText(opt, "outcome", json) });
        return reportWrite(root, id, json, `${id} → ${moved}`);
      }
      if (cmd === "drop") {
        const reason = opt("--reason")[0];
        if (!reason) fail(2, 'usage: remembrancer drop T### --reason "why"', json);
        const moved = await completeEntry(root, ref, { dropped: true, reason });
        return reportWrite(root, id, json, `${id} dropped → ${moved}`);
      }
      if (cmd === "edit") {
        if (given === undefined) fail(2, "edit needs --if HASH (the hash `remembrancer show` printed), so it never overwrites a change you have not read", json);
        const title = opt("--title")[0];
        const body = await readText(opt, "body", json);
        if (title === undefined && body === undefined) fail(2, 'usage: remembrancer edit ID --if HASH [--title "…"] [--body TEXT|- | --body-file F]', json);
        await editEntry(root, ref, { title, body });
        return reportWrite(root, id, json, `${id} edited`);
      }
      if (cmd === "set") {
        const updates: Record<string, string> = {};
        for (const p of pos.slice(1)) {
          const eq = p.indexOf("=");
          if (eq < 1) fail(2, `"${p}" is not key=value`, json);
          updates[p.slice(0, eq)] = p.slice(eq + 1);
        }
        for (const k of opt("--unset")) updates[k] = "";
        if (!Object.keys(updates).length) fail(2, "usage: remembrancer set ID key=value... [--unset key]... [--if HASH]", json);
        await setMeta(root, ref, updates);
        return reportWrite(root, id, json, `${id} set`);
      }
      const section = opt("--section")[0];
      const line = opt("--line")[0];
      if (!section || line === undefined) fail(2, 'usage: remembrancer append ID --section Name --line "text"', json);
      await appendLine(root, ref, section, line);
      return reportWrite(root, id, json, `${id}: added to ${section}`);
    }
    case "answer":
    case "decide": {
      const { pos, opt, fields, has } = parseArgs(args);
      const qid = cmd === "answer" ? (pos.shift() ?? "").toUpperCase() : null;
      const title = pos.join(" ").trim();
      const body = await readText(opt, "body", json);
      if ((cmd === "answer" && !qid) || !title || body === undefined) {
        fail(2, cmd === "answer"
          ? 'usage: remembrancer answer Q### "title" --body TEXT|- [--revisit-if "…"] [--closes Q…] [--amends A…] [--supersedes A…] [--partial] [--if HASH]'
          : 'usage: remembrancer decide "title" --body TEXT|- [--revisit-if "…"] [--closes Q…] [--amends A…] [--supersedes A…]', json);
      }
      const ids = (name: string) => opt(name).flatMap((v) => v.split(/[,\s]+/)).filter(Boolean);
      const root = requireRoot();
      const id = await answerQuestion(root, qid, {
        title,
        body: body!,
        revisitIf: opt("--revisit-if")[0],
        closes: ids("--closes"),
        amends: ids("--amends"),
        supersedes: ids("--supersedes"),
        partial: has("--partial"),
        ifHash: opt("--if")[0],
        fields,
      });
      return reportWrite(root, id, json, qid && !has("--partial") ? `${id} answers ${qid}` : id);
    }
    case "supersede":
    case "amend": {
      const { pos, opt } = parseArgs(args);
      const older = (pos[0] ?? "").toUpperCase();
      const newer = (opt("--by")[0] ?? "").toUpperCase();
      if (!older || !newer) fail(2, `usage: remembrancer ${cmd} OLD --by NEW  (two answers, or two rules)`, json);
      const root = requireRoot();
      await (cmd === "supersede" ? supersede : amend)(root, older, newer);
      return reportWrite(root, newer, json, `${newer} ${cmd === "supersede" ? "supersedes" : "amends"} ${older}`);
    }
    case "rule": {
      const { pos, opt } = parseArgs(args);
      const rid = (pos[0] ?? "").toUpperCase();
      const action = pos[1] as RuleAction;
      if (!rid || !["activate", "retire", "challenge", "reviewed"].includes(action)) {
        fail(2, "usage: remembrancer rule R### activate|retire [--by R###]|challenge --question Q###|reviewed", json);
      }
      const root = requireRoot();
      await ruleAction(root, rid, action, { by: opt("--by")[0]?.toUpperCase(), question: opt("--question")[0]?.toUpperCase() });
      return reportWrite(root, rid, json, `${rid}: ${action}`);
    }
    case "move": {
      const { pos, opt } = parseArgs(args);
      const id = (pos[0] ?? "").toUpperCase();
      if (!id || opt("--to")[0] !== "archive") fail(2, "usage: remembrancer move ID --to archive", json);
      const root = requireRoot();
      const project = await loadProject(root);
      const moved = await archiveEntry(root, refTo(project, locate(project, id)));
      return reportWrite(root, id, json, `${id} → ${moved}`);
    }
    case "stale": {
      const { opt } = parseArgs(args, ["--days", "--kind"]);
      const days = opt("--days")[0];
      const kind = opt("--kind")[0]?.toUpperCase();
      if ((days !== undefined && !/^\d+$/.test(days)) || (kind && !["T", "Q", "A", "R", "K"].includes(kind))) {
        fail(2, "usage: remembrancer stale [--days N] [--kind T|Q|A|R|K]", json);
      }
      const list = stale(await loadProject(requireRoot()), { days: days === undefined ? undefined : parseInt(days, 10), kind: kind as Kind | undefined });
      if (json) console.log(JSON.stringify({ count: list.length, entries: list }, null, 2));
      else if (!list.length) console.log("nothing stale");
      else for (const s of list) console.log(`${s.id} ${s.age === null ? "undated" : `${s.age}d`.padStart(5)}  ${s.title}  (${s.file})`);
      return;
    }
    case "waiting": {
      const { opt, has } = parseArgs(args, ["--on"]);
      const project = await loadProject(requireRoot());
      const on = has("--all") ? undefined : (opt("--on")[0] ?? project.config.owner);
      const groups = waiting(project, on);
      if (json) {
        console.log(JSON.stringify({ on: on ?? null, groups: Object.fromEntries([...groups].map(([who, l]) => [who, l.map((e) => ({ id: e.id, kind: e.kind, file: e.file, title: e.title }))])) }, null, 2));
        return;
      }
      if (!groups.size) console.log(on ? `nothing waits on ${on}` : "nothing waits on anyone");
      for (const [who, list] of groups) {
        console.log(`${who}:`);
        for (const e of list) console.log(`  ${e.id} ${e.title}  (${e.file})`);
      }
      return;
    }
    case "plan": {
      const id = (args.find((a) => !a.startsWith("--")) ?? "").toUpperCase();
      if (!id) fail(2, "usage: remembrancer plan T###", json);
      const project = await loadProject(requireRoot());
      locate(project, id);
      const tree = planTree(project, id);
      if (json) console.log(JSON.stringify(tree, null, 2));
      else {
        console.log(formatPlan(tree).join("\n"));
        const doneWhen = project.byId.get(id)![0].meta["done-when"];
        if (doneWhen) console.log(`done when: ${doneWhen}`);
      }
      return;
    }
    case "apply": {
      const path = args.find((a) => !a.startsWith("--"));
      if (!path) fail(2, "usage: remembrancer apply FILE [--dry-run] [--json]", json);
      const dryRun = flag("--dry-run");
      const applied = await apply(requireRoot(), resolve(path!), { dryRun });
      if (json) console.log(JSON.stringify({ ok: true, dryRun, applied }, null, 2));
      else {
        for (const a of applied) console.log(`${a.action} ${a.id}: ${a.result}`);
        console.log(dryRun ? `dry run: ${applied.length} action${applied.length === 1 ? "" : "s"} would apply; nothing written` : `applied ${applied.length}; logged in ${DIR}/${LOG}`);
      }
      return;
    }
    case "search": {
      const { pos, opt, has } = parseArgs(args, ["--kind", "--tag", "--phase", "--k"]);
      const query = pos.join(" ");
      const kind = opt("--kind")[0]?.toUpperCase();
      const k = opt("--k")[0];
      if (!query || (kind && !["T", "Q", "A", "R", "K"].includes(kind)) || (k !== undefined && !/^\d+$/.test(k))) {
        fail(2, 'usage: remembrancer search "terms" [--kind T|Q|A|R|K] [--tag t] [--phase p] [--all] [--k N] [--neighbours] [--list]', json);
      }
      const hits = search(await loadProject(requireRoot()), query, {
        kind: kind as Kind | undefined,
        tag: opt("--tag")[0],
        phase: opt("--phase")[0],
        all: has("--all"),
        k: k === undefined ? undefined : parseInt(k, 10),
        neighbours: has("--neighbours"),
      });
      console.log(json ? JSON.stringify({ query, hits }, null, 2) : formatHits(hits, { list: has("--list") }));
      return;
    }
    case "anchors": {
      const root = requireRoot();
      const project = await loadProject(root);
      const defs = anchorDefinitions(repoOf(root));
      const cites = anchorCitations(project);
      const names = [...new Set(defs.map((d) => d.name))].sort().filter((n) => !flag("--unused") || !cites.has(n));
      const rows = names.map((name) => ({
        name,
        defined: defs.filter((d) => d.name === name).map((d) => `${d.file}:${d.line}`),
        citedBy: (cites.get(name) ?? []).map((e) => e.id!),
      }));
      if (json) console.log(JSON.stringify({ anchors: rows }, null, 2));
      else if (!rows.length) console.log(flag("--unused") ? "every anchor is cited" : "no anchors: put `anchor: a-name` in a code comment, and cite it as anchor:a-name");
      else for (const r of rows) console.log(`${r.name}  ${r.defined.join(", ")}${r.defined.length > 1 ? "  (defined twice: rename one)" : ""}  ← ${r.citedBy.join(", ") || "no entry"}`);
      return;
    }
    case "check": {
      const ids = args.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase());
      const root = requireRoot();
      const project = await loadProject(root);
      const print = (r: CheckResult) => {
        if (json) return;
        const head = `${r.id} ${r.status === "fail" ? "FAIL" : r.status}${r.seconds !== undefined ? ` (${r.seconds}s)` : ""}  ${r.title}`;
        console.log(r.status === "pass" ? head : `${head}\n  ${r.message}${r.tail ? "\n" + r.tail.map((l) => `  | ${l}`).join("\n") : ""}`);
      };
      const results = await runChecks(project, ids, print);
      await recordChecks(root, results);
      const n = (s: string) => results.filter((r) => r.status === s).length;
      if (json) console.log(JSON.stringify({ ok: n("fail") === 0, results }, null, 2));
      else console.log(results.length ? `${n("pass")} pass, ${n("fail")} fail, ${n("skipped")} skipped` : "no rule has a check to run (enforced-by)");
      if (n("fail")) process.exit(1);
      return;
    }
    case "curate": {
      const { opt, has } = parseArgs(args, ["--mode", "--scope", "--out", "--curator", "--save"]);
      const mode = opt("--mode")[0];
      const scope = (opt("--scope")[0] ?? "active") as Scope;
      if (mode !== "gather" || !["active", "archive", "all"].includes(scope)) {
        fail(2, mode === "insight" ? "insight mode arrives in a later slice" : 'usage: remembrancer curate --mode gather [--scope active|archive|all] [--out F] [--curator "CMD" [--save F]]', json);
      }
      const root = requireRoot();
      const packet = buildPacket(await loadProject(root), { scope });
      const size = packetSize(packet);
      const summary = `packet ${packet.packet}: ${size.cases} cases (${Object.entries(size.byKind).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}), about ${size.tokens} tokens; ${size.meanCaseTokens} per case on average, ${size.maxCaseTokens} at most`;
      const out = opt("--out")[0];
      if (out) await Bun.write(out, JSON.stringify(packet, null, 2) + "\n");
      const curator = opt("--curator")[0];
      if (!curator) {
        if (out) console.log(json ? JSON.stringify({ ok: true, ...size, packet: packet.packet, out }, null, 2) : `${summary}\nwritten to ${out}`);
        else console.log(JSON.stringify(packet, null, 2));
        return;
      }
      if (!json) console.error(summary);
      // The curator runs outside the lock: it may take minutes.
      const proc = Bun.spawn(["sh", "-c", curator], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      proc.stdin.write(JSON.stringify(packet));
      proc.stdin.end();
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) fail(1, `the curator exited ${code}; nothing applied`, json);
      let raw: { actions?: unknown[] } = {};
      try {
        raw = JSON.parse(text);
      } catch {}
      if (Array.isArray(raw.actions) && raw.actions.length === 0) {
        console.log(json ? JSON.stringify({ ok: true, applied: [], dryRun: true }, null, 2) : "the curator proposed nothing");
        return;
      }
      const proposals = parseProposals(text, "the curator's output");
      const known = new Set(packet.cases.flatMap((c) => c.entries.map((e) => e.id)));
      const problems = [
        ...(proposals.mode !== "gather" ? [`the curator's mode is ${proposals.mode}, not gather`] : []),
        ...(proposals.packet !== packet.packet ? [`the proposals answer packet ${proposals.packet}, not ${packet.packet}`] : []),
        ...proposals.actions.flatMap((a, i) => subjects(a).filter((id) => !known.has(id)).map((id) => `${label(a, i)}: ${id} is not in the packet`)),
      ];
      if (problems.length) throw new ProposalsRefusedError(problems);
      const save = opt("--save")[0];
      if (save) await Bun.write(save, JSON.stringify(proposals, null, 2) + "\n");
      const applied = await applyProposals(root, proposals, save ? basename(save) : "curator output", { dryRun: true });
      if (json) console.log(JSON.stringify({ ok: true, dryRun: true, applied, saved: save ?? null }, null, 2));
      else {
        for (const a of applied) console.log(`${a.action} ${a.id}: ${a.result}`);
        console.log(`dry run: ${applied.length} action${applied.length === 1 ? "" : "s"} would apply; nothing written.${save ? ` To apply: remembrancer apply ${save}` : " Add --save F to keep them, then remembrancer apply F."}`);
      }
      return;
    }
    case "brief": {
      const root = findRoot();
      if (!root) {
        if (flag("--hook")) return;
        requireRoot();
      }
      const data = briefData(await loadProject(root!), new Date(), visibility(root!));
      console.log(json ? JSON.stringify(data, null, 2) : renderBrief(data));
      return;
    }
    case "show": {
      const ids = args.filter((a) => !a.startsWith("--"));
      if (!ids.length) fail(2, "usage: remembrancer show ID... [--links] [--json]", json);
      const project = await loadProject(requireRoot());
      const shown = ids.map((id) => show(project, id, { links: flag("--links") }));
      if (json) console.log(JSON.stringify(shown.length === 1 ? shown[0] : shown, null, 2));
      else console.log(shown.map(formatShown).join("\n\n"));
      return;
    }
    case "doctor": {
      const { problems, fixed } = await doctor(requireRoot(), { fix: flag("--fix") });
      if (json) console.log(JSON.stringify({ ok: problems.length === 0, problems, fixed }, null, 2));
      else {
        for (const f of fixed) console.log(`fixed: ${f}`);
        for (const p of problems) console.log(`${p.id ? `${p.id}: ` : ""}${p.message}`);
        if (!problems.length && !fixed.length) console.log("ok");
      }
      if (problems.length) process.exit(1);
      return;
    }
    case "lint": {
      if (flag("--hook")) {
        // A PostToolUse hook: stdin holds the tool call. Only edits under .remembrancer/ matter,
        // and exit code 2 shows the problems to the agent that made the edit.
        let path = "";
        try {
          path = JSON.parse(await Bun.stdin.text()).tool_input?.file_path ?? "";
        } catch {}
        const root = path.split(sep).includes(DIR) ? findRoot(dirname(path)) : null;
        if (!root) return;
        const problems = lint(await loadProject(root), { ids: flag("--ids") });
        if (problems.length) {
          const hint = HAND_EDIT_HINT[basename(path)] ?? HAND_EDIT_HINT[""];
          console.error(`remembrancer lint:\n${problems.map((p) => `${DIR}/${p.file}: ${p.id ?? "?"}: ${p.message}`).join("\n")}\n${hint}`);
          process.exit(2);
        }
        return;
      }
      const problems = lint(await loadProject(requireRoot()), { ids: flag("--ids") });
      if (json) {
        console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
        if (problems.length) process.exit(1);
        return;
      }
      for (const p of problems) console.log(`${DIR}/${p.file}: ${p.id ?? "?"}: ${p.message}`);
      if (problems.length) process.exit(1);
      console.log("ok");
      return;
    }
    case "guard": {
      let command = args.filter((a) => a !== "--hook").join(" ");
      let cwd = process.cwd();
      if (flag("--hook")) {
        try {
          const call = JSON.parse(await Bun.stdin.text());
          command = call.tool_input?.command ?? "";
          cwd = call.cwd || cwd;
        } catch {}
      }
      const reason = command ? await guard(command, cwd) : null;
      if (reason) {
        console.error(reason);
        process.exit(2);
      }
      return;
    }
    case "serve": {
      let port = 4747;
      let host = "127.0.0.1";
      const dirs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--port") port = parseInt(args[++i], 10);
        else if (args[i] === "--host") host = args[++i];
        else dirs.push(args[i]);
      }
      const roots = (dirs.length ? dirs : [process.cwd()]).map((d) => findRoot(resolve(d)) ?? resolve(d));
      const missing = roots.filter((r) => !findRoot(r));
      if (missing.length) {
        console.error(`no ${DIR}/ in: ${missing.join(", ")}`);
        process.exit(1);
      }
      const key = isLoopback(host) ? undefined : await accessKey();
      const server = serve([...new Set(roots)], port, { host, key });
      const shown = host === "0.0.0.0" || host === "::" ? hostname() : host.includes(":") ? `[${host}]` : host;
      const url = `http://${shown}:${server.port}/${key ? `?key=${key}` : ""}`;
      console.log(`remembrancer: ${url}`);
      if (key) {
        // A phone can only reach a non-loopback server; skip the code when output is not a terminal.
        if (process.stdout.isTTY) console.log(qrTerminal(url));
        console.log(`listening on ${host}: open the URL above once per browser (it sets a cookie).`);
        console.log(`plain HTTP: prefer a trusted network (LAN, VPN) or an SSH tunnel to 127.0.0.1.`);
      }
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
}

// Expected failures: a missing entry exits 1; a refused or stale write exits 2 and
// changed nothing. Anything else is a bug and keeps its stack trace.
try {
  await main(process.argv.slice(2));
} catch (err) {
  const json = process.argv.includes("--json");
  if (err instanceof NotFoundError) fail(1, err.message, json);
  if (err instanceof LintRefusedError) fail(2, err.message, json, err.problems);
  if (err instanceof ProposalsRefusedError) fail(2, err.message, json, err.problems.map((message) => ({ file: null, id: null, message })));
  if (err instanceof RefusedError || err instanceof ConflictError) fail(2, err.message, json);
  throw err;
}
