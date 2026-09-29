import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DIR, FILES } from "./project";
import answers from "../skill/templates/answers.md" with { type: "text" };
import done from "../skill/templates/done.md" with { type: "text" };
import questions from "../skill/templates/questions.md" with { type: "text" };
import rules from "../skill/templates/rules.md" with { type: "text" };
import scratch from "../skill/templates/scratch.md" with { type: "text" };
import todo from "../skill/templates/todo.md" with { type: "text" };

export const TEMPLATES: Record<(typeof FILES)[number], string> = {
  "todo.md": todo,
  "done.md": done,
  "questions.md": questions,
  "answers.md": answers,
  "rules.md": rules,
  "scratch.md": scratch,
};

const MARKER = "<!-- remembrancer -->";
export const AGENTS_SNIPPET = `${MARKER}
## Remembrancer

This project keeps its working memory in \`.remembrancer/\` (use the remembrancer skill):
tasks, done work, open questions, answers and rules.
Before reviewing code or committing, check the change against the active rules in
\`.remembrancer/rules.md\`, run any \`enforced-by\` checks, and cite the rule IDs (R###) that apply.
`;

async function gitDir(root: string): Promise<string | null> {
  const proc = Bun.spawnSync(["git", "rev-parse", "--absolute-git-dir"], { cwd: root, stderr: "ignore" });
  if (proc.exitCode !== 0) return null;
  // Worktrees share info/exclude with the common dir.
  const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, stderr: "ignore" });
  const out = (common.exitCode === 0 ? common.stdout : proc.stdout).toString().trim();
  return out || null;
}

async function ensureLine(path: string, line: string): Promise<boolean> {
  const f = Bun.file(path);
  const text = (await f.exists()) ? await f.text() : "";
  if (text.split("\n").some((l) => l.trim() === line)) return false;
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, (text && !text.endsWith("\n") ? "\n" : "") + line + "\n");
  return true;
}

export async function init(root: string, opts: { local?: boolean } = {}): Promise<string[]> {
  const log: string[] = [];
  await mkdir(join(root, DIR, "archive"), { recursive: true });
  for (const [name, text] of Object.entries(TEMPLATES)) {
    const path = join(root, DIR, name);
    if (!existsSync(path)) {
      await Bun.write(path, text);
      log.push(`created ${DIR}/${name}`);
    }
  }

  const git = await gitDir(root);
  if (git) {
    const exclude = join(git, "info", "exclude");
    if (await ensureLine(exclude, `/${DIR}/`)) log.push(`added /${DIR}/ to ${exclude}`);
    if (opts.local && (await ensureLine(exclude, "/CLAUDE.local.md"))) log.push(`added /CLAUDE.local.md to ${exclude}`);
  } else {
    log.push(`not a git repository: ${DIR}/ is not excluded from anything`);
  }

  const target = opts.local
    ? "CLAUDE.local.md"
    : existsSync(join(root, "AGENTS.md")) || !existsSync(join(root, "CLAUDE.md"))
      ? "AGENTS.md"
      : "CLAUDE.md";
  const path = join(root, target);
  const f = Bun.file(path);
  const text = (await f.exists()) ? await f.text() : "";
  if (!text.includes(MARKER)) {
    await Bun.write(path, (text ? text.replace(/\s*$/, "\n\n") : "") + AGENTS_SNIPPET);
    log.push(`added the rules section to ${target}`);
  }
  return log;
}
