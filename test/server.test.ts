import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/init";
import { DIR } from "../src/project";
import { serve } from "../src/server";

let root: string;
let server: ReturnType<typeof serve>;
let base: string;
let token: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-srv-"));
  await init(root);
  await Bun.write(join(root, DIR, "todo.md"), "# Todo\n\n## T001 · a\npriority: P1 · added: 2026-09-01\n\nSee <b>bold</b> and Q001.\n");
  server = serve([root], 0);
  base = `http://127.0.0.1:${server.port}`;
  const html = await (await fetch(base + "/")).text();
  token = /name="token" content="([^"]+)"/.exec(html)![1];
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = { "x-token": token }) =>
  fetch(`${base}/api/p/0/op`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("pages carry a CSP that forbids inline script", async () => {
  const res = await fetch(base + "/");
  expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
});

test("data includes rendered entries with their file hash", async () => {
  const data = await (await fetch(`${base}/api/p/0`)).json();
  const t = data.entries.find((e: any) => e.id === "T001");
  expect(t.html).toContain("<b>bold</b>");
  expect(t.hash).toBe(data.files.find((f: any) => f.path === "todo.md").hash);
  expect(data.problems.some((p: any) => /Q001/.test(p.message))).toBe(true);
});

test("writes need the token and a local Host header", async () => {
  expect((await post({ op: "delete" }, {})).status).toBe(403);
  const res = await fetch(`${base}/api/p/0/op`, { method: "POST", headers: { host: "evil.example", "x-token": token }, body: "{}" });
  expect(res.status).toBe(403);
});

test("stale writes get 409 and leave the file alone; fresh writes land", async () => {
  const data = await (await fetch(`${base}/api/p/0`)).json();
  const t = data.entries.find((e: any) => e.id === "T001");
  const ref = { file: t.file, hash: "stale", index: t.index, id: t.id };
  expect((await post({ op: "meta", ref, updates: { priority: "P3" } })).status).toBe(409);
  const ok = await post({ op: "meta", ref: { ...ref, hash: t.hash }, updates: { priority: "P3" } });
  expect(ok.status).toBe(200);
  expect(await Bun.file(join(root, DIR, "todo.md")).text()).toContain("priority: P3 · added: 2026-09-01");
});

test("file paths outside .remembrancer are refused", async () => {
  const res = await post({ op: "file", file: "../AGENTS.md", hash: "x", text: "pwned" });
  expect(res.status).toBe(404);
});
