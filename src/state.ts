import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { escapeRegex } from "./paths.js";

// ============================================================================
// Constants
// ============================================================================

export const CWD_CHANGE_TYPE = "cwd-change" as const;
export const WORKTREE_CHANGE_TYPE = "worktree-change" as const;
export const CWD_STATUS_KEY = "cwd" as const;
export const WORKTREE_STATUS_KEY = "worktree" as const;

export interface WorktreeChangeData {
  mainRepoPath: string;
  currentWorktreePath: string;
  currentBranch: string;
  defaultBranch?: string;
}

// ============================================================================
// Module State (Local to this extension instance)
// ============================================================================

/** Original working directory when the session starts. Updated on session_start. */
let originalCwd: string = process.cwd();

/** Currently active effective working directory. */
let effectiveCwd: string = originalCwd;

/** Absolute path to main git repo root. */
let mainRepoPath: string = "";

/** Absolute path to current worktree (same as mainRepoPath on main). */
let currentWorktreePath: string = "";

/** Currently active branch name. */
let currentBranch: string = "main";

/** Detected default branch name (e.g. "main" or "master"). */
let defaultBranch: string = "main";

// ============================================================================
// Getters and Setters
// ============================================================================

export function getOriginalCwd(): string {
  return originalCwd;
}

export function initOriginalCwd(cwd: string): void {
  originalCwd = cwd;
  // If effectiveCwd was still at default, align it
  if (effectiveCwd === process.cwd()) {
    effectiveCwd = cwd;
  }
}

export function getEffectiveCwd(): string {
  return effectiveCwd;
}

export function setEffectiveCwd(cwd: string): void {
  effectiveCwd = cwd;
}

export function getMainRepoPath(): string {
  return mainRepoPath;
}

export function setMainRepoPath(path: string): void {
  mainRepoPath = path;
}

export function getCurrentWorktreePath(): string {
  return currentWorktreePath;
}

export function setCurrentWorktreePath(path: string): void {
  currentWorktreePath = path;
}

export function getCurrentBranch(): string {
  return currentBranch;
}

export function setCurrentBranch(branch: string): void {
  currentBranch = branch;
}

export function getDefaultBranch(): string {
  return defaultBranch;
}

export function setDefaultBranch(branch: string): void {
  defaultBranch = branch;
}

export function resetWorktreeState(): void {
  mainRepoPath = "";
  currentWorktreePath = "";
  currentBranch = "main";
  defaultBranch = "main";
}

// ============================================================================
// Footer Status
// ============================================================================

/**
 * Update the cwd indicator in the footer.
 * Shows `📂 <path>` when effectiveCwd differs from originalCwd; clears when same.
 */
export function updateCwdFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (effectiveCwd === originalCwd) {
    ctx.ui.setStatus(CWD_STATUS_KEY, undefined);
    return;
  }

  const home = process.env.HOME || homedir();
  const displayPath = home
    ? effectiveCwd.replace(new RegExp(`^${escapeRegex(home)}`), "~")
    : effectiveCwd;

  ctx.ui.setStatus(CWD_STATUS_KEY, ctx.ui.theme.fg("accent", `📂 ${displayPath}`));
}

/**
 * Update the worktree indicator in the footer.
 * Shows `🌳 <branch>` when on a non-default worktree; clears when on main.
 */
export function updateWorktreeFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const isMain =
    (currentBranch === defaultBranch || currentBranch === "main" || currentBranch === "master") &&
    (currentWorktreePath === mainRepoPath || !currentWorktreePath);

  if (isMain) {
    ctx.ui.setStatus(WORKTREE_STATUS_KEY, undefined);
  } else {
    ctx.ui.setStatus(
      WORKTREE_STATUS_KEY,
      ctx.ui.theme.fg("accent", `🌳 ${currentBranch}`),
    );
  }
}

// ============================================================================
// Session Restoration (Backward-Compatible with legacy session entries)
// ============================================================================

/**
 * Scan session branch for legacy and new `cwd-change` and `worktree-change` entries.
 * Restores working directory and worktree state, verifying paths still exist on disk.
 */
export function restoreFromBranch(ctx: ExtensionContext): void {
  let entries: SessionEntry[];
  try {
    entries = ctx.sessionManager.getBranch();
  } catch {
    return;
  }

  // 1. Restore CWD from last valid `cwd-change` entry
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry &&
      entry.type === "custom" &&
      entry.customType === CWD_CHANGE_TYPE &&
      entry.data &&
      typeof (entry.data as { cwd?: unknown }).cwd === "string"
    ) {
      const candidate = (entry.data as { cwd: string }).cwd;
      try {
        const stat = statSync(candidate);
        if (stat.isDirectory()) {
          effectiveCwd = candidate;
          break;
        }
      } catch {
        // Path deleted or inaccessible — keep looking backwards
      }
    }
  }

  // 2. Restore worktree state from last valid `worktree-change` entry
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry &&
      entry.type === "custom" &&
      entry.customType === WORKTREE_CHANGE_TYPE &&
      entry.data &&
      isValidWorktreeData(entry.data)
    ) {
      const data = entry.data;

      try {
        const stat = statSync(data.mainRepoPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      mainRepoPath = data.mainRepoPath;
      if (data.defaultBranch) defaultBranch = data.defaultBranch;

      if (data.currentWorktreePath && existsSync(data.currentWorktreePath)) {
        currentWorktreePath = data.currentWorktreePath;
        currentBranch = data.currentBranch;
      } else {
        currentWorktreePath = data.mainRepoPath;
        currentBranch = defaultBranch;
      }
      break;
    }
  }
}

function isValidWorktreeData(data: unknown): data is WorktreeChangeData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.mainRepoPath === "string" &&
    typeof d.currentWorktreePath === "string" &&
    typeof d.currentBranch === "string"
  );
}
