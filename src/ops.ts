import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";
import { validateBranchName } from "./validation.js";
import {
  parseWorktreePorcelain,
  findWorktreeByBranch,
  getMainWorktree,
  detectMainRepoWithExec,
  detectDefaultBranchWithExec,
  detectGitDirWithExec,
  hasUncommittedChangesWithExec,
  type WorktreeInfo,
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

// Re-export git helpers so callers (index.ts / tests) don't need a separate import
export {
  detectMainRepoWithExec,
  detectDefaultBranchWithExec,
  hasUncommittedChangesWithExec,
};

// ============================================================================
// Pure Helpers
// ============================================================================

/**
 * Return the directory the session should move to after removing `removedPath`,
 * or null to keep the current effective CWD untouched.
 *
 * Removing one worktree must not silently teleport a session working in a
 * *different* worktree back to the repository root (I1).
 * When `effectiveCwd` is undefined/empty (legacy / unmocked tests), falls back
 * to the main repo for backward compatibility.
 */
export function resolveEffectiveCwdForRemoval(
  mainRepo: string,
  removedPath: string,
  effectiveCwd: string | undefined,
  defaultBranch: string,
): { cwd: string; branch: string } | null {
  if (!effectiveCwd) {
    return { cwd: mainRepo, branch: defaultBranch };
  }
  if (effectiveCwd === removedPath) {
    return { cwd: mainRepo, branch: defaultBranch };
  }
  // Session is working elsewhere (another worktree or the main repo) -> leave CWD untouched
  return null;
}

// ============================================================================
// Tool Operations
// ============================================================================

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
  if (branchName === defaultBranch || branchName === "main" || branchName === "master") {
    return switchWorktree(deps, { branch: defaultBranch }, ctx);
  }

  const checkStat = deps.statSync ?? statSync;

  // Check if worktree already exists in git worktree list
  let existingWorktrees: WorktreeInfo[] = [];
  const listResult = await deps.exec(["worktree", "list", "--porcelain"], mainRepo);
  if (listResult.code === 0) {
    existingWorktrees = parseWorktreePorcelain(listResult.stdout);
    const existingWt = findWorktreeByBranch(existingWorktrees, branchName);

    if (existingWt) {
      const isDamaged =
        existingWt.prunable ||
        isWorktreeMissing(existingWt.path, checkStat);

      if (!isDamaged) {
        // Worktree already exists and is healthy -> switch directly
        deps.setEffectiveCwd(existingWt.path);
        deps.appendEntry("cwd-change", { cwd: existingWt.path });
        deps.appendEntry("worktree-change", {
          mainRepoPath: mainRepo,
          currentWorktreePath: existingWt.path,
          currentBranch: branchName,
          defaultBranch,
        });
        deps.updateFooterStatus(ctx, existingWt.path, mainRepo);
        deps.updateWorktreeStatus?.(ctx, branchName, existingWt.path, mainRepo, defaultBranch);

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
  // Disambiguate path if another branch's worktree already occupies the base flat name (I2)
  const flatDirName = flatBranchDirName(branchName, (name) =>
    existingWorktrees.some(
      (w) => !w.prunable && w.branchName !== branchName && w.path === join(baseDir, name),
    ),
  );
  const worktreePath = join(baseDir, flatDirName);

  try {
    checkStat(worktreePath);
    throw new Error(`Directory already exists: ${worktreePath}`);
  } catch (err: unknown) {
    if ((err as Error).message.startsWith("Directory already exists")) {
      throw err;
    }
    // ENOENT — directory does not exist, which is expected
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

  const activeCwd = deps.getEffectiveCwd?.() || ctx.cwd;
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

  // Switch CWD back to main repo only if the removed worktree was the active one (I1)
  const next = resolveEffectiveCwdForRemoval(
    mainRepo,
    wt.path,
    deps.getEffectiveCwd?.(),
    defaultBranch,
  );

  if (next) {
    deps.setEffectiveCwd(next.cwd);
    deps.appendEntry("cwd-change", { cwd: next.cwd });
    deps.appendEntry("worktree-change", {
      mainRepoPath: mainRepo,
      currentWorktreePath: next.cwd,
      currentBranch: next.branch,
      defaultBranch,
    });
    deps.updateFooterStatus(ctx, next.cwd, mainRepo);
    deps.updateWorktreeStatus?.(ctx, next.branch, next.cwd, mainRepo, defaultBranch);
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
