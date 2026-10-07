// Remembrancer for Claude Code, as a mod: a thin layer over the CLI's --json.
// Every decision stays in the CLI; this module runs it ($.process.run) and draws.
//
// - The brief goes into the system prompt (in place of the SessionStart hook).
// - /rmb opens a pane: what waits on the owner, the current plan's next tasks,
//   the rules with their machine checks, and a search box. /rmb waiting,
//   /rmb done T### [outcome] and /rmb search … run the CLI command of that name.
// - A direct Edit or Write under .remembrancer/ is refused, naming the command
//   to use; scratch.md and config.json, which no command writes, are allowed
//   and linted after.
// - Before a Bash call that may publish (git, gh), the commit guard runs; after
//   a Bash call that names remembrancer or rmb, the pane's data is refreshed.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RmbBrief, RmbHit, RmbSearch } from '../types'

type $ = EngineInterface

const PANE = 'remembrancer'
const SECTION = 'remembrancer:brief'
const brief = atom({ plugin: 'remembrancer', key: 'brief' } as const, null as RmbBrief | null)
const briefText = atom({ plugin: 'remembrancer', key: 'briefText' } as const, '')
const searched = atom({ plugin: 'remembrancer', key: 'search' } as const, null as RmbSearch | null)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MARK = '/.remembrancer/'
// Files no command writes: edited directly, then linted.
const DIRECT = new Set(['scratch.md', 'config.json'])
// The commands that make each file's edits.
const COMMANDS: Record<string, string> = {
  'todo.md': 'remembrancer new T, set, append, edit, done, drop',
  'done.md': 'remembrancer done, drop, set, append, edit, move',
  'questions.md': 'remembrancer new Q, answer, set, append, edit',
  'answers.md': 'remembrancer answer, decide, supersede, amend, set, append, edit',
  'rules.md': 'remembrancer new R, rule, supersede, amend, set, append, edit',
  'resources.md': 'remembrancer new K, set, append, edit',
}

type Ran = { exitCode: number; stdout: string; stderr: string }

// How the CLI is run (the cli option, split into words), set by register.
let words = ['remembrancer']

// Run the CLI in the session's directory. A CLI that cannot start reads as exit 127.
async function cli($: $, args: string[]): Promise<Ran> {
  const home = (await $.env.get('HOME')) ?? ''
  const argv = words.map(w => (w.startsWith('~/') ? home + w.slice(1) : w))
  try {
    const r = await $.process.run([...argv, ...args], { cwd: await $.session.cwd(), timeoutMs: 60_000 })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: `could not run ${argv.join(' ')}: ${String(err)}` }
  }
}

function said(r: Ran): string {
  return r.stdout.trim() || r.stderr.trim() || `exit ${r.exitCode}`
}

// The brief, as data for the pane and as text for the system prompt; both empty outside a project.
async function refresh($: $) {
  const [data, text] = await Promise.all([cli($, ['brief', '--hook', '--json']), cli($, ['brief', '--hook'])])
  let parsed: RmbBrief | null = null
  try {
    parsed = data.exitCode === 0 && data.stdout.trim() ? (JSON.parse(data.stdout) as RmbBrief) : null
  } catch {
    parsed = null
  }
  await update($, brief, () => parsed)
  await update($, briefText, () => (text.exitCode === 0 ? text.stdout.trim() : ''))
}

async function runSearch($: $, query: string) {
  const q = query.trim()
  if (!q) return update($, searched, () => null)
  const r = await cli($, ['search', q, '--json', '--k', '12'])
  let next: RmbSearch
  try {
    const data = JSON.parse(r.stdout) as { hits: { id: string; via?: string; entry: { title: string; file: string } }[] }
    const hits: RmbHit[] = data.hits.map(hit => ({ id: hit.id, via: hit.via, title: hit.entry.title, file: hit.entry.file }))
    next = { query: q, hits }
  } catch {
    next = { query: q, hits: [], error: said(r) }
  }
  return update($, searched, () => next)
}

// Where a path lands inside .remembrancer/, as a path relative to it, or null.
async function memoryFile($: $, path: string): Promise<string | null> {
  const abs = path.startsWith('/') ? path : `${await $.session.cwd()}/${path}`
  const real = async (p: string) => {
    try {
      return (await $.fs.stat(p, { resolve: true })).realPath
    } catch {
      return undefined
    }
  }
  let landed = await real(abs)
  if (!landed) {
    // A new file: resolve its folder, then add its name.
    const cut = abs.lastIndexOf('/')
    const dir = await real(abs.slice(0, cut) || '/')
    landed = dir ? `${dir}/${abs.slice(cut + 1)}` : abs
  }
  const at = landed.lastIndexOf(MARK)
  return at < 0 ? null : landed.slice(at + MARK.length)
}

export const register: Register = (on, options) => {
  words = String(options.cli ?? 'remembrancer').trim().split(/\s+/)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'rmb',
      description: 'Remembrancer: the pane, or waiting, done T###, search …',
      argumentHint: '[waiting | done T### [outcome] | search terms]',
    })
    await refresh($)
    return next(e)
  })

  // The brief, last in the system prompt, for the whole session.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = await read($, briefText)
    if (!text) return composed
    return { sections: [...composed.sections.filter(s => s.id !== SECTION), { id: SECTION, text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'rmb' }, async ($, e) => {
    const [sub, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (!sub) {
      await refresh($)
      await $.ui.open({ id: PANE, title: 'Remembrancer' })
      return { text: 'Remembrancer pane opened.' }
    }
    if (sub === 'waiting') return { text: said(await cli($, ['waiting'])) }
    if (sub === 'done') {
      const [id, ...outcome] = rest
      if (!id) return { text: 'usage: /rmb done T### [outcome]' }
      const r = await cli($, ['done', id, ...(outcome.length ? ['--outcome', outcome.join(' ')] : [])])
      await refresh($)
      return { text: said(r) }
    }
    if (sub === 'search') {
      const query = rest.join(' ')
      if (!query) return { text: 'usage: /rmb search terms' }
      await runSearch($, query)
      return { text: said(await cli($, ['search', query, '--list'])) }
    }
    return { text: 'usage: /rmb [waiting | done T### [outcome] | search terms]' }
  })

  // Direct edits under .remembrancer/: refused but for the files no command writes, which are linted after.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!EDIT_TOOLS.has(tool)) return next(e)
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
    const rel = path ? await memoryFile($, path) : null
    if (rel === null) return next(e)
    const name = rel.split('/').pop() ?? rel
    if (!DIRECT.has(rel)) {
      const how = COMMANDS[name] ?? 'the remembrancer CLI (remembrancer --help)'
      return {
        deny: `remembrancer: .remembrancer/${rel} changes only through the CLI, which locks, checks and lints: ${how}. ` +
          `Read an entry with remembrancer show ID (its hash is what edit --if takes). Only scratch.md and config.json are edited by hand.`,
      }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const lint = await cli($, ['lint', '--ids', '--json'])
    let problems: { file: string; id: string | null; message: string }[] = []
    try {
      problems = (JSON.parse(lint.stdout) as { problems: typeof problems }).problems
    } catch {
      problems = []
    }
    if (!problems.length) return ran
    const text = `remembrancer lint:\n${problems.map(p => `.remembrancer/${p.file}: ${p.id ?? '?'}: ${p.message}`).join('\n')}`
    await $.ui.toast(`remembrancer: ${problems.length} lint problem${problems.length === 1 ? '' : 's'} after editing ${rel}`)
    return { ...ran, context: [...(ran.context ?? []), text] }
  }).catch(($, e, next) => next(e))

  // The commit guard before a command that may publish; a refresh after one that ran the CLI.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command
    if (/\b(git|gh)\b/.test(command)) {
      const g = await cli($, ['guard', command])
      if (g.exitCode === 2) return { deny: g.stderr.trim() || 'remembrancer guard refused the command' }
    }
    const ran = await next(e)
    if (/\b(remembrancer|rmb)\b/.test(command)) await refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Every surface but mobile has an Input.
    const Input = 'Input' in ui ? ui.Input : null
    const b = await read($, brief)
    const s = await read($, searched)
    const refreshButton = <Button key="refresh" onPress={() => void refresh($)}>Refresh</Button>
    if (!b) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No .remembrancer/ here (remembrancer init), or the remembrancer CLI did not answer.</Text>
          {refreshButton}
        </Box>
      )
    }
    const c = b.checks
    return (
      <Box flexDirection="column">
        <Text bold>{b.project}</Text>
        <Text bold color="warning">Waiting on {b.owner ?? 'someone'} ({b.waiting.length})</Text>
        {b.waiting.length === 0 && <Text dimColor>  nothing</Text>}
        {b.waiting.map(w => <Text>  {w.id} {w.title}</Text>)}
        {b.phase && (
          <Text bold>
            {b.phase.phase ? `Phase ${b.phase.phase}: ` : 'Plan: '}{b.phase.plan.id} {b.phase.plan.title} ({b.phase.done} of {b.phase.total} done)
          </Text>
        )}
        {b.phase?.next.slice(0, 6).map(t => <Text>  next: {t.id} {t.title}</Text>)}
        {b.inbox > 0 && <Text dimColor>{b.inbox} in the inbox</Text>}
        <Text bold color={c.fail ? 'error' : 'success'}>
          Rules: checks {c.fail ? `${c.fail} FAIL, ` : ''}{c.pass} pass{c.notRun ? `, ${c.notRun} not run` : ''}{c.unrunnable ? `, ${c.unrunnable} no runner` : ''}
        </Text>
        {b.rules.map(r => (
          <Text color={r.check?.status === 'fail' ? 'error' : r.status === 'challenged' ? 'warning' : undefined} dimColor={r.status === 'proposed'}>
            {'  '}{r.id} {r.check ? (r.check.status === 'pass' ? 'pass' : r.check.status === 'fail' ? 'FAIL' : 'skip') : r.tested ? 'not run' : '    '} {r.status === 'active' ? '' : `[${r.status}] `}{r.title}
          </Text>
        ))}
        {Input && <Input key="q" placeholder="search entries" value={s?.query ?? ''} onSubmit={v => void runSearch($, v)} />}
        {s?.error && <Text color="error">{s.error}</Text>}
        {s?.hits.map(hit => <Text>  {hit.id} {hit.title} ({hit.file}){hit.via ? ` via ${hit.via}` : ''}</Text>)}
        {refreshButton}
      </Box>
    )
  })
}
