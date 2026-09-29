#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { brief } from "./brief";
import { init } from "./init";
import { lint } from "./analyse";
import { DIR, findRoot, loadProject, nextId } from "./project";
import { isLoopback, serve } from "./server";
import type { Kind } from "./model";

const USAGE = `remembrancer: per-project working memory for you and your agent

usage:
  remembrancer init [--local]        create ${DIR}/, exclude it from git, add the rules section
                                     to AGENTS.md (or CLAUDE.local.md with --local)
  remembrancer next T|Q|R            print the next free ID
  remembrancer brief [--hook]        session-start summary (--hook: print nothing if no ${DIR}/)
  remembrancer lint                  check the files for broken IDs, fields and links
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
      if (!["T", "Q", "R"].includes(kind)) {
        console.error("usage: remembrancer next T|Q|R  (answers reuse their question's number)");
        process.exit(2);
      }
      console.log(nextId(await loadProject(requireRoot()), kind as Kind));
      return;
    }
    case "brief": {
      const root = findRoot();
      if (!root) {
        if (flag("--hook")) return;
        requireRoot();
      }
      console.log(brief(await loadProject(root!)));
      return;
    }
    case "lint": {
      const problems = lint(await loadProject(requireRoot()));
      for (const p of problems) console.log(`${DIR}/${p.file}: ${p.id ?? "?"}: ${p.message}`);
      if (problems.length) process.exit(1);
      console.log("ok");
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
      console.log(`remembrancer: http://${shown}:${server.port}/${key ? `?key=${key}` : ""}`);
      if (key) {
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
