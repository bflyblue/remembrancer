import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPacket } from "../src/curate";
import { evaluate } from "../src/eval";
import { init } from "../src/init";
import { DIR, loadProject } from "../src/project";

let root: string;
const write = (rel: string, text: string) => Bun.write(join(root, DIR, rel), text);
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const run = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: root });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const todo = (id: string, title: string, meta = "") => `## ${id} · ${title}\npriority: P2 · added: 2026-10-01${meta}\n\nAbout ${title.toLowerCase()}.\n`;

// A curator that prints fixed proposals for whatever packet it is given.
async function curator(name: string, actions: object[]) {
  const path = join(root, `${name}.ts`);
  await Bun.write(path, `const p = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ mode: "gather", packet: p.packet, made: "2026-10-07", by: "${name}", actions: ${JSON.stringify(actions)} }));`);
  return `bun ${path}`;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "remembrancer-eval-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  await init(root);
  await write("config.json", '{"owner": "shaun"}\n');
  await write(
    "todo.md",
    "# Todo\n\n" +
      [
        todo("T001", "Radiator panel sizing", " · tags: radiators"),
        todo("T002", "Radiator mass budget", " · tags: radiators"),
        todo("T003", "Heat pipe layout", " · tags: radiators"),
        "## T004 · a quick thought\nstatus: inbox · added: 2026-10-01\n",
      ].join("\n"),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const CLUSTER = { action: "cluster", label: "radiators", members: ["T001", "T002", "T003"], why: "radiators" };
const FLAG = { action: "flag", id: "T004", note: "needs a priority", why: "inbox" };

describe("curate --eval", () => {
  test("gold echoed scores 1, nothing scores 0, a cluster one member off scores below 1", async () => {
    const dir = join(root, "eval");
    const packet = buildPacket(await loadProject(root));
    await Bun.write(join(dir, "packet.json"), JSON.stringify(packet));
    await Bun.write(join(dir, "gold.json"), JSON.stringify({ mode: "gather", packet: packet.packet, made: "2026-10-07", by: "gold", actions: [CLUSTER, FLAG] }));
    const [gold, empty, near] = await evaluate(root, dir, [
      await curator("gold", [CLUSTER, FLAG]),
      await curator("empty", []),
      await curator("near", [{ ...CLUSTER, members: ["T001", "T002"] }, FLAG]),
    ]);
    expect(gold.total).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(gold.clusterAgreement).toBe(1);
    expect(gold.accepted).toEqual({ ok: 2, of: 2 });
    expect(empty.total.f1).toBe(0);
    expect(empty.clusterAgreement).toBe(0);
    expect(near.clusterAgreement).toBe(0.67);
    expect(near.total.f1).toBeLessThan(1);
    expect(near.byAction.find((a) => a.action === "flag")).toMatchObject({ precision: 1, recall: 1 });
    const out = run("curate", "--eval", dir, "--curator", await curator("gold2", [CLUSTER, FLAG])).out;
    expect(out).toContain("F1 1.00");
    expect(out).toContain("dry-run acceptance: 2/2 (1.00)");
  });
});

describe("the queue and --apply", () => {
  test("--queue applies nothing; list, show by case, reject logs and moves the file", async () => {
    const before = await Bun.file(join(root, DIR, "todo.md")).text();
    const q = run("curate", "--mode", "gather", "--curator", await curator("q", [CLUSTER, FLAG]), "--queue");
    expect(q.code).toBe(0);
    expect(await Bun.file(join(root, DIR, "todo.md")).text()).toBe(before);
    const name = /queued 2 actions as (\S+):/.exec(q.out)![1];
    expect(run("proposals").out).toBe(`${name}  gather by q, 2026-10-07, 2 actions\n`);
    const shown = run("proposals", "show", name).out;
    expect(shown).toMatch(/c\d+ \(similar\): shared tag radiators/);
    expect(shown).toContain('cluster "radiators"  (radiators)');
    expect(shown).toContain("       T002 Radiator mass budget");
    expect(shown).toMatch(/c\d+ \(inbox\)/);
    expect(run("proposals", "reject", name).code).toBe(2);
    expect(run("proposals", "reject", name, "--why", "not now").code).toBe(0);
    expect(existsSync(join(root, DIR, "proposals", "rejected", name))).toBe(true);
    expect(run("proposals").out).toBe("the queue is empty\n");
    expect(await Bun.file(join(root, DIR, "log/curation.md")).text()).toContain(`rejected ${name} (gather by q, 2 actions): not now`);
  });

  test("apply NAME applies a queued file and moves it to applied/", async () => {
    const q = run("curate", "--mode", "gather", "--curator", await curator("q", [FLAG]), "--queue");
    const name = /as (\S+):/.exec(q.out)![1];
    expect(run("apply", name).code).toBe(0);
    expect((await loadProject(root)).byId.get("T004")![0].meta["waiting-on"]).toBe("shaun");
    expect(existsSync(join(root, DIR, "proposals", "applied", name))).toBe(true);
  });

  test("--apply applies a gather run whose dry run is clean, and refuses one that is not, changing nothing", async () => {
    const before = await Bun.file(join(root, DIR, "todo.md")).text();
    const bad = run("curate", "--mode", "gather", "--curator", await curator("bad", [FLAG, { action: "link", from: "T001", rel: "refs", to: "T999", why: "w" }]), "--apply");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("no entry T999");
    expect(await Bun.file(join(root, DIR, "todo.md")).text()).toBe(before);
    const good = run("curate", "--mode", "gather", "--curator", await curator("good", [CLUSTER]), "--apply");
    expect(good.code).toBe(0);
    expect(good.out).toContain("applied 1; logged in");
    expect((await loadProject(root)).byId.get("T001")![0].meta.tags).toBe("radiators, c-radiators");
  });
});
