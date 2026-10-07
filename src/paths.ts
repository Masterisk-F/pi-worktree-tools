import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Base directory resolution
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_DIR = ".worktrees/";

/**
 * Expand leading ~ to $HOME.
 */
export function expandTilde(input: string): string {
  if (input.startsWith("~")) {
    const home = process.env.HOME || homedir();
    if (home) {
      return home + input.slice(1);
    }
  }
  return input;
}

/**
 * Determine if candidate is equal to or a sub-path of parent.
 */
export function isInside(candidate: string, parent: string): boolean {
  const normCandidate = resolve(candidate);
  const normParent = resolve(parent);
  return (
    normCandidate === normParent ||
    normCandidate.startsWith(normParent.endsWith(sep) ? normParent : normParent + sep)
  );
}

/**
 * Resolve the directory where worktrees should be created.
 *
 * Checks `worktrees.baseDir` in ~/.pi/agent/settings.json, falling back to
 * `.worktrees/` relative to the main repository root.
 *
 * CRITICAL SAFETY GUARD: If the resolved base directory points inside the git
 * directory (e.g. the legacy default `.git/worktrees/`), it is overridden with
 * `.worktrees/` at the repo root to prevent git gc from deleting worktree checkouts.
 */
export function resolveWorktreeBaseDir(
  mainRepo: string,
  gitDir: string,
  settingsPath = join(homedir(), ".pi", "agent", "settings.json"),
): string {
  let configured = DEFAULT_BASE_DIR;

  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const wt = settings.worktrees as Record<string, unknown> | undefined;
    if (wt && typeof wt.baseDir === "string" && wt.baseDir.length > 0) {
      configured = wt.baseDir;
    }
  } catch {
    // Missing file, invalid JSON, or missing setting — use default
  }

  const expanded = expandTilde(configured);
  const resolved = resolve(mainRepo, expanded);

  // If inside the git dir (e.g. legacy default ./.git/worktrees/), override
  const safeDir = isInside(resolved, gitDir)
    ? resolve(mainRepo, DEFAULT_BASE_DIR)
    : resolved;

  return safeDir.endsWith("/") ? safeDir : safeDir + "/";
}

/**
 * Convert a branch name with slashes to a flat directory name to avoid nested
 * parent directories that leave empty residues upon removal.
 * E.g., `feature/login` -> `feature-login`
 *
 * Collision handling lives at the call site (ops.ts probes for a free suffix);
 * this stays a pure mapping.
 */
export function flatBranchDirName(branch: string): string {
  return branch.split("/").join("-");
}

/**
 * Safely quote a string for bash using single quotes.
 * Single quotes prevent shell expansion ($, backticks, spaces, etc.).
 * Embedded single quotes are handled via: end-quote + escaped-quote + reopen-quote.
 */
export function bashSingleQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
