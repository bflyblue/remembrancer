// Remembrancer for the pi coding agent: the same two hooks as for Claude Code.
// - Session start: the `remembrancer brief` is added to the context before the first prompt.
// - After an edit or write under .remembrancer/: `remembrancer lint --ids` runs, and any
//   problems are appended to that tool's result so the agent sees them.
// Install: symlink this file into ~/.pi/agent/extensions/ and the skill/ directory
// into ~/.pi/agent/skills/remembrancer. Needs `remembrancer` on PATH (or REMEMBRANCER_BIN).
// @ts-nocheck

import { execFile } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BIN = process.env.REMEMBRANCER_BIN || "remembrancer";
const DIR = ".remembrancer";

function run(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    execFile(BIN, args, { cwd, timeout: 10_000 }, (err, stdout) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout ?? "") });
    });
  });
}

export default function remembrancer(pi: ExtensionAPI) {
  let briefPending = false;

  pi.on("session_start", async () => {
    briefPending = true;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!briefPending) return;
    briefPending = false;
    // `--hook` prints nothing when the project has no .remembrancer/.
    const { code, stdout } = await run(["brief", "--hook"], ctx.cwd);
    if (code !== 0 || !stdout.trim()) return;
    return { message: { customType: "remembrancer-brief", content: stdout.trim(), display: false } };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const path = typeof event.input?.path === "string" ? resolve(ctx.cwd, event.input.path) : "";
    if (!path.split(sep).includes(DIR)) return;
    const { code, stdout } = await run(["lint", "--ids"], dirname(path));
    if (code === 0 || !stdout.trim()) return;
    const note = { type: "text", text: `\n\nremembrancer lint:\n${stdout.trim()}` };
    return { content: [...(Array.isArray(event.content) ? event.content : []), note] };
  });
}
