// The UI's endpoints for slice 12: reading (signals, checks, the queue) and the basic locked writes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue } from "../src/queue";
import { init } from "../src/init";
import { DIR, loadProject } from "../src/project";
import { serve } from "../src/server";

let root: string;
let server: ReturnType<typeof serve>;
let base: string;
let token: string;
const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const get = async (path: string) => (await fetch(`${base}/api/p/0${path}`)).json();
const post = (body: unknown) => fetch(`${base}/api/p/0/op`, { method: "POST", headers: { "content-type": "application/json", "x-token": token }, body: JSON.stringify(body) });
const refFor = async (id: string) => {
  const e = (await get("")).entries.find((x: any) => x.id === id);
  return { file: e.file, hash: e.hash, index: e.index, id: e.id, entry: e.entry };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-ui-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
  await write("config.json", '{"owner": "shaun"}\n');
  await write("todo.md", "# Todo\n\n## T001 · ship it\npriority: P1 · added: 2026-10-01 · waiting-on: shaun\n\n## T002 · old idea\npriority: P3 · added: 2025-01-01\n");
  await write("questions.md", "# Questions\n\n## Q003 · Which way?\nasked: 2026-10-01\n\nLeft or right.\n");
  await write("rules.md", "# Rules\n\n## R004 · Keep it small\nscope: code · form: invariant · status: active · added: 2026-10-01 · enforced-by: cmd: true\n");
  await write("done.md", "# Done\n\n## T005 · a theme\ndone: 2026-10-01 · kind: theme · condensed-from: T006\n\nFrom T006.\n");
  await write("archive/done-2026.md", "# Archive: done\n\n## T006 · a source\ndone: 2026-09-01 · condensed-into: T005\n\nOld.\n");
  await write("log/checks.json", JSON.stringify({ R004: { status: "fail", at: "2026-10-07T10:00Z", message: "exit 1" } }));
  server = serve([root], 0);
  base = `http://127.0.0.1:${server.port}`;
  token = /name="token" content="([^"]+)"/.exec(await (await fetch(base + "/")).text())![1];
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("reading", () => {
  test("the data carries what waits on the owner, the checks, stale entries and the queue", async () => {
    const d = await get("");
    expect(d.brief.owner).toBe("shaun");
    expect(d.brief.waiting.map((e: any) => e.id)).toEqual(["T001"]);
    expect(d.brief.checks).toEqual({ pass: 0, fail: 1, unrunnable: 0, notRun: 0 });
    expect(d.checks.R004.status).toBe("fail");
    expect(d.stale.map((s: any) => s.id)).toContain("T002");
    expect(d.queue).toEqual([]);
    const source = d.entries.find((e: any) => e.id === "T006");
    expect(source.meta["condensed-into"]).toBe("T005");
    expect(d.entries.find((e: any) => e.id === "T005").meta.kind).toBe("theme");
  });

  test("the search endpoint ranks, archive included", async () => {
    const res = await get("/search?q=source&all=1");
    expect(res.hits[0].id).toBe("T006");
    expect(res.hits.map((h: any) => h.id)).toContain("T005"); // via its condensed-into
  });

  test("the queue: a list, and one file as proposals show prints it", async () => {
    const name = await enqueue(root, { mode: "gather", packet: null, made: "2026-10-07", by: "test", actions: [{ action: "flag", id: "Q003", note: "decide", why: "w" }] }, null);
    expect((await get("/proposals")).queue.map((q: any) => q.name)).toEqual([name]);
    const one = await get(`/proposals?name=${name}`);
    expect(one.proposals.actions).toHaveLength(1);
    expect(one.show).toContain("flag: decide");
    expect(one.show).toContain("Q003 Which way?");
    expect((await fetch(`${base}/api/p/0/proposals?name=nope.json`)).status).toBe(404);
  });

  test("the page and its script are served", async () => {
    const js = await (await fetch(base + "/app.js")).text();
    expect(js).toContain('key: "queue"');
    expect(js).toContain("checksSummary");
  });
});

describe("basic locked writes", () => {
  test("mark stale sets suggest: archive, and unmark clears it", async () => {
    expect((await post({ op: "meta", ref: await refFor("T002"), updates: { suggest: "archive" } })).status).toBe(200);
    expect((await loadProject(root)).byId.get("T002")![0].meta.suggest).toBe("archive");
    expect((await post({ op: "meta", ref: await refFor("T002"), updates: { suggest: "" } })).status).toBe(200);
    expect((await loadProject(root)).byId.get("T002")![0].meta.suggest).toBeUndefined();
  });

  test("close a question through answer: sections checked, the question removed", async () => {
    const ref = await refFor("Q003");
    const bad = await post({ op: "answer", ref, title: "Left", text: "**Answer:** left." });
    expect(bad.status).toBe(422);
    const ok = await post({ op: "answer", ref, title: "Left", text: "**Answer:** left.\n\n**Why:** shorter.\n\n**Alternatives considered:** right." });
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toBe("A003");
    const p = await loadProject(root);
    expect(p.byId.get("Q003")).toBeUndefined();
    expect(p.byId.get("A003")![0].body).toStartWith("**Question** Which way? (Q003)");
  });

  test("apply and reject a queued file", async () => {
    const a = await enqueue(root, { mode: "gather", packet: null, made: "2026-10-07", by: "test", actions: [{ action: "retag", id: "T001", add: ["ship"], why: "w" }] }, null);
    const applied = await post({ op: "proposals-apply", name: a });
    expect(applied.status).toBe(200);
    expect((await loadProject(root)).byId.get("T001")![0].meta.tags).toBe("ship");
    expect(existsSync(join(root, DIR, "proposals", "applied", a))).toBe(true);
    const rejected = (await get("/proposals")).queue[0].name;
    expect((await post({ op: "proposals-reject", name: rejected, why: "" })).status).toBe(422);
    expect((await post({ op: "proposals-reject", name: rejected, why: "not now" })).status).toBe(200);
    expect((await get("/proposals")).queue).toEqual([]);
  });
});
