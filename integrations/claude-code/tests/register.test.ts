import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The world beneath the mod: a project at /proj whose remembrancer CLI answers from memory.
const BRIEF = {
  project: 'proj',
  owner: 'shaun',
  waiting: [{ id: 'Q207', kind: 'Q', file: 'questions.md', title: 'Which drive?', meta: {} }],
  phase: { plan: { id: 'T262', kind: 'T', file: 'todo.md', title: 'Plan: the course correction', meta: {} }, phase: null, done: 3, total: 6, next: [{ id: 'T258', kind: 'T', file: 'todo.md', title: 'Bring the ledger through', meta: {} }] },
  inbox: 1,
  rules: [
    { id: 'R009', title: 'Nothing names a body', status: 'active', form: 'invariant', tested: true, check: { status: 'pass', at: '2026-10-07T18:38Z', message: 'passed' } },
    { id: 'R016', title: 'One leg kind, many forms', status: 'active', form: 'invariant', tested: true, check: { status: 'fail', at: '2026-10-07T18:38Z', message: 'exit 1' } },
  ],
  checks: { pass: 1, fail: 1, unrunnable: 0, notRun: 0 },
}
const SEARCH = { query: 'crossing', hits: [{ id: 'A205', score: 7.8, via: 'A203', entry: { title: 'Refinement dropped', file: 'answers.md' } }] }

const ran = (stdout: string, exitCode = 0, stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

// The CLI's answers, by its subcommand; every call is kept for the test to read.
function world(on: On, answers: Record<string, ReturnType<typeof ran>> = {}) {
  const calls: string[][] = []
  mock.env(on, { HOME: '/home/shaun' })
  // A call on $ is answered { value }; the session's own events by their result.
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const args = e.argv.slice(1)
    calls.push([...e.argv])
    const key = args[0] === 'brief' ? (args.includes('--json') ? 'brief-json' : 'brief') : args[0] === 'search' ? (args.includes('--json') ? 'search-json' : 'search') : String(args[0])
    const defaults: Record<string, ReturnType<typeof ran>> = {
      'brief-json': ran(JSON.stringify(BRIEF)),
      brief: ran('Remembrancer · proj · 1 todo'),
      'search-json': ran(JSON.stringify(SEARCH)),
      search: ran('A205  7.84  Refinement dropped  (answers.md)  via A203'),
      waiting: ran('shaun:\n  Q207 Which drive?  (questions.md)\n'),
      done: ran('T258 → done.md · hash: abc'),
      lint: ran(JSON.stringify({ ok: true, problems: [] })),
      guard: ran(''),
    }
    return { value: answers[key] ?? defaults[key] ?? ran('', 1, `unexpected ${args.join(' ')}`) }
  })
  return calls
}

const START = { cwd: '/proj', surface: 'terminal' as const, isInteractive: true }

describe('edits under .remembrancer/', () => {
  test('a direct edit of todo.md is refused, naming the commands', async ($, on) => {
    world(on)
    on('tool.call', () => ({ result: 'edited' }) as never)
    const r = await $.tool.call({ tool: 'Edit', file_path: '/proj/.remembrancer/todo.md', old_string: 'a', new_string: 'b' })
    expect(r.deny).toContain('remembrancer new T, set, append, edit, done, drop')
    const w = await $.tool.call({ tool: 'Write', file_path: '.remembrancer/answers.md', content: 'x' })
    expect(w.deny).toContain('remembrancer answer, decide')
  })

  test('scratch.md is edited directly, then linted; problems reach the model', async ($, on) => {
    world(on, { lint: ran(JSON.stringify({ ok: false, problems: [{ file: 'scratch.md', id: 'T999', message: 'refers to T999, which does not exist' }] }), 1) })
    on('tool.call', () => ({ result: 'edited' }) as never)
    const r = await $.tool.call({ tool: 'Edit', file_path: '/proj/.remembrancer/scratch.md', old_string: 'a', new_string: 'b' })
    expect(r.deny).toBeUndefined()
    expect(r.context?.join('\n')).toContain('refers to T999')
  })

  test('an edit outside the folder passes untouched', async ($, on) => {
    const calls = world(on)
    on('tool.call', () => ({ result: 'edited' }) as never)
    const r = await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.ts', old_string: 'a', new_string: 'b' })
    expect(r.deny).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

describe('Bash', () => {
  test('the commit guard refuses a commit that would publish IDs; other commands skip it', async ($, on) => {
    const calls = world(on, { guard: ran('', 2, 'remembrancer: these IDs would mean nothing: T001') })
    on('tool.call', () => ({ result: 'ran' }) as never)
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix T001"' })
    expect(r.deny).toContain('these IDs would mean nothing')
    const ls = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(ls.deny).toBeUndefined()
    expect(calls.filter(c => c.includes('guard'))).toHaveLength(1)
  })

  test('a command that runs the CLI refreshes the brief', async ($, on) => {
    const calls = world(on)
    on('tool.call', () => ({ result: 'ran' }) as never)
    await $.tool.call({ tool: 'Bash', command: 'remembrancer set T001 priority=P1' })
    expect(calls.some(c => c.includes('brief') && c.includes('--json'))).toBe(true)
  })
})

describe('/rmb', () => {
  test('waiting, done and search run the CLI command of that name', async ($, on) => {
    const calls = world(on)
    await $.session.start(START)
    const run = (args: string) => $.command.run({ command: 'rmb', args } as never)
    expect((await run('waiting')).text).toContain('Q207 Which drive?')
    expect((await run('done T258 the ledger is current')).text).toContain('T258 → done.md')
    expect(calls).toContainEqual(['remembrancer', 'done', 'T258', '--outcome', 'the ledger is current'])
    expect((await run('search crossing')).text).toContain('A205')
  })

  test('the cli option says how to run it, ~ expanded', { options: { cli: 'bun ~/devel/personal/remembrancer/src/cli.ts' } }, async ($, on) => {
    const calls = world(on)
    await $.command.run({ command: 'rmb', args: 'waiting' } as never)
    expect(calls[0]?.slice(0, 3)).toEqual(['bun', '/home/shaun/devel/personal/remembrancer/src/cli.ts', 'waiting'])
  })
})

describe('the brief and the pane', () => {
  test('the brief goes last into the system prompt', async ($, on) => {
    world(on)
    on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'You are Claude.', scope: 'shared' as const }] }))
    await $.session.start(START)
    const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(r.sections.map(s => s.id)).toEqual(['base', 'remembrancer:brief'])
    expect(r.sections[1]?.text).toContain('Remembrancer · proj')
  })

  test('the pane shows what waits, the plan, the rules with their checks, and searches', async ($, on) => {
    world(on)
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'remembrancer',
        surface,
        component: 'Pane',
        requestId: 'remembrancer',
        props: { title: 'Remembrancer', isFocused: true, bodyColumns: 80, placement: 'dock' } as never,
      })
      expect(await ui.find({ type: 'Text', text: /Waiting on shaun \(1\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Q207 Which drive\?/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /next: T258/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /checks 1 FAIL, 1 pass/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /R016 FAIL/ })).toBeDefined()
      await ui.input({ key: 'q', text: 'crossing' })
      expect(await ui.find({ type: 'Text', text: /A205 Refinement dropped \(answers.md\) via A203/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
