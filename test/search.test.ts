import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/init";
import { DIR, loadProject } from "../src/project";
import { ftsQuery, search } from "../src/search";
import { serve } from "../src/server";

let root: string;
const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const ids = async (q: string, o = {}) => search(await loadProject(root), q, o).map((h) => (h.via ? `${h.id}<${h.via}` : h.id));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-search-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
  await write(
    "todo.md",
    "# Todo\n\n## T001 · Seed the crossing from its ports\npriority: P1 · added: 2026-10-01 · tags: crossing\n\nThe seeds come from rules.\n\n" +
      "## T002 · Render the planet rings\npriority: P2 · added: 2026-10-01 · tags: rendering · phase: C\n\nShaders for the rings.\n",
  );
  await write(
    "answers.md",
    "# Answers\n\n## A003 · Re-seeding after a stall\nanswered: 2026-09-01 · superseded-by: A004\n\n**Question** How do we re-seed a stalled crossing?\n\n**Answer** Re-seed from the capture.\n\n" +
      "## A004 · Re-seeding dropped: it changes no outcome\nanswered: 2026-10-01 · supersedes: A003\n\n**Question** Does refining help?\n\n**Answer** No.\n",
  );
  await write("archive/done-2025.md", "# Archive: done\n\n## T005 · An old crossing study\ndone: 2025-01-01\n\nCrossing notes.\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("search", () => {
  test("plain words are an OR of quoted terms; FTS5 syntax passes through", () => {
    expect(ftsQuery("re-seed crossing")).toBe('"re-seed" OR "crossing"');
    expect(ftsQuery('"exact phrase" AND seed*')).toBe('"exact phrase" AND seed*');
  });

  test("stems: seeding finds seed", async () => {
    const hits = await ids("seeding");
    expect(hits).toContain("T001");
  });

  test("a superseded answer brings its current one, marked via", async () => {
    const hits = search(await loadProject(root), "stalled capture");
    expect(hits.map((h) => h.id)).toEqual(["A003", "A004"]);
    expect(hits[1].via).toBe("A003");
    expect(hits[1].entry.title).toBe("Re-seeding dropped: it changes no outcome");
  });

  test("--kind, --tag and --phase filter; the archive only with --all", async () => {
    expect(await ids("crossing", { kind: "T" })).toEqual(["T001"]);
    expect(await ids("crossing OR rings", { tag: "rendering" })).toEqual(["T002"]);
    expect(await ids("crossing OR rings", { phase: "c" })).toEqual(["T002"]);
    expect(await ids("crossing")).not.toContain("T005");
    expect(await ids("crossing", { all: true })).toContain("T005");
    expect(await ids("crossing", { k: 1 })).toHaveLength(1);
  });

  test("--neighbours adds links in and out; bad syntax is refused", async () => {
    const [hit] = search(await loadProject(root), "refining", { neighbours: true });
    expect(hit.id).toBe("A004");
    expect(hit.neighbours!.out).toEqual([{ rel: "supersedes", id: "A003", title: "Re-seeding after a stall" }]);
    expect(hit.neighbours!.in).toEqual([{ rel: "superseded-by", id: "A003", title: "Re-seeding after a stall" }]);
    await expect(loadProject(root).then((p) => search(p, '"unclosed'))).rejects.toThrow(/bad search syntax/);
  });

  test("the CLI and the UI endpoint return the same hits", async () => {
    const cli = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "search", "crossing", "--all", "--json"], { cwd: root });
    const fromCli = JSON.parse(cli.stdout.toString());
    const server = serve([root], 0);
    try {
      const fromUi = await (await fetch(`http://127.0.0.1:${server.port}/api/p/0/search?q=crossing&all=1`)).json();
      expect(fromUi).toEqual(fromCli);
      expect(fromUi.hits.map((h: any) => h.id)).toContain("T005");
      expect((await fetch(`http://127.0.0.1:${server.port}/api/p/0/search?q=`)).status).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});
