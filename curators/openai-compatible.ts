#!/usr/bin/env bun
// A gather curator for any OpenAI-compatible chat-completions API (vLLM,
// llama.cpp, ollama, LM Studio, OpenAI): one request per case, with the
// answer's JSON schema as structured output.
//
//   REMEMBRANCER_LLM_URL     base URL, up to /v1 (e.g. http://ceres:8000/v1)   required
//   REMEMBRANCER_LLM_MODEL   the model's ID on that server                    required
//   REMEMBRANCER_LLM_KEY     API key, sent as a Bearer token                  optional
//   REMEMBRANCER_LLM_FORMAT  json_schema (default), json_object, or none      optional
//   REMEMBRANCER_LLM_EXTRA   JSON merged into each request body               optional
//                            (e.g. {"chat_template_kwargs": {"enable_thinking": false}})
//
// Usage: remembrancer curate --mode gather --curator "bun curators/openai-compatible.ts" --save p.json
import { type Ask, runCurator } from "./lib";

const env = (name: string) => process.env[name]?.trim() || undefined;
const url = env("REMEMBRANCER_LLM_URL");
const model = env("REMEMBRANCER_LLM_MODEL");
if (!url || !model) {
  console.error("set REMEMBRANCER_LLM_URL (e.g. http://localhost:8000/v1) and REMEMBRANCER_LLM_MODEL");
  process.exit(2);
}
const key = env("REMEMBRANCER_LLM_KEY");
const format = env("REMEMBRANCER_LLM_FORMAT") ?? "json_schema";
let extra: Record<string, unknown> = {};
try {
  extra = JSON.parse(env("REMEMBRANCER_LLM_EXTRA") ?? "{}");
} catch {
  console.error("REMEMBRANCER_LLM_EXTRA is not JSON");
  process.exit(2);
}

export function requestBody(messages: Parameters<Ask>[0], schema: object): Record<string, unknown> {
  const response_format =
    format === "json_schema"
      ? { type: "json_schema", json_schema: { name: "gather_actions", schema, strict: false } }
      : format === "json_object"
        ? { type: "json_object" }
        : undefined;
  return { model, messages, temperature: 0, ...(response_format ? { response_format } : {}), ...extra };
}

const ask: Ask = async (messages, schema) => {
  const res = await fetch(`${url!.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(requestBody(messages, schema)),
  });
  if (!res.ok) throw new Error(`${res.status} from the server: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("the reply has no choices[0].message.content");
  return content;
};

await runCurator(ask, `openai-compatible:${model}`);
