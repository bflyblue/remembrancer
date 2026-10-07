#!/usr/bin/env bun
// A gather curator through Pi (pi -p), for models Pi already knows how to
// reach. Pi has no structured output, so the schema goes in the prompt and
// the reply is checked (and retried once) like any other.
//
//   REMEMBRANCER_PI_MODEL     Pi's model pattern, e.g. ceres-vllm-0/qwen3.8-flash-next   optional (Pi's default)
//   REMEMBRANCER_PI_THINKING  Pi's thinking level (default off)                           optional
//
// Usage: remembrancer curate --mode gather --curator "sh curators/pi.sh" --save p.json
import { type Ask, runCurator } from "./lib";

// Unset, Pi uses its own default model.
const model = process.env.REMEMBRANCER_PI_MODEL?.trim() || null;
const thinking = process.env.REMEMBRANCER_PI_THINKING?.trim() || "off";

const ask: Ask = async (messages, schema) => {
  const [system, ...rest] = messages;
  // One prompt: the conversation so far, then the shape the answer must have.
  const prompt = [
    ...rest.map((m) => (m.role === "user" ? m.content : `Your earlier answer:\n${m.content}`)),
    `Answer with one JSON object matching this JSON schema, and nothing else:\n${JSON.stringify(schema)}`,
  ].join("\n\n");
  const args = ["pi", "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
    ...(model ? ["--model", model] : []), "--thinking", thinking, "--system-prompt", system.content, prompt];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`pi exited ${code}: ${err.slice(0, 300)}`);
  return out;
};

await runCurator(ask, `pi:${model ?? "default"}`);
