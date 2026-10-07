import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { THRESHOLDS, attention, lint, openTodos } from "./analyse";
import { linksIn, renderMarkdown, servedRoot } from "./links";
import { LintRefusedError, archiveEntry, completeEntry, deleteEntry, replaceEntry, replaceFile, setMeta } from "./commands";
import { ConflictError, DIR, type EntryRef, NotFoundError, RefusedError, listFiles, loadProject } from "./project";
import appJs from "./ui/app.js" with { type: "text" };
import indexHtml from "./ui/index.html" with { type: "text" };
import styleCss from "./ui/style.css" with { type: "text" };

const POLL_MS = 1000;

// A linked file may be HTML or SVG from the repo: serve those sandboxed, so
// they run no script with this origin's cookie and can't reach the write
// token. Other types can't run script (nosniff), and a sandbox would stop
// Chrome's PDF viewer.
const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const ACTIVE = /html|svg|xml/i;

// Entries may quote untrusted text: forbid inline script and require a
// per-process token for writes. On loopback, reject foreign Hosts (DNS
// rebinding); beyond loopback, require the access key on every request.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";

function signature(root: string): string {
  return listFiles(root)
    .map((rel) => {
      const s = statSync(join(root, DIR, rel), { throwIfNoEntry: false });
      return `${rel}:${s?.mtimeMs}:${s?.size}`;
    })
    .join("|");
}

async function projectData(root: string, top: string) {
  const project = await loadProject(root);
  const hashes = Object.fromEntries(project.files.map((f) => [f.path, f.hash]));
  const scratch = project.files.find((f) => f.path === "scratch.md")?.text ?? "";
  const scratchHtml = renderMarkdown(scratch);
  return {
    name: project.name,
    root,
    thresholds: THRESHOLDS,
    files: project.files.map((f) => ({ path: f.path, hash: f.hash, preamble: f.preamble, count: f.entries.length })),
    scratch,
    scratchHtml,
    scratchLinks: linksIn(root, top, "scratch.md", scratchHtml),
    entries: project.entries.map((e) => {
      const html = renderMarkdown(e.body);
      return {
        id: e.id,
        kind: e.kind,
        title: e.title,
        meta: e.meta,
        body: e.body,
        html,
        // Links that name a file, as written → path for /file. Only these are served.
        links: linksIn(root, top, e.file, html, e.kind === "K" ? e.meta.link : undefined),
        raw: e.raw,
        file: e.file,
        index: e.index,
        hash: hashes[e.file],
      };
    }),
    todoOrder: openTodos(project).map((t) => ({ id: t.id, blockedBy: t.blockedBy })),
    attention: attention(project),
    problems: lint(project),
  };
}

export interface ServeOptions {
  host?: string;
  // Required to reach the server at all. Set it whenever the server listens
  // beyond loopback: anyone who can edit rules.md can steer the agents that read it.
  key?: string;
}

const KEY_COOKIE = "rmb_key";

export function isLoopback(host: string): boolean {
  return /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(host);
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieKey(req: Request): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === KEY_COOKIE) return decodeURIComponent(value.join("="));
  }
  return "";
}

export function serve(roots: string[], port: number, opts: ServeOptions = {}) {
  const hostname = opts.host ?? "127.0.0.1";
  if (!isLoopback(hostname) && !opts.key) throw new Error(`listening on ${hostname} needs an access key`);
  const token = crypto.randomUUID();
  const subscribers = roots.map(() => new Set<ReadableStreamDefaultController>());
  const signatures = roots.map(signature);
  const tops = roots.map(servedRoot);
  const encoder = new TextEncoder();

  setInterval(() => {
    roots.forEach((root, i) => {
      const sig = signature(root);
      if (sig === signatures[i]) return;
      signatures[i] = sig;
      for (const c of subscribers[i]) c.enqueue(encoder.encode("data: change\n\n"));
    });
  }, POLL_MS);
  setInterval(() => {
    for (const set of subscribers) for (const c of set) c.enqueue(encoder.encode(": ping\n\n"));
  }, 20_000);

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const page = (body: string, type: string) =>
    new Response(body, { headers: { "content-type": type, "content-security-policy": CSP, "cache-control": "no-store" } });

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (opts.key) {
        // The key cookie also stops DNS rebinding: a rebound origin never has it.
        const given = url.searchParams.get("key");
        if (given !== null && sameSecret(given, opts.key)) {
          url.searchParams.delete("key");
          const cookie = `${KEY_COOKIE}=${encodeURIComponent(opts.key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
          // Not a redirect: a navigation that started in another app (a phone's QR scanner)
          // stays cross-site through redirects, so Safari would drop the Strict cookie on the
          // next request. A refresh from this page is a same-site navigation.
          const target = (url.pathname + url.search).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
          const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${target}"><title>remembrancer</title><a href="${target}">Continue</a>\n`;
          return new Response(html, {
            headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store", "set-cookie": cookie },
          });
        }
        if (!sameSecret(cookieKey(req), opts.key)) {
          return new Response("remembrancer: open the URL with ?key=… printed by `remembrancer serve`\n", { status: 401 });
        }
      } else {
        const host = req.headers.get("host") ?? "";
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return new Response("bad host", { status: 403 });
      }

      if (url.pathname === "/") return page(indexHtml.replace("__TOKEN__", token), "text/html; charset=utf-8");
      if (url.pathname === "/app.js") return page(appJs, "text/javascript; charset=utf-8");
      if (url.pathname === "/style.css") return page(styleCss, "text/css; charset=utf-8");
      if (url.pathname === "/api/projects") return json(roots.map((root, i) => ({ i, name: root.split("/").pop(), root })));

      const m = /^\/api\/p\/(\d+)(\/events|\/op|\/file)?$/.exec(url.pathname);
      const i = m ? parseInt(m[1], 10) : -1;
      const root = roots[i];
      if (!m || !root) return json({ error: "not found" }, 404);

      if (!m[2] && req.method === "GET") return json(await projectData(root, tops[i]));

      if (m[2] === "/file" && (req.method === "GET" || req.method === "HEAD")) {
        const path = url.searchParams.get("path") ?? "";
        const data = await projectData(root, tops[i]);
        const linked = [data.scratchLinks, ...data.entries.map((e) => e.links)].some((l) => Object.values(l).includes(path));
        if (!linked) return json({ error: "no entry links to that file" }, 404);
        const file = Bun.file(join(tops[i], path));
        const headers: Record<string, string> = { "content-type": file.type, "x-content-type-options": "nosniff", "cache-control": "no-store" };
        if (ACTIVE.test(file.type)) headers["content-security-policy"] = FILE_CSP;
        return new Response(file, { headers });
      }

      if (m[2] === "/events") {
        let ctrl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctrl = c;
            subscribers[i].add(c);
            c.enqueue(encoder.encode("retry: 2000\n\n"));
          },
          cancel() {
            subscribers[i].delete(ctrl);
          },
        });
        server.timeout(req, 0);
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }

      if (m[2] === "/op" && req.method === "POST") {
        if (req.headers.get("x-token") !== token) return json({ error: "bad token" }, 403);
        const body = (await req.json()) as { op: string; ref?: EntryRef; raw?: string; updates?: Record<string, string>; file?: string; hash?: string; text?: string };
        try {
          const ref = body.ref!;
          switch (body.op) {
            case "replace":
              await replaceEntry(root, ref, body.raw ?? "");
              break;
            case "delete":
              await deleteEntry(root, ref);
              break;
            case "meta":
              await setMeta(root, ref, body.updates ?? {});
              break;
            case "archive":
              return json({ ok: true, moved: await archiveEntry(root, ref) });
            case "complete":
              return json({ ok: true, moved: await completeEntry(root, ref) });
            case "drop":
              return json({ ok: true, moved: await completeEntry(root, ref, { dropped: true }) });
            case "file":
              await replaceFile(root, body.file ?? "", body.hash ?? "", body.text ?? "");
              break;
            default:
              return json({ error: `unknown op ${body.op}` }, 400);
          }
          return json({ ok: true });
        } catch (err) {
          if (err instanceof ConflictError) return json({ error: err.message, conflict: true }, 409);
          if (err instanceof NotFoundError) return json({ error: err.message }, 404);
          if (err instanceof LintRefusedError) return json({ error: err.message, problems: err.problems }, 422);
          if (err instanceof RefusedError) return json({ error: err.message }, 422);
          throw err;
        }
      }
      return json({ error: "not found" }, 404);
    },
  });
  return server;
}
