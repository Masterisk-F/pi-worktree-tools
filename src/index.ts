import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInterface } from "node:readline/promises";
import { isAbsolute, resolve, join, relative } from "node:path";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";

import {
  getEffectiveCwd,
  setEffectiveCwd,
  getOriginalCwd,
  initOriginalCwd,
  setWorktreeState,
  updateCwdFooter,
  updateWorktreeFooter,
  restoreFromBranch,
  CWD_CHANGE_TYPE,
  WORKTREE_CHANGE_TYPE,
} from "./state.js";
import { bashSingleQuote, resolveWorktreeBaseDir } from "./paths.js";
import {
  parseWorktreePorcelain,
  detectGitDirWithExec,
  detectMainRepoWithExec,
  type WorktreeInfo,
} from "./git.js";
import {
  listWorktrees,
  createWorktree,
  switchWorktree,
  cleanupWorktree,
  type OpsDeps,
} from "./ops.js";

// File tools requiring a target path
const FILE_TOOLS_REQUIRED_PATH = new Set(["read", "write", "edit"]);

// File tools with an optional path argument (default to cwd)
const FILE_TOOLS_OPTIONAL_PATH = new Set(["grep", "find", "ls"]);

// Regex to rewrite cwd in system prompt
const CWD_PROMPT_REGEX = /Current working directory: .+/;

/**
 * Ensure the resolved worktree base directory is registered in `.git/info/exclude`
 * of the main repository (I5).
 * Local-only configuration that never gets committed to tracked `.gitignore`.
 */
export async function ensureWorktreesExcluded(
  exec: (args: string[], cwd?: string) => Promise<{ stdout: string; code: number }>,
  mainRepo: string,
  baseDir?: string,
): Promise<void> {
  try {
    const gitDir = await detectGitDirWithExec(exec as any, mainRepo);
    const excludePath = join(gitDir, "info", "exclude");
    if (!existsSync(excludePath)) return;

    // Resolve baseDir (defaults to settings/default if not provided)
    const resolvedBase = baseDir ?? resolveWorktreeBaseDir(mainRepo, gitDir);

    // Compute repo-relative pattern; if baseDir is outside mainRepo, do not add invalid gitignore rule
    const rel = relative(mainRepo, resolvedBase);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return;
    }

    const pattern = rel.endsWith("/") ? rel : rel + "/";

    const content = readFileSync(excludePath, "utf-8");
    if (!content.split("\n").includes(pattern)) {
      appendFileSync(excludePath, (content.endsWith("\n") ? "" : "\n") + pattern + "\n");
    }
  } catch {
    // Non-critical; ignore failures
  }
}

export default function (pi: ExtensionAPI): void {
  const getCwd = () => getEffectiveCwd();

  const updateWorktreeStatus = (
    ctx: unknown,
    branch: string,
    worktreePath: string,
    mainRepo: string,
    defaultBranch: string,
  ) => {
    setWorktreeState(mainRepo, worktreePath, branch, defaultBranch);
    updateWorktreeFooter(ctx as any);
  };

  const deps: OpsDeps = {
    exec: (args, cwd) => pi.exec("git", args, { cwd: cwd || getCwd() }),
    setEffectiveCwd: (cwd) => setEffectiveCwd(cwd),
    appendEntry: (type, data) => pi.appendEntry(type, data),
    updateFooterStatus: (ctx, _cwd, _original) => updateCwdFooter(ctx as any),
    updateWorktreeStatus,
    getEffectiveCwd,
  };

  // ── Tool call interception (makes all tools follow effectiveCwd) ─────
  pi.on("tool_call", (event, _ctx) => {
    if (getEffectiveCwd() === getOriginalCwd()) return undefined;

    // A tool call arriving without an input object (e.g. via MCP) would otherwise
    // throw a TypeError here and take the whole session down.
    const input = event.input as Record<string, unknown> | null | undefined;
    if (!input || typeof input !== "object") return undefined;

    if (event.toolName === "bash") {
      if (typeof input.command === "string") {
        input.command = `cd ${bashSingleQuote(getEffectiveCwd())} && ${input.command}`;
      }
    } else if (FILE_TOOLS_REQUIRED_PATH.has(event.toolName)) {
      if (typeof input.path === "string" && !isAbsolute(input.path)) {
        input.path = resolve(getEffectiveCwd(), input.path);
      }
    } else if (FILE_TOOLS_OPTIONAL_PATH.has(event.toolName)) {
      if (input.path === undefined || input.path === "") {
        input.path = getEffectiveCwd();
      } else if (typeof input.path === "string" && !isAbsolute(input.path)) {
        input.path = resolve(getEffectiveCwd(), input.path);
      }
    }

    return undefined;
  });

  // ── System prompt modification ──────────────────────────────────────
  pi.on("before_agent_start", (event, _ctx) => {
    if (getEffectiveCwd() === getOriginalCwd()) return undefined;
    const modified = event.systemPrompt.replace(
      CWD_PROMPT_REGEX,
      `Current working directory: ${getEffectiveCwd()}`,
    );
    return { systemPrompt: modified };
  });

  // ── Session state restoration ───────────────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    initOriginalCwd(ctx.cwd || process.cwd());
    restoreFromBranch(ctx);
    updateCwdFooter(ctx);
    updateWorktreeFooter(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreFromBranch(ctx);
    updateCwdFooter(ctx);
    updateWorktreeFooter(ctx);
  });

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
      const result = await listWorktrees(deps, {}, ctx as any);
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
      const result = await createWorktree(deps, params, ctx as any);
      const mainRepo = result.details.mainRepo as string | undefined;
      if (mainRepo) {
        await ensureWorktreesExcluded(deps.exec, mainRepo);
      }
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
      const result = await switchWorktree(deps, params, ctx as any);
      // switchWorktree may fall through to createWorktree internally, so this
      // wrapper must exclude too or `.worktrees/` reappears in `git status` (B).
      const mainRepo = result.details.mainRepo as string | undefined;
      if (mainRepo) {
        await ensureWorktreesExcluded(deps.exec, mainRepo);
      }
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
      const result = await cleanupWorktree(deps, params, ctx as any);
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
      } else if (entry.type === "custom" && entry.customType === CWD_CHANGE_TYPE) {
        const cwd = (entry.data as { cwd?: string })?.cwd;
        if (typeof cwd === "string" && cwd.length > 0) {
          touchedPaths.add(cwd);
          candidatePaths.add(cwd);
        }
      } else if (entry.type === "custom" && entry.customType === WORKTREE_CHANGE_TYPE) {
        const data = entry.data as {
          currentWorktreePath?: string;
          currentBranch?: string;
          mainRepoPath?: string;
        };
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

    // Non-interactive environments (CI, background, pipes): do not hang on readline (Q2)
    if (!process.stdin.isTTY) return;

    // 5. Confirm deletion with user (readline-based: works after TUI shutdown)
    const names = toCleanup.map((item) => item.wt.branchName).join(", ");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\nRemove worktree(s) used in this session (${names})? [y/N] `,
    );
    rl.close();

    if (/^[yY]/.test(answer.trim())) {
      for (const item of toCleanup) {
        try {
          await cleanupWorktree(deps, { branch: item.wt.branchName }, { cwd: item.repo });
        } catch {
          // Ignore cleanup failures so process exit is not blocked
        }
      }
    }
  });
}
