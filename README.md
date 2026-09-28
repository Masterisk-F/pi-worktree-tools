# pi-worktree-tools

Agent-callable git worktree tools with automatic working directory synchronization and shutdown cleanup for [pi-coding-agent](https://github.com/earendil-works/pi-mono).

## Motivation

Git worktrees allow working on multiple branches simultaneously in isolated directories without the overhead of stashing changes or switching checkouts.

Having the agent run raw `git worktree` commands via `bash` is error-prone, risks desynchronizing the agent's working directory context, and often leaves orphaned worktrees behind.

`pi-worktree-tools` provides dedicated, type-safe Agent Tools that allow the AI agent to autonomously manage worktrees while keeping directory context and lifecycle cleanup fully synchronized.

## Key Differentiators

- **Zero External Runtime Dependencies:** Fully self-contained. Does not rely on external extension state, avoiding cross-extension module isolation issues.
- **Agent-First Tools:** Exposes native tools (`worktree_list`, `worktree_create`, `worktree_switch`, `worktree_cleanup`) designed specifically for LLM function calling with strict prompt guidelines.
- **Dynamic CWD Synchronization:** Intercepts tool calls (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) and rewrites paths so all agent operations immediately follow directory changes without restarting the session.
- **Safe Directory Placement:** Creates worktrees under `.worktrees/<branch-name>/` at the project root with branch slashes flattened to hyphens (e.g. `feature/login` → `.worktrees/feature-login/`). Never creates worktrees inside `.git/` (which causes `git gc` to delete worktree checkouts).
- **Auto Exclude Protection:** Automatically registers `.worktrees/` in `.git/info/exclude` on first creation, preventing worktrees from polluting `git status` or being accidentally committed via `git add -A`.
- **Damage Recovery:** Detects damaged or missing worktree checkouts and cleans stale git metadata automatically instead of failing silently.
- **Automatic Shutdown Cleanup:** Tracks all worktrees created or touched during the session. When exiting Pi, it prompts the user to cleanly remove temporary worktrees.

## Available Tools

| Tool | Parameters | Description |
|---|---|---|
| `worktree_list` | _(none)_ | Lists all existing worktrees with branch names, paths, and commit hashes. Clearly tags `[prunable]` worktrees. |
| `worktree_create` | `branch: string` | Creates a new worktree branched from default (`main`/`master`) and switches CWD to it. If it already exists, switches to it. |
| `worktree_switch` | `branch: string` | Switches CWD to an existing worktree or back to the default branch (`main`). Auto-creates if not found. |
| `worktree_cleanup` | `branch: string` | Removes the worktree and deletes its branch (if merged). Switches CWD back to the default branch. |

## Configuration

Optionally configure the base directory in `~/.pi/agent/settings.json`:

```json
{
  "worktrees": {
    "baseDir": ".worktrees/"
  }
}
```

- **`worktrees.baseDir`** — Base path where worktrees are created. Defaults to `.worktrees/` relative to the repository root.
- Safety Guard: If configured to point inside `.git/`, it is automatically overridden with `.worktrees/` to prevent data loss from `git gc`.

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
