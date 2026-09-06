import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setEffectiveCwd, updateFooterStatus } from "@harms-haus/pi-cwd/src/state.js";
import { parseWorktreePorcelain } from "@harms-haus/pi-worktrees/src/git.js";
import {
  createWorktree,
  switchWorktree,
  cleanupWorktree,
  detectMainRepoWithExec,
  type OpsDeps,
} from "./ops.js";

export default function (pi: ExtensionAPI): void {
  const deps: OpsDeps = {
    exec: (args, cwd) => pi.exec("git", args, { cwd }),
    setEffectiveCwd,
    appendEntry: (type, data) => pi.appendEntry(type, data),
    updateFooterStatus: (ctx, cwd, original) => updateFooterStatus(ctx as any, cwd, original),
  };

  // ── worktree_create ─────────────────────────────────────────────────
  pi.registerTool({
    name: "worktree_create",
    label: "Worktree Create",
    description:
      "Create a new git worktree from the default branch and switch working directory to it. ALWAYS prefer this tool over running raw `git worktree add` commands in bash.",
    promptSnippet: "Create a git worktree and switch working directory (prefer over raw git worktree add)",
    promptGuidelines: [
      "ALWAYS use worktree_create instead of running raw `git worktree add` commands in bash when creating a worktree, so that Pi's working directory and footer status are properly updated.",
    ],
    parameters: Type.Object({
      branch: Type.String({ description: "Name of the branch to create, e.g. feature/my-feature" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await createWorktree(deps, params, ctx);
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
  });

  // ── worktree_switch ─────────────────────────────────────────────────
  pi.registerTool({
    name: "worktree_switch",
    label: "Worktree Switch",
    description:
      "Switch working directory to an existing git worktree or back to the default branch. ALWAYS prefer this tool over running raw `cd` or `git checkout` commands in bash.",
    promptSnippet: "Switch between git worktrees (prefer over cd/checkout)",
    promptGuidelines: [
      "ALWAYS use worktree_switch instead of running raw `cd` or `git checkout` commands in bash when switching between worktrees or returning to main.",
    ],
    parameters: Type.Object({
      branch: Type.String({ description: "Branch name or default branch name (e.g. main)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await switchWorktree(deps, params, ctx);
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
  });

  // ── worktree_cleanup ────────────────────────────────────────────────
  pi.registerTool({
    name: "worktree_cleanup",
    label: "Worktree Cleanup",
    description:
      "Remove a git worktree and delete its branch if merged. Switches working directory back to main. ALWAYS prefer this tool over running raw `git worktree remove` commands in bash.",
    promptSnippet: "Clean up a git worktree and return to main (prefer over raw git worktree remove)",
    promptGuidelines: [
      "ALWAYS use worktree_cleanup instead of running raw `git worktree remove` or `git branch -D` commands in bash to safely clean up worktrees and restore session directory.",
    ],
    parameters: Type.Object({
      branch: Type.String({ description: "Branch name of the worktree to remove" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await cleanupWorktree(deps, params, ctx);
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
  });

  // ── session_shutdown hook ──────────────────────────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit" || !ctx.hasUI) return;

    // 1. Scan session branch history for worktrees created via worktree_create tool
    const createdBranches = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "worktree_create"
      ) {
        const branch = entry.message.details?.branch;
        if (typeof branch === "string" && branch.length > 0) {
          createdBranches.add(branch);
        }
      }
    }

    if (createdBranches.size === 0) return;

    // 2. Check which of the created worktrees currently exist in git
    const mainRepo = await detectMainRepoWithExec(deps.exec, ctx.cwd);
    if (!mainRepo) return;

    const listResult = await deps.exec(["worktree", "list", "--porcelain"], mainRepo);
    if (listResult.code !== 0) return;

    const worktrees = parseWorktreePorcelain(listResult.stdout);
    const existing = worktrees.filter((wt) => createdBranches.has(wt.branchName));
    if (existing.length === 0) return;

    // 3. Confirm deletion with user
    const names = existing.map((wt) => wt.branchName).join(", ");
    const confirmed = await ctx.ui.confirm(
      "Worktree Cleanup",
      `このセッションで作成した以下の worktree が残っています。削除しますか？\n${names}`,
    );

    if (confirmed) {
      for (const wt of existing) {
        try {
          await cleanupWorktree(deps, { branch: wt.branchName }, ctx);
          ctx.ui.notify(`Deleted worktree '${wt.branchName}'`, "info");
        } catch (err) {
          ctx.ui.notify(
            `Failed to cleanup worktree '${wt.branchName}': ${(err as Error).message}`,
            "warning",
          );
        }
      }
    }
  });
}
