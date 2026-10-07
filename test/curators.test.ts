import { describe, expect, test } from "bun:test";
import { type PacketCase, checkAnswer } from "../curators/lib";

// A similar case as a gather packet holds it: T012 already cites A034 in its
// refs, Q020 is an open question, R001 a rule, T013 cites nothing.
const c: PacketCase = {
  case: "c1",
  kind: "similar",
  evidence: "both refer to A034",
  allowed: ["cluster", "link", "retag", "flag", "archive"],
  entries: [
    { id: "T012", kind: "T", title: "Radiator panel sizing", meta: { priority: "P2", refs: "A034" }, body: "Size the panels.", hash: "h12" },
    { id: "T013", kind: "T", title: "Radiator mass budget", meta: { priority: "P2" }, body: "Budget the mass.", hash: "h13" },
    { id: "A034", kind: "A", title: "Panels radiate from both faces", meta: { answered: "2026-10-01" }, body: "**Answer** Both faces. See T013 for the budget.", hash: "h34" },
    { id: "Q020", kind: "Q", title: "How hot may the panels run?", meta: { asked: "2026-10-01" }, body: "Open.", hash: "h20" },
    { id: "R001", kind: "R", title: "Cite the source", meta: { status: "active" }, body: "Always.", hash: "h01" },
  ],
};
const link = (from: string, rel: string, to: string) => ({ action: "link", from, rel, to, why: "the text says so" });

describe("checkAnswer drops links the records already hold", () => {
  test("a refs the source already names, in its metadata or its body", () => {
    const r = checkAnswer({ actions: [link("T012", "refs", "A034"), link("A034", "refs", "T013")] }, c);
    expect(r.actions).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.dropped).toEqual(["link T012 refs A034: T012 already names A034", "link A034 refs T013: A034 already names T013"]);
  });

  test("a refs the target already names: the graph reads it from either end", () => {
    const r = checkAnswer({ actions: [link("A034", "refs", "T012"), link("T013", "refs", "A034")] }, c);
    expect(r.actions).toEqual([]);
    expect(r.dropped).toEqual(["link A034 refs T012: T012 already names A034", "link T013 refs A034: A034 already names T013"]);
  });

  test("a refs between members of a cluster in the same answer", () => {
    const cluster = { action: "cluster", label: "radiators", members: ["T012", "T013"], why: "one theme" };
    const r = checkAnswer({ actions: [cluster, link("T013", "refs", "T012")] }, c);
    expect(r.actions.map((a) => a.action)).toEqual(["cluster"]);
    expect(r.dropped).toEqual(["link T013 refs T012: T013 and T012 are in one cluster this answer proposes"]);
  });

  test("a cluster of only two entries that already name each other", () => {
    const pair = { action: "cluster", label: "radiators", members: ["A034", "T012"], why: "one theme" };
    const r = checkAnswer({ actions: [pair] }, c);
    expect(r.actions).toEqual([]);
    expect(r.dropped).toEqual(["cluster A034, T012: T012 already names A034"]);
    // Three members, or two that do not name each other, are a group the records lack.
    expect(checkAnswer({ actions: [{ ...pair, members: ["A034", "T012", "T013"] }] }, c).actions).toHaveLength(1);
    expect(checkAnswer({ actions: [{ ...pair, members: ["T012", "T013"] }] }, c).actions).toHaveLength(1);
  });

  test("a fresh refs is kept, with its hash", () => {
    const r = checkAnswer({ actions: [link("T013", "refs", "Q020")] }, c);
    expect(r.problems).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.actions).toEqual([{ ...link("T013", "refs", "Q020"), if: "h13" }]);
  });

  test("a target outside the case is judged by the source's text alone", () => {
    const r = checkAnswer({ actions: [link("T012", "refs", "A099")] }, c);
    expect(r.actions).toHaveLength(1);
    expect(r.dropped).toEqual([]);
  });
});

describe("checkAnswer names a link whose rel does not fit the kinds, so the model can answer again", () => {
  test("closes from a task, or to an answer", () => {
    expect(checkAnswer({ actions: [link("T012", "closes", "Q020")] }, c).problems).toEqual(["action 1: closes links an answer (A) to a question (Q)"]);
    expect(checkAnswer({ actions: [link("A034", "closes", "T013")] }, c).problems).toEqual(["action 1: closes links an answer (A) to a question (Q)"]);
    expect(checkAnswer({ actions: [link("A034", "closes", "Q020")] }, c).problems).toEqual([]);
  });

  test("supersedes or amends across kinds", () => {
    expect(checkAnswer({ actions: [link("T012", "supersedes", "T013")] }, c).problems).toEqual(["action 1: supersedes links an answer to an answer or a rule to a rule"]);
    expect(checkAnswer({ actions: [link("A034", "amends", "R001")] }, c).problems).toEqual(["action 1: amends links an answer to an answer or a rule to a rule"]);
    expect(checkAnswer({ actions: [link("A034", "supersedes", "A001")] }, c).problems).toEqual([]);
  });
});
