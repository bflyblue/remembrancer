import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DIR } from "./project";

export const MARKDOWN = { autolinks: true, headings: { ids: true } } as const;

export function renderMarkdown(text: string): string {
  return Bun.markdown.html(text, MARKDOWN);
}

// The directory local links are served from: the git work tree when there is
// one (entries often name files from the repo root, above a sub-project), or
// the project root. Nothing outside it is ever served.
export function servedRoot(root: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: root, stderr: "ignore" });
  const top = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
  return realpathSync(top || root);
}

// Never served, even when an entry links to it.
const PRIVATE = /(^|\/)(\.git|\.env[^/]*)(\/|$)/;

const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e as string]!);

// Link targets in rendered HTML that may name a file: every href and src, and
// inline code that looks like a path (`src/foo.ts`, `STATUS.md`), since that
// is how agents usually cite files.
function candidates(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) out.add(decode(m[1]));
  for (const m of html.matchAll(/<code>([^<]{1,300})<\/code>/g)) {
    const text = decode(m[1]).trim();
    if (/^[\w.@~/-][\w.@/+-]*$/.test(text) && /[/.]/.test(text) && !/^\.+$/.test(text)) out.add(text);
  }
  return [...out];
}

// Where a link as written points, as a path relative to `top`, or null when it
// is a URL, an anchor, or no file. A relative link is tried the way markdown
// means it (from the entry's file), then from the project root, then from `top`.
export function resolveLocal(link: string, bases: string[], top: string): string | null {
  let path = link.split(/[?#]/)[0];
  if (/^file:\/\//i.test(link)) {
    try {
      path = fileURLToPath(link);
    } catch {
      return null;
    }
  } else if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  try {
    path = decodeURIComponent(path);
  } catch {}
  for (const base of isAbsolute(path) ? [top] : bases) {
    try {
      const real = realpathSync(resolve(base, path));
      const rel = relative(top, real);
      if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel) || PRIVATE.test(rel.split(sep).join("/"))) continue;
      if (statSync(real).isFile()) return rel;
    } catch {}
  }
  return null;
}

// The links in one file's rendered HTML that name a file: link as written →
// path under `top`. A resource's `link:` counts too, read from the project root.
export function linksIn(root: string, top: string, file: string, html: string, resourceLink?: string): Record<string, string> {
  const real = realpathSync(root);
  const bases = [...new Set([dirname(join(real, DIR, file)), real, top])];
  const out: Record<string, string> = {};
  for (const link of candidates(html)) {
    const path = resolveLocal(link, bases, top);
    if (path) out[link] = path;
  }
  const path = resourceLink ? resolveLocal(resourceLink, [real], top) : null;
  if (resourceLink && path) out[resourceLink] = path;
  return out;
}
