import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";
import { validateBranchName } from "@harms-haus/pi-worktrees/src/validation.js";
import { parseWorktreePorcelain, findWorktreeByBranch, getMainWorktree } from "@harms-haus/pi-worktrees/src/git.js";
import { resolveBaseDir } from "@harms-haus/pi-worktrees/src/worktree.js";

// ============================================================================
// Types
// ============================================================================

export interface OpsDeps {
  exec: (args: string[], cwd?: string) => Promise<ExecResult>;
  setEffectiveCwd: (cwd: string) => void;
  appendEntry: (type: string, data: unknown) => void;
  updateFooterStatus: (ctx: unknown, cwd: string, original: string) => void;
  updateWorktreeStatus?: (
    ctx: unknown,
    branch: string,
    worktreePath: string,
    mainRepo: string,
    defaultBranch: string,
  ) => void;
  statSync?: (path: string) => { isDirectory: () => boolean };
  getEffectiveCwd?: () => string;
}

export interface WorktreeToolResult {
  content: string;
  details: Record<string, unknown>;
}

// ============================================================================
// Helpers
// ============================================================================

export async function detectMainRepoWithExec(
  exec: (args: string[], cwd?: string) => Promise<ExecResult>,
  cwd: string,
): Promise<string | null> {
  const result = await exec(["worktree", "list", "--porcelain"], cwd);
  if (result.code !== 0) return null;
  const worktrees = parseWorktreePorcelain(result.stdout);
  const main = getMainWorktree(worktrees);
  return main?.path ?? null;
}

export async function detectDefaultBranchWithExec(
  exec: (args: string[], cwd?: string) => Promise<ExecResult>,
  cwd: string,
): Promise<string> {
  const symRefResult = await exec(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (symRefResult.code === 0) {
    const match = symRefResult.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (match && match[1]) return match[1];
  }
  const result = await exec(["worktree", "list", "--porcelain"], cwd);
  if (result.code === 0) {
    const worktrees = parseWorktreePorcelain(result.stdout);
    const mainWt = getMainWorktree(worktrees);
    if (mainWt && mainWt.branchName !== "detached") {
      return mainWt.branchName;
    }
  }
  return "main";
}

export async function hasUncommittedChangesWithExec(
  exec: (args: string[], cwd?: string) => Promise<ExecResult>,
  worktreePath: string,
): Promise<boolean> {
  const result = await exec(["status", "--porcelain"], worktreePath);
  return result.stdout.trim().length > 0;
}

// ============================================================================
// Tool Operations
// ============================================================================

/**
 * createWorktree — create a new worktree from default branch and switch CWD
 */
export async function createWorktree(
  deps: OpsDeps,
  params: { branch: string },
  ctx: { cwd: string; [key: string]: unknown },
): Promise<WorktreeToolResult> {
  const branchName = params.branch.trim();
  const validationError = validateBranchName(branchName);
  if (validationError) {
    throw new Error(`Invalid branch name: ${validationError}`);
  }

  const activeCwd = (deps.getEffectiveCwd?.() || ctx.cwd);
  const mainRepo = await detectMainRepoWithExec(deps.exec, activeCwd);
  if (!mainRepo) {
    throw new Error("Not inside a git repository");
  }

  const baseDir = resolveBaseDir(mainRepo);
  const worktreePath = join(baseDir, branchName);

  const checkStat = deps.statSync ?? statSync;
  try {
    checkStat(worktreePath);
    throw new Error(`Directory already exists: ${worktreePath}`);
  } catch (err: unknown) {
    if ((err as Error).message.startsWith("Directory already exists")) {
      throw err;
    }
    // ENOENT — directory does not exist, which is expected
  }

  // Check if branch already exists
  const branchCheck = await deps.exec(["rev-parse", "--verify", branchName], mainRepo);

  let addResult: ExecResult;
  if (branchCheck.code === 0) {
    addResult = await deps.exec(["worktree", "add", worktreePath, branchName], mainRepo);
  } else {
    addResult = await deps.exec(["worktree", "add", "-b", branchName, worktreePath], mainRepo);
  }

  if (addResult.code !== 0) {
    throw new Error(`Failed to create worktree: ${addResult.stderr.trim()}`);
  }

  const defaultBranch = await detectDefaultBranchWithExec(deps.exec, mainRepo);

  // Update CWD & footers
  deps.setEffectiveCwd(worktreePath);
  deps.appendEntry("cwd-change", { cwd: worktreePath });
  deps.appendEntry("worktree-change", {
    mainRepoPath: mainRepo,
    currentWorktreePath: worktreePath,
    currentBranch: branchName,
    defaultBranch,
  });
  deps.updateFooterStatus(ctx, worktreePath, mainRepo);
  deps.updateWorktreeStatus?.(ctx, branchName, worktreePath, mainRepo, defaultBranch);

  return {
    content: `Created worktree for '${branchName}' at ${worktreePath} and switched working directory.`,
    details: {
      branch: branchName,
      path: worktreePath,
      mainRepo,
    },
  };
}

/**
 * switchWorktree — switch to an existing worktree or back to the default branch
 */
export async function switchWorktree(
  deps: OpsDeps,
  params: { branch: string },
  ctx: { cwd: string; [key: string]: unknown },
): Promise<WorktreeToolResult> {
  const target = params.branch.trim();
  if (!target) {
    throw new Error("Branch name cannot be empty");
  }

  const activeCwd = (deps.getEffectiveCwd?.() || ctx.cwd);
  const mainRepo = await detectMainRepoWithExec(deps.exec, activeCwd);
  if (!mainRepo) {
    throw new Error("Not inside a git repository");
  }

  const defaultBranch = await detectDefaultBranchWithExec(deps.exec, mainRepo);

  if (target === defaultBranch || target === "main" || target === "master") {
    deps.setEffectiveCwd(mainRepo);
    deps.appendEntry("cwd-change", { cwd: mainRepo });
    deps.appendEntry("worktree-change", {
      mainRepoPath: mainRepo,
      currentWorktreePath: mainRepo,
      currentBranch: defaultBranch,
      defaultBranch,
    });
    deps.updateFooterStatus(ctx, mainRepo, mainRepo);
    deps.updateWorktreeStatus?.(ctx, defaultBranch, mainRepo, mainRepo, defaultBranch);
    return {
      content: `Switched to default branch (${defaultBranch}) at ${mainRepo}.`,
      details: {
        branch: defaultBranch,
        path: mainRepo,
        mainRepo,
      },
    };
  }

  const listResult = await deps.exec(["worktree", "list", "--porcelain"], mainRepo);
  if (listResult.code !== 0) {
    throw new Error(`Failed to list worktrees: ${listResult.stderr.trim()}`);
  }
  const worktrees = parseWorktreePorcelain(listResult.stdout);
  const wt = findWorktreeByBranch(worktrees, target);
  if (!wt) {
    throw new Error(`No worktree found for branch '${target}'. Use worktree_create first.`);
  }

  deps.setEffectiveCwd(wt.path);
  deps.appendEntry("cwd-change", { cwd: wt.path });
  deps.appendEntry("worktree-change", {
    mainRepoPath: mainRepo,
    currentWorktreePath: wt.path,
    currentBranch: target,
    defaultBranch,
  });
  deps.updateFooterStatus(ctx, wt.path, mainRepo);
  deps.updateWorktreeStatus?.(ctx, target, wt.path, mainRepo, defaultBranch);

  return {
    content: `Switched to worktree '${target}' at ${wt.path}.`,
    details: {
      branch: target,
      path: wt.path,
      mainRepo,
    },
  };
}

/**
 * cleanupWorktree — remove a worktree and delete its branch if merged
 */
export async function cleanupWorktree(
  deps: OpsDeps,
  params: { branch: string },
  ctx: { cwd: string; [key: string]: unknown },
): Promise<WorktreeToolResult> {
  const target = params.branch.trim();
  if (!target) {
    throw new Error("Branch name cannot be empty");
  }

  const validationError = validateBranchName(target);
  if (validationError) {
    throw new Error(`Invalid branch name: ${validationError}`);
  }

  const activeCwd = (deps.getEffectiveCwd?.() || ctx.cwd);
  const mainRepo = await detectMainRepoWithExec(deps.exec, activeCwd);
  if (!mainRepo) {
    throw new Error("Not inside a git repository");
  }

  const defaultBranch = await detectDefaultBranchWithExec(deps.exec, mainRepo);
  if (target === defaultBranch) {
    throw new Error(`Cannot remove the default branch (${defaultBranch}) worktree`);
  }

  const listResult = await deps.exec(["worktree", "list", "--porcelain"], mainRepo);
  if (listResult.code !== 0) {
    throw new Error(`Failed to list worktrees: ${listResult.stderr.trim()}`);
  }
  const worktrees = parseWorktreePorcelain(listResult.stdout);
  const wt = findWorktreeByBranch(worktrees, target);
  if (!wt) {
    throw new Error(`No worktree found for branch '${target}'`);
  }

  // Check for uncommitted changes
  const dirty = await hasUncommittedChangesWithExec(deps.exec, wt.path);
  if (dirty) {
    throw new Error(
      `Worktree '${target}' has uncommitted changes. Commit or stash your changes before cleaning up.`,
    );
  }

  // Remove worktree
  let removeResult = await deps.exec(["worktree", "remove", "-f", wt.path], mainRepo);
  if (removeResult.code !== 0) {
    removeResult = await deps.exec(["worktree", "remove", "-f", "-f", wt.path], mainRepo);
    if (removeResult.code !== 0) {
      throw new Error(`Failed to remove worktree: ${removeResult.stderr.trim()}`);
    }
  }

  await deps.exec(["worktree", "prune"], mainRepo);

  // Optionally delete branch if merged
  const branchResult = await deps.exec(["branch", "-d", target], mainRepo);
  const branchDeleted = branchResult.code === 0;

  // Switch back to main repo
  deps.setEffectiveCwd(mainRepo);
  deps.appendEntry("cwd-change", { cwd: mainRepo });
  deps.appendEntry("worktree-change", {
    mainRepoPath: mainRepo,
    currentWorktreePath: mainRepo,
    currentBranch: defaultBranch,
    defaultBranch,
  });
  deps.updateFooterStatus(ctx, mainRepo, mainRepo);
  deps.updateWorktreeStatus?.(ctx, defaultBranch, mainRepo, mainRepo, defaultBranch);

  return {
    content: `Cleaned up worktree '${target}'.${branchDeleted ? ` Branch '${target}' deleted.` : ` Branch '${target}' was not merged and was kept.`}`,
    details: {
      branch: target,
      path: wt.path,
      branchDeleted,
      mainRepo,
    },
  };
}
