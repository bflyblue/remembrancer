// `curate --eval DIR`: how well a curator does on a packet with known good
// answers (DIR/packet.json and DIR/gold.json). Actions are compared by kind
// and the IDs they name (never by their why, tags or label); clusters also by
// how much their member sets overlap; and every action is dry-run alone.
import { join } from "node:path";
import { type Packet, callCurator, packetProblems } from "./curate";
import { type Action, type Proposals, actionIds, applyProposals, parseProposals } from "./proposals";
import { RefusedError } from "./project";

export interface Score {
  curator: string;
  seconds: number;
  error?: string; // the curator failed or its output was refused whole
  byAction: { action: string; gold: number; predicted: number; matched: number; precision: number | null; recall: number | null }[];
  total: { gold: number; predicted: number; matched: number; precision: number; recall: number; f1: number };
  clusterAgreement: number | null; // mean, over gold clusters, of the best Jaccard with a predicted cluster
  accepted: { ok: number; of: number }; // actions a dry run accepts, each alone
  leftAlone: { gold: number; respected: number }; // gold cases with no action, and how many the curator also left alone
}

// What an action is, for matching: its kind and the set of IDs it names.
export function actionKey(a: Action): string {
  // A condense matches on its sources alone: its new text is not compared.
  const ids = [...actionIds(a), ...(a.to ? [a.to.toUpperCase()] : [])];
  return `${a.action} ${[...new Set(ids)].sort().join(",")}`;
}

const jaccard = (a: string[], b: string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  const both = [...x].filter((v) => y.has(v)).length;
  return both / (x.size + y.size - both || 1);
};

const round = (n: number) => Math.round(n * 100) / 100;

export function score(curator: string, gold: Action[], predicted: Action[], packet: Packet): Omit<Score, "seconds" | "accepted"> {
  const goldKeys = gold.map(actionKey);
  const predKeys = predicted.map(actionKey);
  const kinds = [...new Set([...gold, ...predicted].map((a) => a.action))].sort();
  const count = (keys: string[], kind?: string) => keys.filter((k) => !kind || k.startsWith(kind + " "));
  const matched = (kind?: string) => {
    const pool = [...count(goldKeys, kind)];
    let n = 0;
    for (const k of count(predKeys, kind)) {
      const i = pool.indexOf(k);
      if (i >= 0) {
        pool.splice(i, 1);
        n++;
      }
    }
    return n;
  };
  const byAction = kinds.map((kind) => {
    const g = count(goldKeys, kind).length;
    const p = count(predKeys, kind).length;
    const m = matched(kind);
    return { action: kind, gold: g, predicted: p, matched: m, precision: p ? round(m / p) : null, recall: g ? round(m / g) : null };
  });
  const m = matched();
  const precision = predKeys.length ? m / predKeys.length : goldKeys.length ? 0 : 1;
  const recall = goldKeys.length ? m / goldKeys.length : predKeys.length ? 0 : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const goldClusters = gold.filter((a) => a.action === "cluster").map((a) => a.members!.map((x) => x.toUpperCase()));
  const predClusters = predicted.filter((a) => a.action === "cluster").map((a) => a.members!.map((x) => x.toUpperCase()));
  const clusterAgreement = goldClusters.length
    ? round(goldClusters.reduce((s, g) => s + Math.max(0, ...predClusters.map((p) => jaccard(g, p))), 0) / goldClusters.length)
    : null;
  // A case is left alone when no action names any of its entries.
  const touches = (actions: Action[], ids: Set<string>) => actions.some((a) => actionIds(a).some((x) => ids.has(x)));
  const quiet = packet.cases.filter((c) => !touches(gold, new Set(c.entries.map((e) => e.id))));
  const respected = quiet.filter((c) => !touches(predicted, new Set(c.entries.map((e) => e.id)))).length;
  return {
    curator,
    byAction,
    total: { gold: goldKeys.length, predicted: predKeys.length, matched: m, precision: round(precision), recall: round(recall), f1: round(f1) },
    clusterAgreement,
    leftAlone: { gold: quiet.length, respected },
  };
}

// Each action dry-run on its own against the project, without its `if` (the
// eval packet may be older than the project: this measures the curator).
async function acceptance(root: string, p: Proposals): Promise<{ ok: number; of: number }> {
  let ok = 0;
  for (const a of p.actions) {
    const { if: _, ...action } = a;
    try {
      await applyProposals(root, { ...p, actions: [action as Action] }, "eval", { dryRun: true });
      ok++;
    } catch (err) {
      if (!(err instanceof RefusedError)) throw err;
    }
  }
  return { ok, of: p.actions.length };
}

export async function evaluate(root: string, dir: string, curators: string[]): Promise<Score[]> {
  const packet = (await Bun.file(join(dir, "packet.json")).json()) as Packet;
  const gold = parseProposals(await Bun.file(join(dir, "gold.json")).text(), join(dir, "gold.json"));
  const out: Score[] = [];
  for (const curator of curators) {
    let predicted: Proposals | null = null;
    let seconds = 0;
    let error: string | undefined;
    try {
      const r = await callCurator(curator, packet, { quiet: true });
      predicted = r.proposals;
      seconds = r.seconds;
      const problems = predicted ? packetProblems(predicted, packet) : [];
      if (problems.length) throw new RefusedError(problems.join("; "));
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      error = err.message.split("\n")[0];
      predicted = null;
    }
    const s = score(curator, gold.actions, predicted?.actions ?? [], packet);
    out.push({ ...s, seconds, ...(error ? { error } : {}), accepted: predicted ? await acceptance(root, predicted) : { ok: 0, of: 0 } });
  }
  return out;
}

export function formatScores(scores: Score[]): string {
  const f = (n: number | null) => (n === null ? "    –" : n.toFixed(2).padStart(5));
  return scores
    .map((s) => {
      const lines = [`curator: ${s.curator}  (${s.seconds}s)${s.error ? `\n  failed: ${s.error}` : ""}`, "  action     gold  pred  match  precision  recall"];
      for (const a of s.byAction) lines.push(`  ${a.action.padEnd(9)} ${String(a.gold).padStart(5)} ${String(a.predicted).padStart(5)} ${String(a.matched).padStart(6)}      ${f(a.precision)}   ${f(a.recall)}`);
      const t = s.total;
      lines.push(`  ${"all".padEnd(9)} ${String(t.gold).padStart(5)} ${String(t.predicted).padStart(5)} ${String(t.matched).padStart(6)}      ${f(t.precision)}   ${f(t.recall)}   F1 ${t.f1.toFixed(2)}`);
      lines.push(`  cluster agreement (best Jaccard per gold cluster): ${s.clusterAgreement === null ? "–" : s.clusterAgreement.toFixed(2)}`);
      lines.push(`  dry-run acceptance: ${s.accepted.ok}/${s.accepted.of}${s.accepted.of ? ` (${(s.accepted.ok / s.accepted.of).toFixed(2)})` : ""}`);
      lines.push(`  cases to leave alone: ${s.leftAlone.respected} of ${s.leftAlone.gold} left alone`);
      return lines.join("\n");
    })
    .join("\n\n");
}
