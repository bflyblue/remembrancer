# Remembrancer for Claude Code (a mod)

A thin layer over the `remembrancer` CLI's `--json`: every decision stays in the CLI, and this mod runs it and draws.
Mods are early access: the API may change between Claude Code releases (this one is written against 2.1.291).

- **The brief** goes into the system prompt at the start of every session in a project with `.remembrancer/`.
- **`/rmb`** opens a pane: what waits on the owner, the current plan's next tasks, the rules with their machine checks
  (`remembrancer check`), and a search box. It refreshes after any Bash command that runs `remembrancer` or `rmb`, and
  with its Refresh button.
- **`/rmb waiting`**, **`/rmb done T### [outcome]`** and **`/rmb search terms`** run the CLI command of that name.
- **Edits go through the CLI.** A direct Edit or Write to a file under `.remembrancer/` is refused, naming the commands
  for that file; the path is resolved first, so a link or `..` cannot slip past. `scratch.md` and `config.json`, which no
  command writes, are edited directly and linted after (problems go to the model and a toast).
- **The commit guard** runs before a Bash command that names `git` or `gh`, and refuses one that would publish the
  project's IDs while `.remembrancer/` is private.

It replaces the three settings hooks in the main README (SessionStart, PostToolUse, PreToolUse): remove them when you
install the mod, or the brief arrives twice.

## Install

For one session, from the checkout:

```sh
claude --plugin-dir ~/devel/personal/remembrancer/integrations/claude-code
```

To keep it, add the checkout as a marketplace and install from it (the plugin is read from the folder, so
`/reload-plugins` picks up edits):

```sh
claude plugin marketplace add ~/devel/personal/remembrancer
claude plugin install remembrancer@remembrancer
```

If `remembrancer` is not on your PATH, set how to run it (the `cli` option):

```sh
echo '{"cli": "bun ~/devel/personal/remembrancer/src/cli.ts"}' | claude plugin configure remembrancer --values-stdin
```

## Develop

```sh
claude plugin validate integrations/claude-code
claude plugin test integrations/claude-code
```

The tests answer the CLI from memory (`process.run`), so they need no project.
