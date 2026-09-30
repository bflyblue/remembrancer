#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { brief } from "./brief";
import { guard } from "./guard";
import { init } from "./init";
import { lint } from "./analyse";
import { DIR, claimId, findRoot, loadProject, nextId, visibility } from "./project";
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
  remembrancer brief [--hook]        session-start summary, including whether git ignores ${DIR}/
                                     (and so whether IDs may appear in commits). --hook: print
                                     nothing if there is no ${DIR}/
  remembrancer lint [--ids] [--hook] check the files for broken IDs, fields and links
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
    case "brief": {
      const root = findRoot();
      if (!root) {
        if (flag("--hook")) return;
        requireRoot();
      }
      console.log(brief(await loadProject(root!), new Date(), visibility(root!)));
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
          console.error(`remembrancer lint:\n${problems.map((p) => `${DIR}/${p.file}: ${p.id ?? "?"}: ${p.message}`).join("\n")}`);
          process.exit(2);
        }
        return;
      }
      const problems = lint(await loadProject(requireRoot()), { ids: flag("--ids") });
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

await main(process.argv.slice(2));
