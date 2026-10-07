#!/usr/bin/env bun
// A curator through Claude Code (claude -p), for comparing Claude models with local ones. Like Pi, it has no
// structured output here, so the schema goes in the prompt and the reply is checked (and retried once).
//
//   REMEMBRANCER_CLAUDE_MODEL   a model claude -p accepts, e.g. claude-sonnet-5-5   optional (Claude Code's default)
//
// It runs from an empty directory with no tools, so no project instructions, memory or plugin brief reach it.
// Usage: remembrancer curate --eval DIR --curator "sh curators/claude.sh"
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ask, runCurator } from "./lib";

const model = process.env.REMEMBRANCER_CLAUDE_MODEL?.trim() || null;
const cwd = mkdtempSync(join(tmpdir(), "rmb-claude-"));

const ask: Ask = async (messages, schema) => {
  const [system, ...rest] = messages;
  const prompt = [
    ...rest.map((m) => (m.role === "user" ? m.content : `Your earlier answer:\n${m.content}`)),
    `Answer with one JSON object matching this JSON schema, and nothing else:\n${JSON.stringify(schema)}`,
  ].join("\n\n");
  const args = ["claude", "-p", ...(model ? ["--model", model] : []), "--system-prompt", system.content, "--tools", ""];
  const proc = Bun.spawn(args, { cwd, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`claude exited ${code}: ${err.slice(0, 300)}`);
  return out;
};

await runCurator(ask, `claude:${model ?? "default"}`);
