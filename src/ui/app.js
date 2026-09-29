"use strict";

const TOKEN = document.querySelector('meta[name="token"]').content;
const ID_RE = /\b([TQAR])(\d{3,})\b/g;
const HAS_ID = /\b[TQAR]\d{3,}\b/;
const DATE_KEY = { T: "added", Q: "asked", A: "answered", R: "reviewed" };

const TABS = [
  { key: "todo", label: "Todo", files: ["todo.md"] },
  { key: "done", label: "Done", files: ["done.md"] },
  { key: "questions", label: "Questions", files: ["questions.md"] },
  { key: "answers", label: "Answers", files: ["answers.md"] },
  { key: "rules", label: "Rules", files: ["rules.md"] },
  { key: "scratch", label: "Scratch", files: [] },
  { key: "archive", label: "Archive", files: null },
  { key: "attention", label: "Attention", files: [] },
];

// Below this width the list and the detail are two screens rather than two panes (see style.css).
const NARROW = matchMedia("(max-width: 760px)");

const FORM_LABELS ={ invariant: "invariants", property: "properties", heuristic: "heuristics" };

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
  editing: null, // { key, text, entryId, file } while an edit box is open
  events: null,
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
  const target = resolveId(id);
  return h(
    "a",
    {
      class: `idlink ${target ? "" : "missing"}`,
      href: "#",
      title: target ? `${target.id} · ${target.title}` : `${id} does not exist`,
      onclick: (ev) => {
        ev.preventDefault();
        if (target) select(target);
      },
    },
    id,
  );
}

function linkifyText(text) {
  return linkify(h("span", {}, text));
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

const refOf = (e) => ({ file: e.file, hash: e.hash, index: e.index, id: e.id });

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

function entriesForTab() {
  const d = state.data;
  const q = state.query.trim().toLowerCase();
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
  for (const [key, value] of Object.entries(state.filters[state.tab] || {})) {
    if (value) list = list.filter((e) => e.meta[key] === value);
  }
  return list;
}

function renderFilters() {
  const box = document.getElementById("filters");
  box.replaceChildren();
  if (state.query) {
    box.append(h("span", { class: "muted" }, `Searching all files for “${state.query}”`));
    return;
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
  if (m["enforced-by"]) out.push(h("span", { class: "badge tested", title: m["enforced-by"] }, "tested"));
  const blocked = state.data.todoOrder.find((t) => t.id === e.id)?.blockedBy || [];
  if (e.file === "todo.md" && blocked.length) out.push(h("span", { class: "badge blocked" }, `after ${blocked.join(", ")}`));
  if (state.query) out.push(h("span", { class: "badge file" }, e.file.replace(/\.md$/, "")));
  return out;
}

function listItem(e) {
  return h(
    "li",
    {
      class: keyOf(e) === state.selected ? "sel" : "",
      onclick: () => select(e),
    },
    h("div", { class: "row1" }, h("span", { class: "id" }, e.id || "?"), h("span", { class: "title" }, e.title)),
    h("div", { class: "row2" }, ...badges(e), h("span", { class: "age" }, ageOf(e))),
  );
}

function renderList() {
  const ul = document.getElementById("list");
  ul.replaceChildren();
  if (state.tab === "attention" && !state.query) return renderAttentionList(ul);
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

function renderAttentionList(ul) {
  const { attention, problems } = state.data;
  if (!attention.length && !problems.length) ul.append(h("li", { class: "empty" }, "Nothing needs attention."));
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

// ---------- detail ----------

function metaTable(e) {
  const dl = h("dl", { class: "meta" });
  for (const [k, v] of Object.entries(e.meta)) dl.append(h("dt", {}, k), h("dd", {}, linkifyText(v)));
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
  bar.append(h("button", { onclick: () => startEdit(e) }, "Edit"));
  if (e.file === "todo.md") bar.append(h("button", { onclick: () => op({ op: "complete", ref }, `${e.id} moved to done`) }, "Mark done"));
  if (e.file === "done.md") bar.append(h("button", { onclick: () => op({ op: "archive", ref }, (r) => `${e.id} archived to ${r.moved}`) }, "Archive"));
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
  bar.append(
    h("button", {
      class: "danger",
      onclick: () => confirm(`Delete ${e.id || "this entry"} from ${e.file}? This cannot be undone.`) && op({ op: "delete", ref }, `${e.id} deleted`),
    }, "Delete"),
  );
  return bar;
}

function startEdit(e) {
  state.editing = { key: keyOf(e), text: e.raw, entryId: e.id, file: e.file };
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
    op({ op: "replace", ref: refOf(current), raw: state.editing.text }, `${e.id} saved`);
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
  }, "Edit")), linkify(body));
}

function renderDetail() {
  const pane = document.getElementById("detail");
  pane.replaceChildren();
  if (state.tab === "scratch" && !state.query) return renderScratch(pane);
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
    pane.append(editor(e));
    return;
  }
  pane.append(actions(e), metaTable(e));
  const body = h("article", { class: "md" });
  body.innerHTML = e.html;
  pane.append(linkify(body));
  const related = [supersedesChain(e), backlinks(e)].filter(Boolean);
  pane.append(...related);
}

function overview() {
  const d = state.data;
  const count = (f) => d.entries.filter((e) => e.file === f).length;
  return h("div", {},
    h("h2", {}, d.name),
    h("p", { class: "muted" }, d.root),
    h("p", {}, `${count("todo.md")} todo · ${plural(count("questions.md"), "open question")} · ${plural(count("rules.md"), "rule")} · ${count("done.md")} done · ${plural(count("answers.md"), "answer")}`),
    h("p", {}, d.attention.length || d.problems.length ? `${d.attention.length + d.problems.length} items need attention.` : "Nothing needs attention."),
    h("p", { class: "muted keys" }, "Keys: / search · j/k move · Enter open · e edit · Esc back"));
}

// ---------- chrome ----------

function renderTabs() {
  const nav = document.getElementById("tabs");
  nav.replaceChildren();
  const d = state.data;
  for (const t of TABS) {
    let n;
    if (t.key === "attention") n = d.attention.length + d.problems.length;
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
