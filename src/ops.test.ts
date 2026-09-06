import { describe, it, expect, vi } from "vitest";
import {
  createWorktree,
  switchWorktree,
  cleanupWorktree,
  detectMainRepoWithExec,
  detectDefaultBranchWithExec,
  hasUncommittedChangesWithExec,
  type OpsDeps,
} from "./ops.js";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

// Helper to make dummy ExecResult
function ok(stdout = "", stderr = ""): ExecResult {
  return { stdout, stderr, code: 0, killed: false };
}

function fail(stderr = "error", stdout = "", code = 1): ExecResult {
  return { stdout, stderr, code, killed: false };
}

describe("detectMainRepoWithExec", () => {
  it("detects main worktree path from porcelain output", async () => {
    const exec = vi.fn().mockResolvedValue(
      ok("worktree /path/to/repo\nHEAD 1234\nbranch refs/heads/main\n\nworktree /path/to/repo/.git/worktrees/feat\nHEAD 5678\nbranch refs/heads/feat\n\n"),
    );
    const mainRepo = await detectMainRepoWithExec(exec, "/path/to/repo");
    expect(mainRepo).toBe("/path/to/repo");
  });

  it("returns null if git command fails", async () => {
    const exec = vi.fn().mockResolvedValue(fail("not a git repo"));
    const mainRepo = await detectMainRepoWithExec(exec, "/tmp");
    expect(mainRepo).toBeNull();
  });
});

describe("detectDefaultBranchWithExec", () => {
  it("detects default branch from symbolic-ref", async () => {
    const exec = vi.fn().mockResolvedValue(ok("refs/remotes/origin/develop\n"));
    const branch = await detectDefaultBranchWithExec(exec, "/repo");
    expect(branch).toBe("develop");
  });

  it("falls back to main worktree branch if symbolic-ref fails", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref") return fail("no remote");
      if (args[0] === "worktree") {
        return ok("worktree /repo\nHEAD 1234\nbranch refs/heads/master\n\n");
      }
      return fail();
    });
    const branch = await detectDefaultBranchWithExec(exec, "/repo");
    expect(branch).toBe("master");
  });
});

describe("hasUncommittedChangesWithExec", () => {
  it("returns true when status output is non-empty", async () => {
    const exec = vi.fn().mockResolvedValue(ok(" M file.txt\n"));
    const dirty = await hasUncommittedChangesWithExec(exec, "/repo");
    expect(dirty).toBe(true);
  });

  it("returns false when status output is empty", async () => {
    const exec = vi.fn().mockResolvedValue(ok(""));
    const dirty = await hasUncommittedChangesWithExec(exec, "/repo");
    expect(dirty).toBe(false);
  });
});

describe("createWorktree", () => {
  function makeDeps(customExec?: (args: string[], cwd?: string) => Promise<ExecResult>): {
    deps: OpsDeps;
    exec: ReturnType<typeof vi.fn>;
    setEffectiveCwd: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
    updateFooterStatus: ReturnType<typeof vi.fn>;
    statSync: ReturnType<typeof vi.fn>;
  } {
    const exec = vi.fn().mockImplementation(customExec ?? (async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n");
      }
      if (args[0] === "rev-parse") {
        return fail("branch not found"); // branch does not exist yet -> use -b
      }
      if (args[0] === "worktree" && args[1] === "add") {
        return ok();
      }
      return ok();
    }));
    const setEffectiveCwd = vi.fn();
    const appendEntry = vi.fn();
    const updateFooterStatus = vi.fn();
    const statSync = vi.fn().mockImplementation(() => {
      const err = new Error("ENOENT");
      (err as unknown as { code: string }).code = "ENOENT";
      throw err;
    });

    return {
      deps: { exec, setEffectiveCwd, appendEntry, updateFooterStatus, statSync },
      exec,
      setEffectiveCwd,
      appendEntry,
      updateFooterStatus,
      statSync,
    };
  }

  it("#1 正常系: branch 指定で worktree 作成 & CWD 切替", async () => {
    const { deps, exec, setEffectiveCwd, appendEntry, updateFooterStatus } = makeDeps();
    const result = await createWorktree(deps, { branch: "feature/foo" }, { cwd: "/repo" });

    expect(exec).toHaveBeenCalledWith(
      ["worktree", "add", "-b", "feature/foo", "/repo/.git/worktrees/feature/foo"],
      "/repo",
    );
    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo/.git/worktrees/feature/foo");
    expect(appendEntry).toHaveBeenCalledWith("cwd-change", {
      cwd: "/repo/.git/worktrees/feature/foo",
    });
    expect(updateFooterStatus).toHaveBeenCalledWith(
      { cwd: "/repo" },
      "/repo/.git/worktrees/feature/foo",
      "/repo",
    );
    expect(result.details.branch).toBe("feature/foo");
  });

  it("#2 空ブランチ名でエラー", async () => {
    const { deps } = makeDeps();
    await expect(createWorktree(deps, { branch: "" }, { cwd: "/repo" })).rejects.toThrow(
      "Invalid branch name",
    );
  });

  it("#3 不正なブランチ名（.. / スペース等）でエラー", async () => {
    const { deps } = makeDeps();
    await expect(createWorktree(deps, { branch: "feat..foo" }, { cwd: "/repo" })).rejects.toThrow(
      "Invalid branch name",
    );
    await expect(createWorktree(deps, { branch: "feat foo" }, { cwd: "/repo" })).rejects.toThrow(
      "Invalid branch name",
    );
  });

  it("#4 既存ディレクトリでエラー", async () => {
    const { deps, statSync } = makeDeps();
    statSync.mockReturnValue({ isDirectory: () => true });

    await expect(
      createWorktree(deps, { branch: "feature/foo" }, { cwd: "/repo" }),
    ).rejects.toThrow("Directory already exists");
  });
});

describe("switchWorktree", () => {
  function makeDeps(): {
    deps: OpsDeps;
    exec: ReturnType<typeof vi.fn>;
    setEffectiveCwd: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
    updateFooterStatus: ReturnType<typeof vi.fn>;
  } {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(
          "worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
          "worktree /repo/.git/worktrees/feat\nHEAD 5678\nbranch refs/heads/feat\n\n",
        );
      }
      return ok();
    });
    const setEffectiveCwd = vi.fn();
    const appendEntry = vi.fn();
    const updateFooterStatus = vi.fn();

    return { deps: { exec, setEffectiveCwd, appendEntry, updateFooterStatus }, exec, setEffectiveCwd, appendEntry, updateFooterStatus };
  }

  it("#5 default branch (main) へ復帰", async () => {
    const { deps, setEffectiveCwd } = makeDeps();
    const result = await switchWorktree(deps, { branch: "main" }, { cwd: "/repo" });

    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo");
    expect(result.details.branch).toBe("main");
  });

  it("#6 既存 worktree へ切替", async () => {
    const { deps, setEffectiveCwd } = makeDeps();
    const result = await switchWorktree(deps, { branch: "feat" }, { cwd: "/repo" });

    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo/.git/worktrees/feat");
    expect(result.details.branch).toBe("feat");
  });

  it("#7 存在しない branch でエラー", async () => {
    const { deps } = makeDeps();
    await expect(switchWorktree(deps, { branch: "nonexistent" }, { cwd: "/repo" })).rejects.toThrow(
      "No worktree found for branch 'nonexistent'",
    );
  });
});

describe("cleanupWorktree", () => {
  function makeDeps(isDirty = false): {
    deps: OpsDeps;
    exec: ReturnType<typeof vi.fn>;
    setEffectiveCwd: ReturnType<typeof vi.fn>;
  } {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(
          "worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
          "worktree /repo/.git/worktrees/feat\nHEAD 5678\nbranch refs/heads/feat\n\n",
        );
      }
      if (args[0] === "status") {
        return isDirty ? ok(" M dirty.txt\n") : ok("");
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return ok();
      }
      if (args[0] === "branch" && args[1] === "-d") {
        return ok();
      }
      return ok();
    });
    const setEffectiveCwd = vi.fn();
    const appendEntry = vi.fn();
    const updateFooterStatus = vi.fn();

    return { deps: { exec, setEffectiveCwd, appendEntry, updateFooterStatus }, exec, setEffectiveCwd };
  }

  it("#8 未コミット変更ありでエラー（remove を呼ばない）", async () => {
    const { deps, exec } = makeDeps(true); // dirty
    await expect(cleanupWorktree(deps, { branch: "feat" }, { cwd: "/repo" })).rejects.toThrow(
      "has uncommitted changes",
    );
    expect(exec).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]), expect.anything());
  });

  it("#9 正常削除: remove, prune, branch -d 実行 & CWD 復帰", async () => {
    const { deps, exec, setEffectiveCwd } = makeDeps(false);
    const result = await cleanupWorktree(deps, { branch: "feat" }, { cwd: "/repo" });

    expect(exec).toHaveBeenCalledWith(["worktree", "remove", "-f", "/repo/.git/worktrees/feat"], "/repo");
    expect(exec).toHaveBeenCalledWith(["worktree", "prune"], "/repo");
    expect(exec).toHaveBeenCalledWith(["branch", "-d", "feat"], "/repo");
    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo");
    expect(result.details.branchDeleted).toBe(true);
  });

  it("#10 存在しない worktree でエラー", async () => {
    const { deps } = makeDeps(false);
    await expect(cleanupWorktree(deps, { branch: "nonexistent" }, { cwd: "/repo" })).rejects.toThrow(
      "No worktree found for branch 'nonexistent'",
    );
  });
});
