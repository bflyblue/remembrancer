"use strict";

const TOKEN = document.querySelector('meta[name="token"]').content;
const ID_RE = /\b([TQARK])(\d{3,})\b/g;
const HAS_ID = /\b[TQARK]\d{3,}\b/;
const DATE_KEY = { T: "added", Q: "asked", A: "answered", R: "reviewed", K: "added" };

const TABS = [
  { key: "todo", label: "Todo", files: ["todo.md"] },
  { key: "done", label: "Done", files: ["done.md"] },
  { key: "questions", label: "Questions", files: ["questions.md"] },
  { key: "answers", label: "Answers", files: ["answers.md"] },
  { key: "rules", label: "Rules", files: ["rules.md"] },
  { key: "resources", label: "Resources", files: ["resources.md"] },
  { key: "scratch", label: "Scratch", files: [] },
  { key: "archive", label: "Archive", files: null },
  { key: "attention", label: "Attention", files: [] },
  { key: "queue", label: "Queue", files: [] },
];

// Below this width the list and the detail are two screens rather than two panes (see style.css).
const NARROW = matchMedia("(max-width: 760px)");

const FORM_LABELS ={ invariant: "invariants", property: "properties", heuristic: "heuristics" };

// How the todo tab lays out open tasks. A task listed in another open task's
// `after:` is nested under it, as in the CLI's plan tree: a plan's children.
const TODO_MODES = { flat: "flat", top: "top level", tree: "tree" };

const FILTERS = {
  todo: { priority: ["P1", "P2", "P3"] },
  rules: {
    status: ["active", "proposed", "challenged", "retired"],
    form: ["invariant", "property", "heuristic"],
    scope: ["code", "design", "agent", "process"],
  },
};

const state = {
  projects: [],
  p: 0,
  data: null,
  tab: "todo",
  selected: null, // entry key "file#index", or null
  query: "",
  filters: {},
  editing: null, // { key, text, entryId, file } while an edit box is open; mode "answer" for closing a question
  events: null,
  hits: null, // the search endpoint's hits for state.query: [{ id, via, score }], or null while none
  queueSel: null, // the queued proposals file shown, by name
  queueShow: null, // { name, show, proposals } from /proposals?name=
  todoMode: (() => { try { return localStorage.getItem("todoMode"); } catch { return null; } })() || "flat",
  depths: new Map(), // entry key -> indent in the todo tree, set by todoTree
};

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const keyOf = (e) => `${e.file}#${e.index}`;
const today = () => new Date().toISOString().slice(0, 10);

function daysSince(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return null;
  return Math.floor((Date.now() - new Date(date + "T00:00:00Z").getTime()) / 86400000);
}

function ageOf(e) {
  const key = e.file === "done.md" || e.file.startsWith("archive/") ? "done" : DATE_KEY[e.kind];
  const d = daysSince(e.meta[key] || e.meta.added);
  return d === null ? "" : d === 0 ? "today" : `${d}d`;
}

function toast(msg, kind = "info") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), kind === "error" ? 6000 : 2500);
}

function findById(id) {
  const all = state.data.entries.filter((e) => e.id === id);
  // Prefer live files over the archive.
  return all.find((e) => !e.file.startsWith("archive/")) || all[0] || null;
}

function resolveId(id) {
  return findById(id) || (id[0] === "Q" ? findById("A" + id.slice(1)) : null);
}

function tabForEntry(e) {
  if (e.file.startsWith("archive/")) return "archive";
  return TABS.find((t) => t.files && t.files.includes(e.file))?.key || "todo";
}

// Replace ID mentions in text nodes with links (skipping existing links and code blocks).
function linkify(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest("a, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!HAS_ID.test(text)) continue; // not ID_RE: .test() on a global regex moves lastIndex, which matchAll inherits
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(ID_RE)) {
      frag.append(text.slice(last, m.index));
      frag.append(idLink(m[0]));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return root;
}

function idLink(id) {
  const a = h("a", {}, id);
  setIdLink(a, id);
  return a;
}

const fileHref = (path) => `/api/p/${state.p}/file?path=${encodeURIComponent(path)}`;
const external = { target: "_blank", rel: "noopener noreferrer" };
const ID_ONLY = /^[TQARK]\d{3,}$/;

// Where a resource's `link:` points: a web URL as is, or a file in the project
// through the server (which serves only files that entries link to).
function resourceHref(e, link) {
  if (/^https?:\/\//i.test(link || "")) return link;
  if (/^www\./i.test(link || "")) return `https://${link}`;
  const path = e.links[link];
  return path ? fileHref(path) : null;
}

// `plain`: the link text is ordinary words ([see](T012)), so it keeps the body font.
function setIdLink(a, id, plain = false) {
  const target = resolveId(id);
  a.className = `${plain ? "idref" : "idlink"} ${target ? "" : "missing"}`;
  a.href = "#";
  a.title = target ? `${target.id} · ${target.title}` : `${id} does not exist`;
  a.onclick = (ev) => {
    ev.preventDefault();
    if (target) select(target);
  };
}

// Make rendered markdown's own links behave inside the app. `links` maps each
// link as written to the project file it names (resolved by the server).
// - [x](T012), or [T012](#): opens the entry
// - [x](#heading): scrolls to that heading in this entry (the router owns the URL hash)
// - a file in the project, as a link, image or `inline/path.ts`: served by /file, new tab
// - http(s) and mailto: a new tab, so the app stays open
// - anything else (a missing file, javascript:, file:// outside the project): inert, with a tooltip
function fixLinks(root, links) {
  // Heading ids get a prefix, so a "### Detail" can't clash with the app's own #detail.
  for (const el of root.querySelectorAll("[id]")) el.id = `h-${el.id}`;
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    const text = a.textContent.trim();
    let anchor = href.slice(1);
    try { anchor = decodeURIComponent(anchor); } catch {}
    const heading = href.startsWith("#") && anchor && root.querySelector(`[id="${CSS.escape("h-" + anchor)}"]`);
    if (ID_ONLY.test(href)) setIdLink(a, href, text !== href);
    else if (href === "#" && ID_ONLY.test(text)) setIdLink(a, text);
    else if (heading) {
      a.onclick = (ev) => {
        ev.preventDefault();
        heading.scrollIntoView({ block: "start", behavior: "smooth" });
      };
    } else if (links[href]) Object.assign(a, { href: fileHref(links[href]), title: links[href], ...external });
    else if (/^(https?|mailto):/i.test(href)) Object.assign(a, external);
    else {
      a.removeAttribute("href");
      a.classList.add("broken");
      a.title = href.startsWith("#")
        ? `${href}: no such heading in this entry`
        : /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)
          ? `${href.split(":")[0]}: links are not followed`
          : `${href}: no such file in the project`;
    }
  }
  for (const img of root.querySelectorAll("img[src]")) {
    const path = links[img.getAttribute("src")];
    if (path) img.src = fileHref(path);
  }
  for (const code of root.querySelectorAll("code")) {
    const path = !code.closest("a, pre") && links[code.textContent.trim()];
    if (path) code.replaceWith(h("a", { class: "filelink", href: fileHref(path), title: path, ...external }, code.cloneNode(true)));
  }
  return linkify(root);
}

// Metadata values: web URLs and IDs become links.
function linkifyText(text) {
  const span = h("span", {});
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s,]+/g)) {
    span.append(text.slice(last, m.index), h("a", { href: m[0], ...external }, m[0]));
    last = m.index + m[0].length;
  }
  span.append(text.slice(last));
  return linkify(span);
}

// ---------- data ----------

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: "POST", headers: { "content-type": "application/json", "x-token": TOKEN }, body: JSON.stringify(body) }
    : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, conflict: data.conflict });
  return data;
}

async function load() {
  state.data = await api(`/api/p/${state.p}`);
  const cur = selectedEntry();
  if (state.selected && (!cur || (state.selectedId && cur.id !== state.selectedId))) {
    // Entries shift when files change; follow the selected ID instead.
    const again = state.selectedId && findById(state.selectedId);
    state.selected = again ? keyOf(again) : null;
  }
  render();
}

function subscribe() {
  if (state.events) state.events.close();
  state.events = new EventSource(`/api/p/${state.p}/events`);
  state.events.onmessage = () =>
    load().then(() => {
      runSearch();
      if (state.queueSel && (state.data.queue || []).some((q) => q.name === state.queueSel)) showQueued(state.queueSel);
      // Our own writes also trigger a change event; only announce outside edits.
      if (!state.editing && Date.now() - (state.lastOp || 0) > 2500) toast("Reloaded: files changed on disk");
    });
}

async function op(body, success) {
  try {
    state.lastOp = Date.now();
    const res = await api(`/api/p/${state.p}/op`, body);
    if (success) toast(typeof success === "function" ? success(res) : success, "ok");
    state.editing = null;
    await load();
    return true;
  } catch (err) {
    if (err.conflict) {
      toast("That file changed on disk since you loaded it. Reloaded; nothing was written. Check it and try again.", "error");
      await load();
    } else toast(err.message, "error");
    return false;
  }
}

// By ID and entry hash: a change elsewhere in the file doesn't make this entry's ref stale.
const refOf = (e) => ({ file: e.file, hash: e.hash, index: e.index, id: e.id, entry: e.entry });

// ---------- navigation ----------

function select(e) {
  state.tab = tabForEntry(e);
  state.selected = keyOf(e);
  state.selectedId = e.id;
  state.editing = null;
  syncHash();
  render();
  document.querySelector(".list .sel")?.scrollIntoView({ block: "nearest" });
}

function syncHash(replace = false) {
  const e = selectedEntry();
  const next = `#/${state.p}/${state.tab}${e?.id ? "/" + e.id : ""}`;
  if (location.hash === next) return;
  if (replace) history.replaceState(history.state, "", next);
  else history.pushState({ app: true }, "", next);
}

// Back from the detail screen: a real history step when we pushed one, so the phone's
// back gesture and this button agree; otherwise (opened from a link) just close it.
function closeDetail() {
  if (history.state?.app) return history.back();
  state.selected = null;
  state.editing = null;
  syncHash(true);
  render();
}

function readHash() {
  const [, p, tab, id] = location.hash.split("/");
  if (p !== undefined && state.projects[+p]) state.p = +p;
  if (tab && TABS.some((t) => t.key === tab)) state.tab = tab;
  state.pendingId = id || null;
}

function selectedEntry() {
  return state.data?.entries.find((e) => keyOf(e) === state.selected) || null;
}

// ---------- list ----------

// Ranked search through the server (FTS5, stemmed, archive included); while it
// answers, or if the query is not valid search syntax, a plain substring filter.
let searchTimer = null;
function runSearch() {
  clearTimeout(searchTimer);
  const q = state.query.trim();
  if (!q) {
    state.hits = null;
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const res = await api(`/api/p/${state.p}/search?q=${encodeURIComponent(q)}&all=1&k=40`);
      if (state.query.trim() !== q) return;
      state.hits = res.hits.map((h) => ({ id: h.id, via: h.via, score: h.score }));
    } catch {
      state.hits = null;
    }
    render();
  }, 150);
}

function entriesForTab() {
  const d = state.data;
  const q = state.query.trim().toLowerCase();
  if (q && state.hits) {
    return state.hits.map((h) => d.entries.find((e) => e.id === h.id)).filter(Boolean);
  }
  if (q) {
    const terms = q.split(/\s+/);
    return d.entries.filter((e) => {
      const hay = `${e.id} ${e.title} ${Object.entries(e.meta).map(([k, v]) => `${k}: ${v}`).join(" ")} ${e.body}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  const tab = TABS.find((t) => t.key === state.tab);
  let list = tab.files === null ? d.entries.filter((e) => e.file.startsWith("archive/")) : d.entries.filter((e) => tab.files.includes(e.file));
  if (state.tab === "todo") {
    const order = new Map(d.todoOrder.map((t, i) => [t.id, i]));
    list = [...list].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  }
  const keep = (e) => Object.entries(state.filters[state.tab] || {}).every(([key, value]) => !value || e.meta[key] === value);
  if (state.tab === "todo" && TODO_MODES[state.todoMode] && state.todoMode !== "flat") return todoTree(list, keep);
  return list.filter(keep);
}

// The open tasks under each open task: its open `after:` tasks, in `after:` order.
function subtasksById() {
  return new Map(state.data.todoOrder.map((t) => [t.id, t.blockedBy]));
}

// The open tasks in todo order: the top-level ones (nested under no open
// task), each followed in tree mode by its subtasks, indented. A task under
// several parents shows under the first one reached; a cycle with nothing
// above it starts at its first task. Filters pick the top-level tasks and
// their subtasks come along.
function todoTree(list, keep) {
  const byId = new Map(list.map((e) => [e.id, e]));
  const kids = subtasksById();
  const nested = new Set([...kids.values()].flat());
  const out = [];
  const seen = new Set();
  state.depths = new Map();
  // Top-level mode still walks the subtasks, unlisted, so a cycle surfaces once.
  const walk = (e, depth) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    if (depth === 0 || state.todoMode === "tree") {
      out.push(e);
      state.depths.set(keyOf(e), depth);
    }
    for (const id of kids.get(e.id) || []) if (byId.has(id)) walk(byId.get(id), depth + 1);
  };
  for (const e of list) if (!nested.has(e.id) && keep(e)) walk(e, 0);
  // Tasks not reached yet: in a cycle (it starts at its first task in todo
  // order), or under a parent the filters hid.
  for (const e of list) if (!seen.has(e.id) && keep(e)) walk(e, 0);
  return out;
}

// How many open tasks sit under a task, at any depth.
function subtaskCount(e) {
  const kids = subtasksById();
  const seen = new Set([e.id]);
  const stack = [...(kids.get(e.id) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(kids.get(id) || []));
  }
  return seen.size - 1;
}

function renderFilters() {
  const box = document.getElementById("filters");
  box.replaceChildren();
  if (state.query) {
    box.append(h("span", { class: "muted" }, state.hits ? `Ranked results for “${state.query}”, archive included` : `Searching all files for “${state.query}”`));
    return;
  }
  if (state.tab === "rules") box.append(checksSummary());
  if (state.tab === "todo") {
    const group = h("span", { class: "chipgroup", role: "group", "aria-label": "Layout" });
    for (const [mode, label] of Object.entries(TODO_MODES)) {
      group.append(
        h("button", {
          class: `chip ${state.todoMode === mode ? "on" : ""}`,
          "aria-pressed": String(state.todoMode === mode),
          onclick: () => {
            state.todoMode = mode;
            try { localStorage.setItem("todoMode", mode); } catch {}
            render();
          },
        }, label),
      );
    }
    box.append(group);
  }
  const groups = FILTERS[state.tab];
  if (!groups) return;
  const current = (state.filters[state.tab] ||= {});
  for (const [key, values] of Object.entries(groups)) {
    const group = h("span", { class: "chipgroup" });
    for (const v of values) {
      group.append(
        h("button", {
          class: `chip ${current[key] === v ? "on" : ""}`,
          onclick: () => {
            current[key] = current[key] === v ? null : v;
            render();
          },
        }, v),
      );
    }
    box.append(group);
  }
}

function badges(e) {
  const out = [];
  const m = e.meta;
  if (m.priority) out.push(h("span", { class: `badge ${m.priority}` }, m.priority));
  if (m.status) out.push(h("span", { class: `badge st-${m.status}` }, m.status));
  if (m.form) out.push(h("span", { class: `badge form` }, m.form));
  if (e.kind === "K" && m.link) {
    const web = /^https?:\/\/([^/]+)/i.exec(m.link);
    out.push(h("span", { class: "badge file", title: m.link }, web ? web[1].replace(/^www\./, "") : "file"));
  }
  if (m["waiting-on"]) out.push(h("span", { class: "badge waiting", title: "waiting on " + m["waiting-on"] }, `waits on ${m["waiting-on"]}`));
  if (e.kind === "R" && m["enforced-by"]) out.push(checkBadge(e));
  if (m.kind === "theme") out.push(h("span", { class: "badge theme", title: "condensed from " + (m["condensed-from"] || "?") }, "theme"));
  if (m["condensed-into"]) out.push(h("span", { class: "badge into", title: "condensed into " + m["condensed-into"] }, `→ ${m["condensed-into"]}`));
  if (m.suggest) out.push(h("span", { class: "badge suggest" }, `suggest ${m.suggest}`));
  for (const tag of (m.tags || "").split(/[,\s]+/).filter(Boolean).slice(0, 3)) out.push(h("span", { class: `badge tag ${tag.startsWith("c-") ? "cluster" : ""}` }, tag));
  const via = state.query && state.hits?.find((x) => x.id === e.id)?.via;
  if (via) out.push(h("span", { class: "badge into", title: "the current entry for a hit" }, `via ${via}`));
  const blocked = state.data.todoOrder.find((t) => t.id === e.id)?.blockedBy || [];
  // In tree mode the subtasks show beneath; in top-level mode, how many are hidden.
  const mode = state.tab === "todo" && !state.query ? state.todoMode : "flat";
  if (e.file === "todo.md" && blocked.length && mode === "flat") out.push(h("span", { class: "badge blocked" }, `after ${blocked.join(", ")}`));
  if (e.file === "todo.md" && mode === "top" && subtaskCount(e)) out.push(h("span", { class: "badge", title: "open tasks under it (tree shows them)" }, `+${plural(subtaskCount(e), "subtask")}`));
  if (state.query) out.push(h("span", { class: "badge file" }, e.file.replace(/\.md$/, "")));
  return out;
}

// A rule's last machine check (remembrancer check), from .remembrancer/log/checks.json.
function checkOf(e) {
  return state.data.checks?.[e.id] || null;
}

function checkBadge(e) {
  const c = checkOf(e);
  if (!c) return h("span", { class: "badge tested", title: e.meta["enforced-by"] }, "check not run");
  const label = c.status === "pass" ? "check pass" : c.status === "fail" ? "check FAIL" : "no runner";
  return h("span", { class: `badge chk-${c.status}`, title: `${c.message} (${c.at})` }, label);
}

function checksSummary() {
  const c = state.data.brief?.checks;
  if (!c || !(c.pass + c.fail + c.unrunnable + c.notRun)) return h("span", { class: "muted" }, "No rule has a machine check (enforced-by).");
  const last = Object.values(state.data.checks || {}).map((x) => x.at).sort().pop();
  return h("div", { class: `checks ${c.fail ? "failing" : ""}` },
    h("strong", {}, "Checks: "),
    c.fail ? h("span", { class: "badge chk-fail" }, `${c.fail} FAIL`) : null,
    h("span", { class: "badge chk-pass" }, `${c.pass} pass`),
    c.notRun ? h("span", { class: "badge" }, `${c.notRun} not run`) : null,
    c.unrunnable ? h("span", { class: "badge" }, `${c.unrunnable} no runner`) : null,
    h("span", { class: "muted" }, last ? `  last run ${last.replace("T", " ")} · remembrancer check` : "  run: remembrancer check"));
}

function listItem(e) {
  const depth = state.tab === "todo" && !state.query && state.todoMode === "tree" ? state.depths.get(keyOf(e)) || 0 : 0;
  const li = h(
    "li",
    {
      class: `${keyOf(e) === state.selected ? "sel" : ""} ${depth ? "sub" : ""}`,
      onclick: () => select(e),
    },
    h("div", { class: "row1" }, h("span", { class: "id" }, e.id || "?"), h("span", { class: "title" }, e.title)),
    h("div", { class: "row2" }, ...badges(e), h("span", { class: "age" }, ageOf(e))),
  );
  // Through the CSSOM: the page's CSP refuses style attributes.
  if (depth) li.style.setProperty("--depth", depth);
  return li;
}

function renderList() {
  const ul = document.getElementById("list");
  ul.replaceChildren();
  if (state.tab === "attention" && !state.query) return renderAttentionList(ul);
  if (state.tab === "queue" && !state.query) return renderQueueList(ul);
  if (state.tab === "scratch" && !state.query) {
    ul.append(h("li", { class: "sel" }, h("div", { class: "row1" }, h("span", { class: "title" }, "scratch.md"))));
    return;
  }
  const list = entriesForTab();
  if (!list.length) ul.append(h("li", { class: "empty" }, state.query ? "No matches." : "Nothing here yet."));
  if (state.tab === "rules" && !state.query) {
    for (const form of ["invariant", "property", "heuristic", undefined]) {
      const group = list.filter((e) => (form ? e.meta.form === form : !["invariant", "property", "heuristic"].includes(e.meta.form)));
      if (!group.length) continue;
      ul.append(h("li", { class: "group" }, FORM_LABELS[form] || "no form"));
      group.forEach((e) => ul.append(listItem(e)));
    }
  } else list.forEach((e) => ul.append(listItem(e)));
}

// Entries that wait on someone, rules whose check fails, the inbox, stale and suggested entries: the signals, first.
function signals() {
  const d = state.data;
  const live = (e) => !/^(archive|kb)\//.test(e.file);
  return [
    ["waiting on you" + (d.brief?.owner ? ` (${d.brief.owner})` : ""), (d.brief?.waiting || []).map((w) => findById(w.id)).filter(Boolean)],
    ["failing checks", d.entries.filter((e) => e.kind === "R" && checkOf(e)?.status === "fail")],
    ["inbox", d.entries.filter((e) => e.file === "todo.md" && e.meta.status === "inbox")],
    ["suggested for archive", d.entries.filter((e) => live(e) && e.meta.suggest === "archive")],
    ["stale", (d.stale || []).map((s) => findById(s.id)).filter(Boolean)],
  ].filter(([, list]) => list.length);
}

// What the Attention tab lists: one count for its badge and the overview.
function attentionCount() {
  const d = state.data;
  return d.attention.length + d.problems.length + signals().reduce((s, [, l]) => s + l.length, 0);
}

function renderAttentionList(ul) {
  const { attention, problems } = state.data;
  const sig = signals();
  if (!attention.length && !problems.length && !sig.length) ul.append(h("li", { class: "empty" }, "Nothing needs attention."));
  for (const [label, list] of sig) {
    ul.append(h("li", { class: "group" }, `${label} (${list.length})`));
    list.forEach((e) => ul.append(listItem(e)));
  }
  const item = (id, file, index, label, message, cls) =>
    h("li", {
      class: cls,
      onclick: () => {
        const e = state.data.entries.find((x) => x.file === file && (index < 0 || x.index === index)) || (id && findById(id));
        if (e) select(e);
        else if (file === "scratch.md") setTab("scratch");
      },
    },
    h("div", { class: "row1" }, h("span", { class: "id" }, id || ""), h("span", { class: "title" }, message)),
    h("div", { class: "row2" }, h("span", { class: "badge" }, label)));
  if (problems.length) ul.append(h("li", { class: "group" }, `lint problems (${problems.length})`));
  for (const p of problems) {
    const e = p.id && state.data.entries.find((x) => x.id === p.id && x.file === p.file);
    ul.append(item(p.id, p.file, e ? e.index : -1, p.file, p.message, "problem"));
  }
  const order = ["challenged-rule", "proposed-rule", "curate", "stale-question", "stale-todo", "unreviewed-rule", "sharpen-rule", "scratch"];
  for (const kind of order) {
    const group = attention.filter((a) => a.kind === kind);
    if (!group.length) continue;
    ul.append(h("li", { class: "group" }, `${kind.replace("-", " ")} (${group.length})`));
    for (const a of group) {
      const e = state.data.entries.find((x) => x.file === a.file && x.index === a.index);
      ul.append(item(a.id, a.file, a.index, a.message, e ? e.title : a.file));
    }
  }
}

function renderQueueList(ul) {
  const q = state.data.queue || [];
  if (!q.length) ul.append(h("li", { class: "empty" }, "The queue is empty. Curator runs queued with --queue wait here."));
  for (const item of q) {
    ul.append(h("li", { class: item.name === state.queueSel ? "sel" : "", onclick: () => showQueued(item.name) },
      h("div", { class: "row1" }, h("span", { class: "title" }, item.name)),
      h("div", { class: "row2" }, h("span", { class: "badge" }, item.mode), h("span", { class: "badge" }, plural(item.actions, "action")), h("span", { class: "age" }, `by ${item.by}, ${item.made}`))));
  }
}

async function showQueued(name) {
  state.queueSel = name;
  try {
    state.queueShow = await api(`/api/p/${state.p}/proposals?name=${encodeURIComponent(name)}`);
  } catch (err) {
    state.queueShow = null;
    toast(err.message, "error");
  }
  render();
}

// After an apply or a reject, the file has left the queue.
function leaveQueued(ok) {
  if (!ok) return;
  state.queueSel = null;
  state.queueShow = null;
  render();
}

function renderQueue(pane) {
  const s = state.queueShow;
  if (!s || s.name !== state.queueSel) {
    pane.append(h("div", { class: "placeholder" }, h("p", {}, "A curator run, queued for review. Pick one to read it, then apply or reject it.")));
    return;
  }
  pane.append(h("div", { class: "dhead" }, h("h2", {}, s.name), h("span", { class: "muted" }, `.remembrancer/proposals/${s.name}`)));
  pane.append(h("div", { class: "actions" },
    h("button", { class: "primary", onclick: () => confirm(`Apply all ${s.proposals.actions.length} actions in ${s.name}?`) && op({ op: "proposals-apply", name: s.name }, (r) => `applied ${r.applied.length}`).then(leaveQueued) }, "Apply"),
    h("button", { class: "danger", onclick: () => { const why = prompt("Why reject it? (one line, logged)"); if (why) op({ op: "proposals-reject", name: s.name, why }, `${s.name} rejected`).then(leaveQueued); } }, "Reject"),
    h("span", { class: "muted" }, "Applied in one locked step, or refused whole; logged in .remembrancer/log/curation.md.")));
  pane.append(h("pre", { class: "show" }, s.show));
}

// ---------- detail ----------

function metaTable(e) {
  const dl = h("dl", { class: "meta" });
  for (const [k, v] of Object.entries(e.meta)) {
    const href = k === "link" && e.kind === "K" ? resourceHref(e, v) : null;
    dl.append(h("dt", {}, k), h("dd", {}, href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, v) : linkifyText(v)));
  }
  return dl;
}

function backlinks(e) {
  if (!e.id) return null;
  const re = new RegExp(`\\b${e.id}\\b`);
  const refs = state.data.entries.filter((x) => x !== e && re.test(x.raw));
  const pair = e.kind === "Q" ? findById("A" + e.id.slice(1)) : e.kind === "A" ? findById("Q" + e.id.slice(1)) : null;
  if (!refs.length && !pair) return null;
  const list = h("ul", { class: "backlinks" });
  if (pair && !refs.includes(pair)) list.append(h("li", {}, idLink(pair.id), ` ${pair.title}`, h("span", { class: "muted" }, e.kind === "Q" ? "  answer" : "  question")));
  for (const r of refs) list.append(h("li", {}, idLink(r.id || "?"), ` ${r.title}`, h("span", { class: "muted" }, `  ${r.file}`)));
  return h("section", { class: "related" }, h("h3", {}, "Referenced by"), list);
}

// A task's place in the plan tree: the open tasks whose `after:` lists it,
// and the tasks its own `after:` lists, open, done or dropped.
function planLinks(e) {
  if (e.kind !== "T") return null;
  const mentions = (text) => (text || "").match(ID_RE) || [];
  const parents = state.data.entries.filter((x) => x.file === "todo.md" && mentions(x.meta.after).includes(e.id));
  const children = mentions(e.meta.after).filter((id) => id[0] === "T");
  if (!parents.length && !children.length) return null;
  const stateOf = (x) => !x ? "missing" : x.file === "todo.md" ? "open" : x.meta.dropped === "yes" ? "dropped" : "done";
  const row = (id, note) => {
    const x = findById(id);
    return h("li", { class: `st-${stateOf(x)}` }, idLink(id), ` ${x?.title || ""}`, h("span", { class: "muted" }, `  ${note || stateOf(x)}`));
  };
  const box = h("section", { class: "related plan" }, h("h3", {}, "Plan"));
  if (parents.length) box.append(h("p", { class: "muted" }, "Part of"), h("ul", { class: "backlinks" }, parents.map((p) => row(p.id, p.meta.priority))));
  if (children.length) {
    const finished = children.filter((id) => ["done", "dropped"].includes(stateOf(findById(id)))).length;
    box.append(h("p", { class: "muted" }, `Subtasks · ${finished} of ${children.length} finished`), h("ul", { class: "backlinks" }, children.map((id) => row(id))));
  }
  return box;
}

function supersedesChain(e) {
  if (e.kind !== "R") return null;
  const chain = [];
  const seen = new Set([e.id]);
  let cur = e;
  while (cur && cur.meta.supersedes) {
    const prevId = (cur.meta.supersedes.match(ID_RE) || [])[0];
    if (!prevId || seen.has(prevId)) break;
    seen.add(prevId);
    cur = findById(prevId);
    if (cur) chain.push(cur);
  }
  const later = (e.meta["superseded-by"] || "").match(ID_RE) || [];
  if (!chain.length && !later.length) return null;
  const box = h("section", { class: "related" }, h("h3", {}, "Lineage"));
  if (later.length) box.append(h("p", {}, "Superseded by ", ...later.map(idLink)));
  for (const r of chain) box.append(h("p", {}, "Supersedes ", idLink(r.id), ` ${r.title}`, h("span", { class: "muted" }, `  (${r.meta.status || "?"})`)));
  return box;
}

function actions(e) {
  const bar = h("div", { class: "actions" });
  const ref = refOf(e);
  const href = e.kind === "K" ? resourceHref(e, e.meta.link) : null;
  if (href) bar.append(h("a", { class: "button primary", href, target: "_blank", rel: "noopener noreferrer" }, "Open resource ↗"));
  bar.append(h("button", { onclick: () => startEdit(e) }, "Edit"));
  if (e.file === "todo.md") bar.append(h("button", { onclick: () => op({ op: "complete", ref }, `${e.id} moved to done`) }, "Mark done"));
  if (e.file === "done.md") bar.append(h("button", { onclick: () => op({ op: "archive", ref }, (r) => `${e.id} archived to ${r.moved}`) }, "Archive"));
  if (e.file === "questions.md") bar.append(h("button", { onclick: () => startAnswer(e) }, "Answer…"));
  if (e.id && !/^(archive|kb)\//.test(e.file)) {
    bar.append(e.meta.suggest === "archive"
      ? h("button", { onclick: () => op({ op: "meta", ref, updates: { suggest: "" } }, `${e.id}: no longer suggested`) }, "Unmark stale")
      : h("button", { title: "Suggest archiving it (suggest: archive); a person or the weekly run decides", onclick: () => op({ op: "meta", ref, updates: { suggest: "archive" } }, `${e.id} marked stale`) }, "Mark stale"));
  }
  if (e.meta["waiting-on"]) bar.append(h("button", { onclick: () => op({ op: "meta", ref, updates: { "waiting-on": "" } }, `${e.id} waits on no one`) }, "Done waiting"));
  if (e.kind === "R" && !e.file.startsWith("archive/")) {
    bar.append(h("button", { onclick: () => op({ op: "meta", ref, updates: { reviewed: today() } }, `${e.id} marked reviewed`) }, "Mark reviewed"));
    const sel = h("select", {
      "aria-label": "Rule status",
      onchange: (ev) => op({ op: "meta", ref, updates: { status: ev.target.value } }, `${e.id} is now ${ev.target.value}`),
    });
    for (const s of FILTERS.rules.status) sel.append(h("option", { value: s, selected: e.meta.status === s }, s));
    bar.append(h("label", { class: "inline" }, "status ", sel));
  }
  bar.append(h("span", { class: "spacer" }));
  // An entry with an ID is never deleted, so its number is never reused: a todo is dropped instead.
  if (e.file === "todo.md") {
    bar.append(
      h("button", {
        class: "danger",
        onclick: () => confirm(`Drop ${e.id}? It moves to done, marked dropped.`) && op({ op: "drop", ref }, `${e.id} dropped`),
      }, "Drop"),
    );
  }
  if (!e.id) {
    bar.append(
      h("button", {
        class: "danger",
        onclick: () => confirm(`Delete this entry from ${e.file}? This cannot be undone.`) && op({ op: "delete", ref }, "entry deleted"),
      }, "Delete"),
    );
  }
  return bar;
}

// Close a question: its answer's sections, saved through `remembrancer answer` (the answer takes its number).
function startAnswer(e) {
  state.editing = { key: keyOf(e), mode: "answer", title: "", text: "**Answer:** \n\n**Why:** \n\n**Alternatives considered:** \n", entryId: e.id, file: e.file, entry: e.entry };
  render();
}

function answerEditor(e) {
  const title = h("input", { type: "text", placeholder: "The answer in one line", oninput: (ev) => (state.editing.title = ev.target.value) });
  title.value = state.editing.title;
  const ta = h("textarea", { spellcheck: "false", rows: 14, oninput: (ev) => (state.editing.text = ev.target.value) });
  ta.value = state.editing.text;
  const save = () => op({ op: "answer", ref: { ...refOf(e), entry: state.editing.entry }, title: state.editing.title, text: state.editing.text }, (r) => `${e.id} answered as ${r.id}`);
  return h("div", { class: "editor" }, title, ta, h("div", { class: "actions" },
    h("button", { class: "primary", onclick: save }, "Save the answer"),
    h("button", { onclick: () => { state.editing = null; render(); } }, "Cancel"),
    h("span", { class: "muted" }, "The question is copied in as **Question**, and the question leaves questions.md.")));
}

function startEdit(e) {
  state.editing = { key: keyOf(e), text: e.raw, entryId: e.id, file: e.file, entry: e.entry };
  render();
  // On a phone, focusing would raise the keyboard over the text before it has been read.
  if (!NARROW.matches) document.querySelector(".editor textarea")?.focus();
}

// Grow the edit box to its text, so wrapped lines on a narrow screen do not scroll inside it.
function fitEditor() {
  const ta = document.querySelector(".editor textarea");
  if (ta && ta.scrollHeight > ta.clientHeight) ta.style.height = `${ta.scrollHeight + 2}px`;
}

function editor(e) {
  const ta = h("textarea", { spellcheck: "false", oninput: (ev) => (state.editing.text = ev.target.value) });
  ta.value = state.editing.text;
  ta.rows = Math.min(40, Math.max(8, state.editing.text.split("\n").length + 2));
  const save = () => {
    const current = state.data.entries.find((x) => x.file === state.editing.file && x.id === state.editing.entryId) || e;
    // Checked against the entry as it was when editing began, so a change made meanwhile is a conflict.
    op({ op: "replace", ref: { ...refOf(current), entry: state.editing.entry }, raw: state.editing.text }, `${e.id} saved`);
  };
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "s" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      save();
    }
    if (ev.key === "Escape") {
      state.editing = null;
      render();
    }
  });
  return h("div", { class: "editor" }, ta, h("div", { class: "actions" },
    h("button", { class: "primary", onclick: save }, "Save", h("span", { class: "keys" }, "  (Ctrl-S)")),
    h("button", { onclick: () => { state.editing = null; render(); } }, "Cancel"),
    h("span", { class: "muted" }, "Raw markdown for this entry only. The rest of the file is untouched.")));
}

function renderScratch(pane) {
  const file = state.data.files.find((f) => f.path === "scratch.md");
  pane.append(h("div", { class: "dhead" }, h("h2", {}, "Scratch"), h("span", { class: "muted" }, ".remembrancer/scratch.md")));
  if (state.editing?.key === "scratch") {
    const ta = h("textarea", { spellcheck: "false", oninput: (ev) => (state.editing.text = ev.target.value) });
    ta.value = state.editing.text;
    ta.rows = 30;
    pane.append(h("div", { class: "editor" }, ta, h("div", { class: "actions" },
      h("button", { class: "primary", onclick: () => op({ op: "file", file: "scratch.md", hash: file.hash, text: state.editing.text }, "Scratch saved") }, "Save"),
      h("button", { onclick: () => { state.editing = null; render(); } }, "Cancel"))));
    return;
  }
  const body = h("article", { class: "md" });
  body.innerHTML = state.data.scratchHtml;
  pane.append(h("div", { class: "actions" }, h("button", {
    disabled: !file,
    onclick: () => { state.editing = { key: "scratch", text: state.data.scratch }; render(); },
  }, "Edit")), fixLinks(body, state.data.scratchLinks));
}

function renderDetail() {
  const pane = document.getElementById("detail");
  pane.replaceChildren();
  if (state.tab === "scratch" && !state.query) return renderScratch(pane);
  if (state.tab === "queue" && !state.query) return renderQueue(pane);
  const e = selectedEntry();
  if (!e) {
    pane.append(h("div", { class: "placeholder" }, overview()));
    return;
  }
  const from = state.query ? "Results" : TABS.find((t) => t.key === state.tab).label;
  pane.append(
    h("div", { class: "dnav" }, h("button", { class: "ghost back", onclick: closeDetail }, `‹ ${from}`)),
  );
  pane.append(
    h("div", { class: "dhead" },
      h("h2", {}, h("span", { class: "id" }, e.id || "?"), " ", e.title),
      h("span", { class: "muted" }, `.remembrancer/${e.file}`)),
  );
  if (state.editing?.key === keyOf(e)) {
    pane.append(state.editing.mode === "answer" ? answerEditor(e) : editor(e));
    return;
  }
  const into = (e.meta["condensed-into"] || "").match(ID_RE)?.[0];
  const by = (e.meta["superseded-by"] || "").match(ID_RE)?.[0];
  if (into) pane.append(h("p", { class: "banner" }, "Condensed into ", idLink(into), ` ${findById(into)?.title || ""}: read that instead.`));
  else if (by) pane.append(h("p", { class: "banner" }, "Superseded by ", idLink(by), ` ${findById(by)?.title || ""}.`));
  if (e.meta["waiting-on"]) pane.append(h("p", { class: "banner waiting" }, `Waiting on ${e.meta["waiting-on"]}.`));
  const chk = e.kind === "R" && checkOf(e);
  if (chk) pane.append(h("p", { class: `banner chk-${chk.status}` }, `Machine check: ${chk.status === "pass" ? "passed" : chk.status === "fail" ? "FAILED" : "not run"}, ${chk.at.replace("T", " ")}: ${chk.message}`));
  pane.append(actions(e), metaTable(e));
  // Above the body, so a long plan does not push its tasks out of sight.
  const plan = planLinks(e);
  if (plan) pane.append(plan);
  const body = h("article", { class: "md" });
  body.innerHTML = e.html;
  pane.append(fixLinks(body, e.links));
  const related = [supersedesChain(e), backlinks(e)].filter(Boolean);
  pane.append(...related);
}

function overview() {
  const d = state.data;
  const count = (f) => d.entries.filter((e) => e.file === f).length;
  return h("div", {},
    h("h2", {}, d.name),
    h("p", { class: "muted" }, d.root),
    h("p", {}, `${count("todo.md")} todo · ${plural(count("questions.md"), "open question")} · ${plural(count("rules.md"), "rule")} · ${count("done.md")} done · ${plural(count("answers.md"), "answer")} · ${plural(count("resources.md"), "resource")}`),
    d.brief?.waiting?.length ? h("p", { class: "banner waiting" }, `Waiting on ${d.brief.owner || "someone"}: `, ...d.brief.waiting.flatMap((w, i) => [i ? ", " : "", idLink(w.id)])) : null,
    checksSummary(),
    h("p", {}, attentionCount() ? `${plural(attentionCount(), "item")} need${attentionCount() === 1 ? "s" : ""} attention.` : "Nothing needs attention."),
    h("p", { class: "muted keys" }, "Keys: / search · j/k move · Enter open · e edit · Esc back"));
}

// ---------- chrome ----------

function renderTabs() {
  const nav = document.getElementById("tabs");
  nav.replaceChildren();
  const d = state.data;
  for (const t of TABS) {
    let n;
    if (t.key === "attention") n = attentionCount();
    else if (t.key === "queue") n = (d.queue || []).length;
    else if (t.key === "archive") n = d.entries.filter((e) => e.file.startsWith("archive/")).length;
    else if (t.key !== "scratch") n = d.entries.filter((e) => t.files.includes(e.file)).length;
    nav.append(h("button", {
      class: `tab ${state.tab === t.key && !state.query ? "on" : ""} ${t.key === "attention" && n ? "warn" : ""}`,
      onclick: () => setTab(t.key),
    }, t.label, n !== undefined ? h("span", { class: "count" }, n) : null));
  }
  // The tab strip scrolls sideways on phones; keep the current tab in view.
  const on = nav.querySelector(".tab.on");
  if (on) nav.scrollLeft = Math.max(0, Math.min(nav.scrollLeft, on.offsetLeft - 16), on.offsetLeft + on.offsetWidth + 16 - nav.clientWidth);
}

function setTab(key) {
  state.tab = key;
  state.query = "";
  document.getElementById("search").value = "";
  state.selected = null;
  state.editing = null;
  syncHash();
  render();
}

function render() {
  if (!state.data) return;
  if (state.pendingId) {
    const e = findById(state.pendingId);
    state.pendingId = null;
    if (e) {
      state.selected = keyOf(e);
      state.selectedId = e.id;
    }
  }
  document.title = `${state.data.name} · Remembrancer`;
  const shown = state.tab === "scratch" && !state.query ? "scratch" : state.selected;
  const ul = document.getElementById("list");
  const listWasShown = ul.offsetParent !== null;
  if (listWasShown) state.listScroll = ul.scrollTop;
  document.body.classList.toggle("detail-open", !!(shown && (shown === "scratch" || selectedEntry())));
  renderTabs();
  renderFilters();
  renderList();
  renderDetail();
  if (state.editing) fitEditor();
  // Hiding the list (the detail screen on phones) drops its scroll position; put it back.
  if (!listWasShown && ul.offsetParent !== null) ul.scrollTop = state.listScroll || 0;
  // A different entry starts at its top, not wherever the last one was scrolled to.
  if (shown !== state.shown) {
    state.shown = shown;
    document.getElementById("detail").scrollTop = 0;
  }
}

function moveSelection(delta) {
  const list = state.tab === "attention" && !state.query ? [] : entriesForTab();
  if (!list.length) return;
  const i = list.findIndex((e) => keyOf(e) === state.selected);
  const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + delta))];
  select(next);
}

function setupTheme() {
  const saved = (() => { try { return localStorage.getItem("theme"); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  document.getElementById("theme").onclick = () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const cur = document.documentElement.dataset.theme || (dark ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
  };
}

async function main() {
  setupTheme();
  state.projects = await api("/api/projects");
  readHash();
  const sel = document.getElementById("project");
  for (const p of state.projects) sel.append(h("option", { value: p.i, title: p.root }, p.name));
  sel.value = state.p;
  sel.hidden = state.projects.length < 2;
  sel.onchange = async () => {
    state.p = +sel.value;
    state.selected = null;
    syncHash();
    await load();
    subscribe();
  };

  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    state.query = search.value;
    runSearch();
    // On a phone an open entry covers the results; searching means going back to the list.
    if (NARROW.matches && state.selected && !state.editing) {
      state.selected = null;
      syncHash(true);
    }
    render();
  });

  document.addEventListener("keydown", (ev) => {
    const typing = ev.target.matches("input, textarea, select");
    if (ev.key === "/" && !typing) {
      ev.preventDefault();
      search.focus();
      search.select();
    } else if (ev.key === "Escape") {
      if (typing) ev.target.blur();
      if (state.query) {
        state.query = "";
        search.value = "";
        render();
      }
    } else if (!typing && (ev.key === "j" || ev.key === "ArrowDown")) {
      ev.preventDefault();
      moveSelection(1);
    } else if (!typing && (ev.key === "k" || ev.key === "ArrowUp")) {
      ev.preventDefault();
      moveSelection(-1);
    } else if (!typing && ev.key === "e") {
      const e = selectedEntry();
      if (e) {
        ev.preventDefault();
        startEdit(e);
      }
    } else if (ev.target === search && ev.key === "Enter") {
      const first = entriesForTab()[0];
      if (first) {
        search.blur();
        select(first);
      }
    }
  });

  window.addEventListener("popstate", () => {
    readHash();
    sel.value = state.p;
    state.query = "";
    search.value = "";
    // Back to a hash without an ID closes the entry; one with an ID reselects it via pendingId.
    state.selected = null;
    state.editing = null;
    load();
  });

  await load();
  subscribe();
}

main().catch((err) => toast(err.message, "error"));
