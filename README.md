# pi-worktree-tools

Agent-callable git worktree tools with automatic shutdown cleanup for [pi-coding-agent](https://github.com/earendil-works/pi-mono).

## Features

- **Agent Tools:** Provides `worktree_create`, `worktree_switch`, and `worktree_cleanup` tools that the LLM agent can call autonomously.
- **CWD Switching:** Seamlessly changes effective working directory for all subsequent tool calls (bash, read, edit, write, grep, find, ls) using `@harms-haus/pi-cwd`.
- **Default Branch Branching:** Worktrees are automatically branched from the detected default branch (`main`, `master`, `develop`).
- **Shutdown Cleanup:** Prompts the user to delete any worktrees created during the session when exiting Pi. Survives session restarts and `/resume`.
- **Bundled Dependencies:** Automatically bundles `@harms-haus/pi-cwd` and `@harms-haus/pi-worktrees` for zero-configuration installation.

## Installation

```bash
pi install /path/to/pi-worktree-tools
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/home/tatu/Projects/pi-worktree-tools"
  ]
}
```

## Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `worktree_create` | `branch: string` | Creates a worktree from the default branch and switches working directory to it. |
| `worktree_switch` | `branch: string` | Switches working directory to an existing worktree or back to the default branch (`main`). |
| `worktree_cleanup` | `branch: string` | Removes a worktree and deletes its branch (if merged). Switches working directory back to main. |

## License

MIT
