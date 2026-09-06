import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { setEffectiveCwd, getEffectiveCwd, updateFooterStatus as updateCwdFooter } from "@harms-haus/pi-cwd/src/state.js";
import {
  setMainRepoPath,
  setDefaultBranch,
  setCurrentBranch,
  setCurrentWorktreePath,
  updateFooterStatus as updateWorktreeFooter,
} from "@harms-haus/pi-worktrees/src/state.js";
import { parseWorktreePorcelain } from "@harms-haus/pi-worktrees/src/git.js";
import type { WorktreeInfo } from "@harms-haus/pi-worktrees/src/types.js";
import {
  listWorktrees,
  createWorktree,
  switchWorktree,
  cleanupWorktree,
  detectMainRepoWithExec,
  type OpsDeps,
} from "./ops.js";

export default function (pi: ExtensionAPI): void {
  const getCwd = () => getEffectiveCwd() || process.cwd();

  // TUI is already torn down when session_shutdown fires, so ctx.ui.confirm()
  // cannot render. Use readline on stdin/stdout instead.
  function confirmOnExit(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(/^[yY]/.test(answer.trim()));
      });
    });
  }

  const updateWorktreeStatus = (
    ctx: unknown,
    branch: string,
    worktreePath: string,
    mainRepo: string,
    defaultBranch: string,
  ) => {
    setMainRepoPath(mainRepo);
    setDefaultBranch(defaultBranch);
    setCurrentBranch(branch);
    setCurrentWorktreePath(worktreePath);
    updateWorktreeFooter(ctx as any);
  };

  const deps: OpsDeps = {
    exec: (args, cwd) => pi.exec("git", args, { cwd: cwd || getCwd() }),
    setEffectiveCwd,
    appendEntry: (type, data) => pi.appendEntry(type, data),
    updateFooterStatus: (ctx, cwd, original) => updateCwdFooter(ctx as any, cwd, original),
    updateWorktreeStatus,
    getEffectiveCwd,
  };

  // ── worktree_list ───────────────────────────────────────────────────
  pi.registerTool({
    name: "worktree_list",
    label: "Worktree List",
    description:
      "List all existing git worktrees in the repository. ALWAYS use this tool instead of running `git worktree list` in bash.",
    promptSnippet: "List git worktrees (prefer over `git worktree list` bash command)",
    promptGuidelines: [
      "ALWAYS use worktree_list to check existing worktrees. NEVER run `git worktree list` in bash.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await listWorktrees(deps, {}, ctx);
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
  });

  // ── worktree_create ─────────────────────────────────────────────────
  pi.registerTool({
    name: "worktree_create",
    label: "Worktree Create",
    description:
      "Create a git worktree for a branch (works for BOTH existing branches and new branches) and switch working directory to it. If the worktree already exists, it switches to it. ALWAYS use this tool instead of running `git worktree add` or `git checkout` in bash.",
    promptSnippet: "Create or switch to a git worktree for a branch (prefer over raw git commands)",
    promptGuidelines: [
      "ALWAYS use worktree_create to open or create a worktree for any branch. NEVER use bash commands like `git worktree add`, `git branch`, or `git checkout`.",
    ],
    parameters: Type.Object({
      branch: Type.String({
        description:
          "Branch name to checkout in a worktree (existing branch or new branch to create, e.g. feature/login or fix/bug)",
      }),
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
      "Switch working directory to an existing worktree, or back to the default branch (main/master). If the worktree does not exist yet, it automatically creates it and switches. ALWAYS use this tool instead of `cd` or `git checkout` in bash.",
    promptSnippet: "Switch between git worktrees or back to main (auto-creates if missing; prefer over cd/checkout)",
    promptGuidelines: [
      "ALWAYS use worktree_switch to move between worktrees or to return to the default branch (main/master). It automatically creates the worktree if it does not exist yet. NEVER use `cd` or `git checkout` in bash.",
    ],
    parameters: Type.Object({
      branch: Type.String({
        description: "Branch name of a worktree, or default branch name (e.g. main/master)",
      }),
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
    if (event.reason !== "quit") return;

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
      } else if (entry.type === "custom" && entry.customType === "worktree-change") {
        const data = entry.data as { currentWorktreePath?: string; currentBranch?: string; mainRepoPath?: string };
        if (data?.currentBranch) touchedBranches.add(data.currentBranch);
        if (data?.currentWorktreePath) {
          touchedPaths.add(data.currentWorktreePath);
          candidatePaths.add(data.currentWorktreePath);
        }
        if (data?.mainRepoPath) candidatePaths.add(data.mainRepoPath);
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

    // 5. Confirm deletion with user (readline-based: works after TUI shutdown)
    const names = toCleanup.map((item) => item.wt.branchName).join(", ");
    const confirmed = await confirmOnExit(
      `\nRemove worktree(s) used in this session (${names})? [y/N] `,
    );

    if (confirmed) {
      for (const item of toCleanup) {
        try {
          await cleanupWorktree(deps, { branch: item.wt.branchName }, { cwd: item.repo });
        } catch (err) {
          // Ignore cleanup failures so process exit is not blocked
        }
      }
    }
  });
}
