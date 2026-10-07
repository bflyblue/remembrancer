// The proposals queue: curator runs waiting for a person, in
// .remembrancer/proposals/ (git-ignored by doctor's lines). Each file sits
// beside its packet, so `show` can group actions by case. `apply` moves an
// applied file to applied/, `reject` to rejected/ with a log line.
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Packet } from "./curate";
import { type Action, LOG, type Proposals, actionIds, readProposals } from "./proposals";
import { DIR, NotFoundError, type Project, RefusedError } from "./project";

export const QUEUE = "proposals";

const queueDir = (root: string) => resolve(root, DIR, QUEUE);
const packetOf = (path: string) => path.replace(/\.json$/, ".packet.json");

// Write proposals (and the packet they answer) to the queue; returns the file name.
export async function enqueue(root: string, p: Proposals, packet: Packet | null): Promise<string> {
  await mkdir(queueDir(root), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15); // 20261007T183012
  let name = `${stamp}-${p.mode}.json`;
  for (let n = 2; existsSync(join(queueDir(root), name)); n++) name = `${stamp}-${p.mode}-${n}.json`;
  await Bun.write(join(queueDir(root), name), JSON.stringify(p, null, 2) + "\n");
  if (packet) await Bun.write(packetOf(join(queueDir(root), name)), JSON.stringify(packet, null, 2) + "\n");
  return name;
}

// A queued file by name (or a path to one).
export function resolveQueued(root: string, name: string): string | null {
  const path = name.includes("/") ? resolve(name) : join(queueDir(root), name);
  return existsSync(path) && dirname(path) === queueDir(root) ? path : null;
}

export interface Queued {
  name: string;
  mode: string;
  by: string;
  made: string;
  actions: number;
  packet: string | null;
}

export async function listQueue(root: string): Promise<Queued[]> {
  if (!existsSync(queueDir(root))) return [];
  const names = readdirSync(queueDir(root)).filter((f) => f.endsWith(".json") && !f.endsWith(".packet.json")).sort();
  const out: Queued[] = [];
  for (const name of names) {
    try {
      const p = await readProposals(join(queueDir(root), name));
      out.push({ name, mode: p.mode, by: p.by, made: p.made, actions: p.actions.length, packet: p.packet ?? null });
    } catch {
      out.push({ name, mode: "?", by: "?", made: "?", actions: 0, packet: null });
    }
  }
  return out;
}

// The actions grouped by the case whose entries they name, with titles.
export async function showQueued(root: string, project: Project, name: string): Promise<string> {
  const path = resolveQueued(root, name);
  if (!path) throw new NotFoundError(`no queued proposals ${name} (remembrancer proposals list)`);
  const p = await readProposals(path);
  const packet = existsSync(packetOf(path)) ? ((await Bun.file(packetOf(path)).json()) as Packet) : null;
  return renderProposals(project, p, packet, `${basename(path)}: ${p.mode} by ${p.by}, ${p.made}, ${p.actions.length} action${p.actions.length === 1 ? "" : "s"}`);
}

// A partial run's file, as the curator appends it: one line per case answered or skipped.
export const partialPath = (root: string, packetId: string) => join(root, DIR, "log", `partial-${packetId}.jsonl`);
const partialPacket = (path: string) => path.replace(/\.jsonl$/, ".packet.json");

// The newest partial run, shown like a queued one, with how far it has got.
export async function showPartial(root: string, project: Project): Promise<string> {
  const dir = join(root, DIR, "log");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^partial-.*\.jsonl$/.test(f)).map((f) => join(dir, f)) : [];
  if (!files.length) throw new NotFoundError("no partial run: one is written while curate --curator runs");
  const path = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const lines = (await Bun.file(path).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { case: string; n: number; total: number; actions?: Action[]; skipped?: string[] });
  const packet = existsSync(partialPacket(path)) ? ((await Bun.file(partialPacket(path)).json()) as Packet) : null;
  const actions = lines.flatMap((l) => l.actions ?? []);
  const skipped = lines.filter((l) => l.skipped).map((l) => `${l.case}: ${l.skipped!.join("; ")}`);
  const last = lines.at(-1);
  const header = `${basename(path)}: ${packet?.mode ?? "?"} run in progress or stopped, ${lines.length} of ${last?.total ?? "?"} cases answered (${skipped.length} skipped), ${actions.length} action${actions.length === 1 ? "" : "s"} so far`;
  const body = renderProposals(project, { mode: packet?.mode ?? "gather", packet: packet?.packet ?? "", made: "", by: "", actions } as Proposals, packet, header);
  return skipped.length ? `${body}\n\nskipped:\n  ${skipped.join("\n  ")}` : body;
}

function renderProposals(project: Project, p: Proposals, packet: Packet | null, header: string): string {
  const caseOf = new Map<string, { case: string; kind: string; evidence: string }>();
  for (const c of packet?.cases ?? []) for (const e of c.entries) caseOf.set(e.id, c);
  const title = (id: string) => project.byId.get(id.toUpperCase())?.[0]?.title ?? "(no entry)";
  const groups = new Map<string, string[]>();
  p.actions.forEach((a, i) => {
    const ids = actionIds(a);
    const subject = ids[0] ?? "";
    const c = caseOf.get(subject);
    const head = c ? `${c.case} (${c.kind}): ${c.evidence.slice(0, 120)}` : "(no case)";
    const detail =
      a.action === "cluster" ? `cluster "${a.label}"` : a.action === "condense" ? `condense into ${a.into!.kind} "${a.into!.title}" (${a.dest ?? "active"})` : a.action === "link" ? `link ${a.rel} ${a.to} ${title(a.to!)}` : a.action === "retag" ? `retag +${(a.add ?? []).join(",")} -${(a.remove ?? []).join(",")}` : a.action === "flag" ? `flag: ${a.note}` : a.action;
    const lines = [`  ${i + 1}. ${detail}  (${a.why})`, ...ids.map((id) => `       ${id} ${title(id)}`)];
    groups.set(head, [...(groups.get(head) ?? []), ...lines]);
  });
  return [header, ...[...groups].flatMap(([head, lines]) => ["", head, ...lines])].join("\n");
}

async function log(root: string, line: string) {
  await mkdir(join(root, DIR, "log"), { recursive: true });
  const path = join(root, DIR, LOG);
  const start = existsSync(path) ? "" : "# Curation log\n\nOne line per applied action, oldest first. Append-only: `remembrancer apply` writes it.\n\n";
  await appendFile(path, start + line + "\n");
}

function move(root: string, path: string, to: "rejected" | "applied") {
  const dir = join(queueDir(root), to);
  mkdirSync(dir, { recursive: true });
  renameSync(path, join(dir, basename(path)));
  if (existsSync(packetOf(path))) renameSync(packetOf(path), join(dir, basename(packetOf(path))));
}

export async function rejectQueued(root: string, name: string, why: string) {
  const path = resolveQueued(root, name);
  if (!path) throw new NotFoundError(`no queued proposals ${name} (remembrancer proposals list)`);
  if (!why.trim() || why.includes("\n")) throw new RefusedError("give the reason in one line: --why \"…\"");
  const p = await readProposals(path);
  move(root, path, "rejected");
  await log(root, `- ${new Date().toISOString().slice(0, 16)}Z rejected ${basename(path)} (${p.mode} by ${p.by}, ${p.actions.length} actions): ${why.trim()}`);
}

// After `apply` of a queued file.
export function markApplied(root: string, path: string) {
  move(root, path, "applied");
}

