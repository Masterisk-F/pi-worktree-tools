import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";
import { validateBranchName } from "./validation.js";
import {
  parseWorktreePorcelain,
  findWorktreeByBranch,
  detectMainRepoWithExec,
  detectDefaultBranchWithExec,
  detectGitDirWithExec,
  hasUncommittedChangesWithExec,
} from "./git.js";
import { resolveWorktreeBaseDir, flatBranchDirName } from "./paths.js";

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
// Tool Operations
// ============================================================================

/**
 * Commit a worktree change: update CWD, session entries, and both footers.
 * The 5 call sites in this file previously repeated this sequence verbatim.
 */
function commitWorktreeChange(
  deps: OpsDeps,
  ctx: unknown,
  args: { mainRepo: string; cwd: string; branch: string; defaultBranch: string },
): void {
  deps.setEffectiveCwd(args.cwd);
  deps.appendEntry("cwd-change", { cwd: args.cwd });
  deps.appendEntry("worktree-change", {
    mainRepoPath: args.mainRepo,
    currentWorktreePath: args.cwd,
    currentBranch: args.branch,
    defaultBranch: args.defaultBranch,
  });
  deps.updateFooterStatus(ctx, args.cwd, args.mainRepo);
  deps.updateWorktreeStatus?.(ctx, args.branch, args.cwd, args.mainRepo, args.defaultBranch);
}

/**
 * listWorktrees — list all existing worktrees
 */
export async function listWorktrees(
  deps: OpsDeps,
  _params: Record<string, never>,
  ctx: { cwd: string; [key: string]: unknown },
): Promise<WorktreeToolResult> {
  const activeCwd = deps.getEffectiveCwd?.() || ctx.cwd;
  const mainRepo = await detectMainRepoWithExec(deps.exec, activeCwd);
  if (!mainRepo) {
    throw new Error("Not inside a git repository");
  }

  const listResult = await deps.exec(["worktree", "list", "--porcelain"], mainRepo);
  if (listResult.code !== 0) {
    throw new Error(`Failed to list worktrees: ${listResult.stderr.trim()}`);
  }
  const worktrees = parseWorktreePorcelain(listResult.stdout);
  const defaultBranch = await detectDefaultBranchWithExec(deps.exec, mainRepo);

  const lines = worktrees.map((wt) => {
    const isMain = wt.path === mainRepo;
    const marker = isMain ? " (main repo)" : "";
    const prunableMarker = wt.prunable ? " [prunable: metadata broken or checkout missing]" : "";
    return `- **${wt.branchName}**${marker}: \`${wt.path}\` [${wt.head.slice(0, 7)}]${prunableMarker}`;
  });

  return {
    content: `Found ${worktrees.length} worktree(s):\n${lines.join("\n")}`,
    details: {
      mainRepo,
      defaultBranch,
      worktrees,
    },
  };
}

/**
 * Helper: check if a worktree path is missing or broken on disk.
 */
function isWorktreeMissing(
  path: string,
  statFn: (p: string) => { isDirectory: () => boolean },
): boolean {
  try {
    const st = statFn(path);
    return !st.isDirectory();
  } catch {
    return true;
  }
}

/**
 * createWorktree — create a new worktree (or switch to it if it already exists)
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

  const activeCwd = deps.getEffectiveCwd?.() || ctx.cwd;
  const mainRepo = await detectMainRepoWithExec(deps.exec, activeCwd);
  if (!mainRepo) {
    throw new Error("Not inside a git repository");
  }

  const defaultBranch = await detectDefaultBranchWithExec(deps.exec, mainRepo);

  // If target is default branch, switch to main
  if (branchName === defaultBranch) {
    return switchWorktree(deps, { branch: defaultBranch }, ctx);
  }

  const checkStat = deps.statSync ?? statSync;

  // Check if worktree already exists in git worktree list
  const listResult = await deps.exec(["worktree", "list", "--porcelain"], mainRepo);
  if (listResult.code === 0) {
    const existingWorktrees = parseWorktreePorcelain(listResult.stdout);
    const existingWt = findWorktreeByBranch(existingWorktrees, branchName);

    if (existingWt) {
      const isDamaged =
        existingWt.prunable ||
        isWorktreeMissing(existingWt.path, checkStat);

      if (!isDamaged) {
        // Worktree already exists and is healthy -> switch directly
        commitWorktreeChange(deps, ctx, {
          mainRepo,
          cwd: existingWt.path,
          branch: branchName,
          defaultBranch,
        });

        return {
          content: `Worktree for '${branchName}' already exists at ${existingWt.path}. Switched working directory to it.`,
          details: {
            branch: branchName,
            path: existingWt.path,
            mainRepo,
          },
        };
      }

      // Existing entry is damaged (e.g. wiped by git gc or directory deleted).
      // Prune the dead metadata so git allows re-creating it cleanly.
      await deps.exec(["worktree", "prune"], mainRepo);
    }
  }

  // Resolve safe base directory outside of .git
  const gitDir = await detectGitDirWithExec(deps.exec, mainRepo);
  const baseDir = resolveWorktreeBaseDir(mainRepo, gitDir);
  const baseName = flatBranchDirName(branchName);
  // Another branch may already own `<baseDir>/<flat name>` (e.g. `feature-login`
  // vs `feature/login`). Probe for the first free suffix rather than guessing
  // from the worktree list, which only knows about live worktrees (I2).
  let worktreePath = join(baseDir, baseName);
  for (let n = 2; !isWorktreeMissing(worktreePath, checkStat); n++) {
    worktreePath = join(baseDir, `${baseName}-${n}`);
  }

  // Check if branch already exists in git
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

  // Update CWD & footers
  commitWorktreeChange(deps, ctx, {
    mainRepo,
    cwd: worktreePath,
    branch: branchName,
    defaultBranch,
  });

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
 * switchWorktree — switch to an existing worktree (or create it if it doesn't exist)
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

  const validationError = validateBranchName(target);
  if (validationError) {
    throw new Error(`Invalid branch name: ${validationError}`);
  }

  const activeCwd = deps.getEffectiveCwd?.() || ctx.cwd;
  const mainRepo = await detectMainRepoWithExec(deps.exec, activeCwd);
  if (!mainRepo) {
    throw new Error("Not inside a git repository");
  }

  const defaultBranch = await detectDefaultBranchWithExec(deps.exec, mainRepo);

  if (target === defaultBranch) {
    commitWorktreeChange(deps, ctx, {
      mainRepo,
      cwd: mainRepo,
      branch: defaultBranch,
      defaultBranch,
    });
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
  const checkStat = deps.statSync ?? statSync;

  const isDamaged =
    !wt ||
    wt.prunable ||
    isWorktreeMissing(wt.path, checkStat);

  if (isDamaged) {
    // If damaged or not present, clean any stale metadata and auto-create
    if (wt) {
      await deps.exec(["worktree", "prune"], mainRepo);
    }
    return createWorktree(deps, { branch: target }, ctx);
  }

  commitWorktreeChange(deps, ctx, {
    mainRepo,
    cwd: wt.path,
    branch: target,
    defaultBranch,
  });

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
  params: { branch: string; repo: string },
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

  if (!params.repo || !params.repo.trim()) {
    throw new Error("Repository path cannot be empty");
  }

  const mainRepo = await detectMainRepoWithExec(deps.exec, params.repo.trim());
  if (!mainRepo) {
    throw new Error(`Not inside a git repository: ${params.repo}`);
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

  const checkStat = deps.statSync ?? statSync;
  const missing = isWorktreeMissing(wt.path, checkStat);

  if (!missing) {
    // Check for uncommitted changes only if directory actually exists
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
  }

  // Prune any stale administrative entries (handles missing directory cases cleanly)
  await deps.exec(["worktree", "prune"], mainRepo);

  // Optionally delete branch if merged
  const branchResult = await deps.exec(["branch", "-d", target], mainRepo);
  const branchDeleted = branchResult.code === 0;

  // Removing one worktree must not teleport a session working in a *different*
  // worktree back to the repository root (I1). Only move when we removed the
  // active one (or when there is no effective CWD, legacy/unmocked callers).
  const currentCwd = deps.getEffectiveCwd?.();
  if (!currentCwd || currentCwd === wt.path) {
    commitWorktreeChange(deps, ctx, {
      mainRepo,
      cwd: mainRepo,
      branch: defaultBranch,
      defaultBranch,
    });
  }

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
