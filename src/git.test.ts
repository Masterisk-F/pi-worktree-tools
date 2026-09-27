import { describe, it, expect, vi } from "vitest";
import {
  parseWorktreePorcelain,
  findWorktreeByBranch,
  getMainWorktree,
  detectGitDirWithExec,
} from "./git.js";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

function ok(stdout = "", stderr = ""): ExecResult {
  return { stdout, stderr, code: 0, killed: false };
}

describe("parseWorktreePorcelain", () => {
  it("parses standard worktree list output", () => {
    const output =
      "worktree /path/to/repo\nHEAD 1234567\nbranch refs/heads/main\n\n" +
      "worktree /path/to/repo/.worktrees/feat\nHEAD 89abcdef\nbranch refs/heads/feat\n\n";

    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      path: "/path/to/repo",
      head: "1234567",
      branch: "refs/heads/main",
      branchName: "main",
    });
    expect(result[1]).toEqual({
      path: "/path/to/repo/.worktrees/feat",
      head: "89abcdef",
      branch: "refs/heads/feat",
      branchName: "feat",
    });
  });

  it("identifies prunable worktrees in porcelain output", () => {
    const output =
      "worktree /path/to/repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
      "worktree /path/to/repo/.git/worktrees/broken\nHEAD 5678\nbranch refs/heads/broken\nprunable gitdir file does not exist\n\n";

    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(2);
    expect(result[0].prunable).toBeUndefined();
    expect(result[1].prunable).toBe(true);
  });

  it("handles detached HEAD", () => {
    const output = "worktree /path/to/repo\nHEAD 1234\ndetached\n\n";
    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(1);
    expect(result[0].branchName).toBe("detached");
  });

  it("returns empty array for empty output", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
    expect(parseWorktreePorcelain("   \n\n  ")).toEqual([]);
  });
});


describe("findWorktreeByBranch", () => {
  it("finds matching entry by branchName", () => {
    const worktrees = [
      { path: "/repo", head: "1", branch: "refs/heads/main", branchName: "main" },
      { path: "/repo/feat", head: "2", branch: "refs/heads/feature/login", branchName: "feature/login" },
    ];
    expect(findWorktreeByBranch(worktrees, "feature/login")?.path).toBe("/repo/feat");
    expect(findWorktreeByBranch(worktrees, "nonexistent")).toBeUndefined();
  });
});

describe("getMainWorktree", () => {
  it("returns the first worktree in the list", () => {
    const worktrees = [
      { path: "/main", head: "1", branch: "refs/heads/main", branchName: "main" },
      { path: "/secondary", head: "2", branch: "refs/heads/feat", branchName: "feat" },
    ];
    expect(getMainWorktree(worktrees)?.path).toBe("/main");
  });
});

describe("detectGitDirWithExec", () => {
  it("resolves relative .git path against cwd", async () => {
    const exec = vi.fn().mockResolvedValue(ok(".git\n"));
    const gitDir = await detectGitDirWithExec(exec, "/path/to/repo");
    expect(gitDir).toBe("/path/to/repo/.git");
  });

  it("handles absolute gitDir path if returned", async () => {
    const exec = vi.fn().mockResolvedValue(ok("/other/place/.git\n"));
    const gitDir = await detectGitDirWithExec(exec, "/path/to/repo");
    expect(gitDir).toBe("/other/place/.git");
  });

  it("falls back to <cwd>/.git if rev-parse fails", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "err", code: 1, killed: false });
    const gitDir = await detectGitDirWithExec(exec, "/fallback/repo");
    expect(gitDir).toBe("/fallback/repo/.git");
  });
});
