import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed entry from `git worktree list --porcelain` */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** Current HEAD commit hash */
  head: string;
  /** Branch ref (e.g. "refs/heads/feature") or "detached" */
  branch: string;
  /** Human-readable branch name extracted from refs/heads/<name>, or "detached" */
  branchName: string;
  /** Whether git considers this worktree prunable (e.g. checkout missing or damaged) */
  prunable?: boolean;
}

// ---------------------------------------------------------------------------
// Pure Parsers
// ---------------------------------------------------------------------------

/**
 * Extract paths of worktrees marked as `prunable` in porcelain output.
 * Git emits `prunable <reason>` or plain `prunable` on its own line within
 * the worktree stanza when the worktree's administrative metadata is stale
 * or points to a non-existent checkout.
 */
export function getPrunablePaths(porcelain: string): Set<string> {
  const prunablePaths = new Set<string>();
  const blocks = porcelain.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    let worktreePath = "";
    let isPrunable = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length).trim();
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        isPrunable = true;
      }
    }

    if (worktreePath && isPrunable) {
      prunablePaths.add(worktreePath);
    }
  }

  return prunablePaths;
}

/**
 * Pure parser for `git worktree list --porcelain`.
 */
export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const blocks = trimmed.split(/\n\n+/);
  const result: WorktreeInfo[] = [];

  for (const block of blocks) {
    const blockTrimmed = block.trim();
    if (!blockTrimmed) continue;

    let worktreePath = "";
    let head = "";
    let branch = "";
    let isDetached = false;
    let isPrunable = false;

    for (const line of blockTrimmed.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).trim();
      } else if (line === "detached") {
        isDetached = true;
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        isPrunable = true;
      }
    }

    if (!worktreePath) continue;

    let branchName: string;
    if (isDetached || !branch) {
      branchName = "detached";
      branch = branch || "detached";
    } else if (branch.startsWith("refs/heads/")) {
      branchName = branch.slice("refs/heads/".length);
    } else {
      branchName = branch;
    }

    result.push({
      path: worktreePath,
      head,
      branch,
      branchName,
      ...(isPrunable ? { prunable: true } : {}),
    });
  }

  return result;
}

export function findWorktreeByBranch(
  worktrees: WorktreeInfo[],
  branchName: string,
): WorktreeInfo | undefined {
  return worktrees.find((wt) => wt.branchName === branchName);
}

export function getMainWorktree(worktrees: WorktreeInfo[]): WorktreeInfo | undefined {
  return worktrees[0];
}

// ---------------------------------------------------------------------------
// Git Detection Helpers (Injectable Exec)
// ---------------------------------------------------------------------------

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

/**
 * Detect the common git directory for the repository (e.g. `<mainRepo>/.git`).
 * Uses `git rev-parse --git-common-dir` which works in both main checkouts
 * and linked worktrees. Resolves to an absolute path against `cwd`.
 */
export async function detectGitDirWithExec(
  exec: (args: string[], cwd?: string) => Promise<ExecResult>,
  cwd: string,
): Promise<string> {
  const result = await exec(["rev-parse", "--git-common-dir"], cwd);
  if (result.code === 0 && result.stdout.trim()) {
    return resolve(cwd, result.stdout.trim());
  }
  // Fallback to standard `<cwd>/.git`
  return resolve(cwd, ".git");
}

export async function hasUncommittedChangesWithExec(
  exec: (args: string[], cwd?: string) => Promise<ExecResult>,
  worktreePath: string,
): Promise<boolean> {
  const result = await exec(["status", "--porcelain"], worktreePath);
  return result.stdout.trim().length > 0;
}
