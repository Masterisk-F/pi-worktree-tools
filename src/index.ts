import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import { setEffectiveCwd, getEffectiveCwd, updateFooterStatus } from "@harms-haus/pi-cwd/src/state.js";
import { parseWorktreePorcelain } from "@harms-haus/pi-worktrees/src/git.js";
import type { WorktreeInfo } from "@harms-haus/pi-worktrees/src/types.js";
import {
  createWorktree,
  switchWorktree,
  cleanupWorktree,
  detectMainRepoWithExec,
  type OpsDeps,
} from "./ops.js";

export default function (pi: ExtensionAPI): void {
  const getCwd = () => getEffectiveCwd() || process.cwd();

  const deps: OpsDeps = {
    exec: (args, cwd) => pi.exec("git", args, { cwd: cwd || getCwd() }),
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
      const activeCwd = getEffectiveCwd() || ctx.cwd;
      const result = await createWorktree(deps, params, { cwd: activeCwd });
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
      const activeCwd = getEffectiveCwd() || ctx.cwd;
      const result = await switchWorktree(deps, params, { cwd: activeCwd });
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
      const activeCwd = getEffectiveCwd() || ctx.cwd;
      const result = await cleanupWorktree(deps, params, { cwd: activeCwd });
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
  });

  // ── session_shutdown hook ──────────────────────────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    try {
      appendFileSync(
        "/tmp/pi-worktree-tools-debug.log",
        `[shutdown] event: ${JSON.stringify(event)}, hasUI: ${ctx.hasUI}, getEffectiveCwd: ${getEffectiveCwd()}, ctx.cwd: ${ctx.cwd}\n`,
      );
    } catch {}

    if (event.reason !== "quit" || !ctx.hasUI) return;

    // 1. Collect candidate paths to discover git repositories touched in this session
    const candidatePaths = new Set<string>();
    const currentCwd = getEffectiveCwd();
    if (currentCwd) candidatePaths.add(currentCwd);
    if (ctx.cwd) candidatePaths.add(ctx.cwd);

    // 2. Collect all branches and paths touched in this session from branch history
    const touchedBranches = new Set<string>();
    const touchedPaths = new Set<string>();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (
          entry.message.toolName === "worktree_create" ||
          entry.message.toolName === "worktree_switch" ||
          entry.message.toolName === "worktree_cleanup"
        ) {
          const branch = entry.message.details?.branch;
          if (typeof branch === "string" && branch.length > 0) {
            touchedBranches.add(branch);
          }
          const path = entry.message.details?.path;
          if (typeof path === "string" && path.length > 0) {
            touchedPaths.add(path);
            candidatePaths.add(path);
          }
          const mainRepo = entry.message.details?.mainRepo;
          if (typeof mainRepo === "string" && mainRepo.length > 0) {
            candidatePaths.add(mainRepo);
          }
        }
      } else if (entry.type === "custom" && entry.customType === "cwd-change") {
        const cwd = (entry.data as { cwd?: string })?.cwd;
        if (typeof cwd === "string" && cwd.length > 0) {
          touchedPaths.add(cwd);
          candidatePaths.add(cwd);
        }
      }
    }

    if (currentCwd) touchedPaths.add(currentCwd);

    // 3. Resolve main git repositories
    const mainRepos = new Set<string>();
    for (const candidate of candidatePaths) {
      const mainRepo = await detectMainRepoWithExec(deps.exec, candidate);
      if (mainRepo) {
        mainRepos.add(mainRepo);
      }
    }

    if (mainRepos.size === 0) return;

    // 4. For each repository, find existing worktrees that were touched
    const toCleanup: { repo: string; wt: WorktreeInfo }[] = [];

    for (const mainRepo of mainRepos) {
      const listResult = await deps.exec(["worktree", "list", "--porcelain"], mainRepo);
      if (listResult.code !== 0) continue;

      const worktrees = parseWorktreePorcelain(listResult.stdout);
      const matched = worktrees.filter(
        (wt) =>
          wt.path !== mainRepo &&
          (touchedBranches.has(wt.branchName) || touchedPaths.has(wt.path)),
      );

      for (const wt of matched) {
        toCleanup.push({ repo: mainRepo, wt });
      }
    }

    if (toCleanup.length === 0) return;

    // 5. Confirm deletion with user
    const names = toCleanup.map((item) => item.wt.branchName).join(", ");
    const confirmed = await ctx.ui.confirm(
      "Worktree Cleanup",
      `このセッションで使用した以下の worktree が残っています。削除しますか？\n${names}`,
    );

    if (confirmed) {
      for (const item of toCleanup) {
        try {
          await cleanupWorktree(deps, { branch: item.wt.branchName }, { cwd: item.repo });
          ctx.ui.notify(`Deleted worktree '${item.wt.branchName}'`, "info");
        } catch (err) {
          ctx.ui.notify(
            `Failed to cleanup worktree '${item.wt.branchName}': ${(err as Error).message}`,
            "warning",
          );
        }
      }
    }
  });
}
