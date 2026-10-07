// The proposals queue: curator runs waiting for a person, in
// .remembrancer/proposals/ (git-ignored by doctor's lines). Each file sits
// beside its packet, so `show` can group actions by case. `apply` moves an
// applied file to applied/, `reject` to rejected/ with a log line.
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Packet } from "./curate";
import { LOG, type Proposals, readProposals } from "./proposals";
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
  const caseOf = new Map<string, { case: string; kind: string; evidence: string }>();
  for (const c of packet?.cases ?? []) for (const e of c.entries) caseOf.set(e.id, c);
  const title = (id: string) => project.byId.get(id.toUpperCase())?.[0]?.title ?? "(no entry)";
  const groups = new Map<string, string[]>();
  p.actions.forEach((a, i) => {
    const subject = (a.id ?? a.from ?? a.members?.[0] ?? "").toUpperCase();
    const c = caseOf.get(subject);
    const head = c ? `${c.case} (${c.kind}): ${c.evidence.slice(0, 120)}` : "(no case)";
    const ids = [a.id, a.from, ...(a.members ?? [])].filter((x): x is string => !!x);
    const detail =
      a.action === "cluster" ? `cluster "${a.label}"` : a.action === "link" ? `link ${a.rel} ${a.to} ${title(a.to!)}` : a.action === "retag" ? `retag +${(a.add ?? []).join(",")} -${(a.remove ?? []).join(",")}` : a.action === "flag" ? `flag: ${a.note}` : a.action;
    const lines = [`  ${i + 1}. ${detail}  (${a.why})`, ...ids.map((id) => `       ${id} ${title(id)}`)];
    groups.set(head, [...(groups.get(head) ?? []), ...lines]);
  });
  const header = `${basename(path)}: ${p.mode} by ${p.by}, ${p.made}, ${p.actions.length} action${p.actions.length === 1 ? "" : "s"}`;
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

