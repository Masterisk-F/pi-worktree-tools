# pi-worktree-tools

Agent-callable git worktree tools with automatic shutdown cleanup for [pi-coding-agent](https://github.com/earendil-works/pi-mono).

## Motivation

Git worktrees allow working on multiple branches simultaneously in isolated directories without the overhead of stashing changes or switching checkouts.

While extensions like `@harms-haus/pi-worktrees` offer interactive slash commands (e.g., `/wt-create`) for human users, LLM agents cannot execute slash commands. Having the agent run raw `git worktree` commands via `bash` is error-prone, risks desynchronizing the agent's working directory context, and often leaves orphaned worktrees behind.

`pi-worktree-tools` bridges this gap by providing dedicated, type-safe Agent Tools that allow the AI agent to autonomously manage worktrees while keeping directory context and lifecycle cleanup fully synchronized.

## Key Differentiators

- **Agent-First Tools:** Exposes native tools (`worktree_list`, `worktree_create`, `worktree_switch`, `worktree_cleanup`) designed specifically for LLM function calling with strict prompt guidelines.
- **Dynamic CWD Synchronization:** Automatically switches the effective working directory so all subsequent agent tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`) immediately operate within the active worktree.
- **Automatic Shutdown Cleanup:** Tracks all worktrees created or touched during the session (persisting across `/resume` and restarts). When exiting Pi, it prompts the user to cleanly remove temporary worktrees.

## Dependencies

`pi-worktree-tools` builds on top of two foundational extensions:

- **[`@harms-haus/pi-cwd`](https://github.com/harms-haus/pi-cwd):** Manages dynamic working directory state and intercepts tool calls so all file and shell operations seamlessly follow directory changes.
- **[`@harms-haus/pi-worktrees`](https://github.com/harms-haus/pi-worktrees):** Provides core Git worktree operations, porcelain output parsing, branch name validation, and footer status display.

## Available Tools

| Tool | Parameters | Description |
|---|---|---|
| `worktree_list` | _(none)_ | Lists all existing worktrees with branch names, paths, and commit hashes. |
| `worktree_create` | `branch: string` | Creates a new worktree branched from default (`main`/`master`) and switches CWD to it. If it already exists, switches to it. |
| `worktree_switch` | `branch: string` | Switches CWD to an existing worktree or back to the default branch (`main`). Auto-creates if not found. |
| `worktree_cleanup` | `branch: string` | Removes the worktree and deletes its branch (if merged). Switches CWD back to the default branch. |

## Installation

```bash
pi install /path/to/pi-worktree-tools
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-worktree-tools"
  ]
}
```

## License

MIT
