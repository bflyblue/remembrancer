import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { appendEntry, formatEntry, mentions, parseFile, prependEntry, removeEntry, spliceEntry, withMeta } from "../src/model";

const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();
const templatesDir = join(import.meta.dir, "..", "skill", "templates");

function reassemble(text: string) {
  const f = parseFile("x.md", text);
  return f.preamble + f.entries.map((e) => e.raw).join("");
}

describe("parseFile", () => {
  test("round-trips every template byte for byte", async () => {
    for (const name of readdirSync(templatesDir)) {
      const text = await Bun.file(join(templatesDir, name)).text();
      expect(reassemble(text)).toBe(text);
    }
  });

  test("round-trips a messy file byte for byte", async () => {
    const text = await fixture("messy.md");
    expect(reassemble(text)).toBe(text);
  });

  test("reads ids, titles, metadata and bodies", async () => {
    const f = parseFile("todo.md", await fixture("messy.md"));
    expect(f.entries.map((e) => e.id)).toEqual(["T001", "T002", "T003", null]);
    const [t1, t2, t3, bad] = f.entries;
    expect(t1.title).toBe("First task");
    expect(t1.meta).toEqual({ priority: "P1", added: "2026-09-01", refs: "Q002" });
    expect(t1.body).toContain("## T999 · not a heading, inside a fence");
    expect(t2.title).toBe("Dash separator, no metadata");
    expect(t2.meta).toEqual({});
    expect(t2.body).toBe("Just a body.");
    expect(t3.meta.priority).toBe("P3");
    expect(bad.title).toBe("Not an ID heading");
    expect(f.preamble).toBe("# Todo\n\nSome preamble text.\n\n");
  });

  test("a body line that looks like key: value is not metadata unless it comes first", () => {
    const f = parseFile("x.md", "## T001 · a\n\nNote: this is prose\n");
    expect(f.entries[0].meta).toEqual({});
    expect(f.entries[0].body).toBe("Note: this is prose");
    const g = parseFile("x.md", "## T001 · a\n\nSee T002 for context, it matters.\n");
    expect(g.entries[0].meta).toEqual({});
    expect(g.entries[0].body).toBe("See T002 for context, it matters.");
  });
});

describe("editing", () => {
  test("splicing an entry changes only its span", async () => {
    const text = await fixture("messy.md");
    const f = parseFile("todo.md", text);
    const e = f.entries[1];
    const out = spliceEntry(f, 1, "## T002 · Renamed\npriority: P2 · added: 2026-09-03\n\nNew body.");
    expect(out.slice(0, e.start)).toBe(text.slice(0, e.start));
    expect(out.endsWith(text.slice(e.end))).toBe(true);
    expect(parseFile("todo.md", out).entries[1].title).toBe("Renamed");
  });

  test("removing entries keeps the rest intact", () => {
    const text = "# H\n\n## T001 · a\nx\n\n## T002 · b\ny\n\n## T003 · c\nz\n";
    const f = parseFile("t.md", text);
    expect(removeEntry(f, 1)).toBe("# H\n\n## T001 · a\nx\n\n## T003 · c\nz\n");
    expect(removeEntry(f, 2)).toBe("# H\n\n## T001 · a\nx\n\n## T002 · b\ny\n");
    const only = parseFile("t.md", "# H\n\n## T001 · a\nx\n");
    expect(removeEntry(only, 0)).toBe("# H\n");
  });

  test("withMeta updates the metadata line, or adds one", () => {
    const f = parseFile("r.md", "## R001 · rule\nstatus: proposed · added: 2026-09-01\n\nBody.\n\n## R002 · bare\n\nBody two.\n");
    expect(withMeta(f.entries[0], { status: "active" })).toBe("## R001 · rule\nstatus: active · added: 2026-09-01\n\nBody.\n");
    expect(withMeta(f.entries[1], { reviewed: "2026-09-29" })).toBe("## R002 · bare\nreviewed: 2026-09-29\n\nBody two.\n");
  });

  test("prepend puts an entry after the preamble; append at the end", () => {
    const text = "# Done\n\nIntro.\n\n## T001 · old\ndone: 2026-09-01\n";
    const pre = prependEntry(text, "## T002 · new\ndone: 2026-09-29\n");
    expect(parseFile("d.md", pre).entries.map((e) => e.id)).toEqual(["T002", "T001"]);
    expect(pre.startsWith("# Done\n\nIntro.\n\n## T002")).toBe(true);
    expect(prependEntry("# Done\n", "## T001 · x\n")).toBe("# Done\n\n## T001 · x\n");
    expect(appendEntry("# Todo\n", "## T001 · x")).toBe("# Todo\n\n## T001 · x\n");
  });

  test("formatEntry produces parseable text", () => {
    const raw = formatEntry({ id: "Q004", title: "Why?", meta: { asked: "2026-09-29", context: "T001" }, body: "Details." });
    const e = parseFile("q.md", raw).entries[0];
    expect(e.id).toBe("Q004");
    expect(e.meta).toEqual({ asked: "2026-09-29", context: "T001" });
    expect(e.body).toBe("Details.");
  });

  test("mentions finds ids but not longer words", () => {
    expect(mentions("see T001, Q12, A0042 and R100ms and XT003")).toEqual(["T001", "A0042"]);
  });
});
