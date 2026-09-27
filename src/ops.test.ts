import { describe, it, expect, vi } from "vitest";
import {
  listWorktrees,
  createWorktree,
  switchWorktree,
  cleanupWorktree,
  detectMainRepoWithExec,
  detectDefaultBranchWithExec,
  hasUncommittedChangesWithExec,
  resolveEffectiveCwdForRemoval,
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

describe("resolveEffectiveCwdForRemoval (I1)", () => {
  const main = "/repo";
  const defaultBranch = "main";

  it("returns main repo when effectiveCwd was the removed worktree", () => {
    const next = resolveEffectiveCwdForRemoval(
      main,
      "/repo/.worktrees/feature-a",
      "/repo/.worktrees/feature-a",
      defaultBranch,
    );
    expect(next).toEqual({ cwd: main, branch: defaultBranch });
  });

  it("returns null when session is in a DIFFERENT worktree (preserves active context)", () => {
    const next = resolveEffectiveCwdForRemoval(
      main,
      "/repo/.worktrees/feature-b",
      "/repo/.worktrees/feature-a",
      defaultBranch,
    );
    expect(next).toBeNull();
  });

  it("returns main repo fallback when effectiveCwd is undefined/empty (legacy / unmocked tests)", () => {
    expect(resolveEffectiveCwdForRemoval(main, "/repo/.worktrees/feature-a", undefined, defaultBranch))
      .toEqual({ cwd: main, branch: defaultBranch });
    expect(resolveEffectiveCwdForRemoval(main, "/repo/.worktrees/feature-a", "", defaultBranch))
      .toEqual({ cwd: main, branch: defaultBranch });
  });

  it("returns null when session is already at the main repo (cleaning a background worktree)", () => {
    const next = resolveEffectiveCwdForRemoval(
      main,
      "/repo/.worktrees/feature-b",
      main,
      defaultBranch,
    );
    expect(next).toBeNull();
  });
});

describe("detectMainRepoWithExec", () => {
  it("detects main worktree path from porcelain output", async () => {
    const exec = vi.fn().mockResolvedValue(
      ok(
        "worktree /path/to/repo\nHEAD 1234\nbranch refs/heads/main\n\nworktree /path/to/repo/.worktrees/feat\nHEAD 5678\nbranch refs/heads/feat\n\n",
      ),
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

describe("listWorktrees", () => {
  it("lists all worktrees with formatted markdown", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(
          "worktree /repo\nHEAD 1234567890\nbranch refs/heads/main\n\n" +
            "worktree /repo/.worktrees/feat\nHEAD 5678901234\nbranch refs/heads/feat\n\n",
        );
      }
      if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
      return ok();
    });
    const deps: OpsDeps = {
      exec,
      setEffectiveCwd: vi.fn(),
      appendEntry: vi.fn(),
      updateFooterStatus: vi.fn(),
    };

    const result = await listWorktrees(deps, {}, { cwd: "/repo" });
    expect(result.content).toContain("Found 2 worktree(s):");
    expect(result.content).toContain("**main** (main repo)");
    expect(result.content).toContain("**feat**");
  });

  it("marks prunable worktrees clearly in list output", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(
          "worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
            "worktree /repo/.worktrees/broken\nHEAD 5678\nbranch refs/heads/broken\nprunable gitdir missing\n\n",
        );
      }
      return ok();
    });
    const deps: OpsDeps = {
      exec,
      setEffectiveCwd: vi.fn(),
      appendEntry: vi.fn(),
      updateFooterStatus: vi.fn(),
    };

    const result = await listWorktrees(deps, {}, { cwd: "/repo" });
    expect(result.content).toContain("broken");
    expect(result.content).toContain("[prunable: metadata broken or checkout missing]");
  });
});

describe("createWorktree", () => {
  function makeDeps(
    customExec?: (args: string[], cwd?: string) => Promise<ExecResult>,
    statMap: Record<string, boolean> = {},
  ): {
    deps: OpsDeps;
    exec: ReturnType<typeof vi.fn>;
    setEffectiveCwd: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
    updateFooterStatus: ReturnType<typeof vi.fn>;
    statSync: ReturnType<typeof vi.fn>;
  } {
    const exec = vi.fn().mockImplementation(
      customExec ??
        (async (args: string[]) => {
          if (args[0] === "worktree" && args[1] === "list") {
            return ok("worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n");
          }
          if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
            return ok(".git\n");
          }
          if (args[0] === "rev-parse") {
            return fail("branch not found"); // branch does not exist yet -> use -b
          }
          if (args[0] === "worktree" && args[1] === "add") {
            return ok();
          }
          return ok();
        }),
    );
    const setEffectiveCwd = vi.fn();
    const appendEntry = vi.fn();
    const updateFooterStatus = vi.fn();
    const statSync = vi.fn().mockImplementation((p: string) => {
      if (statMap[p]) {
        return { isDirectory: () => true };
      }
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

  it("#1 正常系: branch 指定で worktree 作成（.worktrees/ 配下にフラット名で作成）", async () => {
    const { deps, exec, setEffectiveCwd, appendEntry, updateFooterStatus } = makeDeps();
    const result = await createWorktree(deps, { branch: "feature/foo" }, { cwd: "/repo" });

    // Slashes flattened to hyphens: feature/foo -> feature-foo
    // Created inside .worktrees/ at repo root, NOT .git/worktrees/
    expect(exec).toHaveBeenCalledWith(
      ["worktree", "add", "-b", "feature/foo", "/repo/.worktrees/feature-foo"],
      "/repo",
    );
    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo/.worktrees/feature-foo");
    expect(appendEntry).toHaveBeenCalledWith("cwd-change", {
      cwd: "/repo/.worktrees/feature-foo",
    });
    expect(updateFooterStatus).toHaveBeenCalledWith(
      { cwd: "/repo" },
      "/repo/.worktrees/feature-foo",
      "/repo",
    );
    expect(result.details.branch).toBe("feature/foo");
    expect(result.details.path).toBe("/repo/.worktrees/feature-foo");
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

  it("#4 既存の健全な worktree があれば自動切り替え", async () => {
    const existingPath = "/repo/.worktrees/existing";
    const { deps, setEffectiveCwd } = makeDeps(
      async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return ok(
            "worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
              `worktree ${existingPath}\nHEAD 5678\nbranch refs/heads/existing\n\n`,
          );
        }
        return ok();
      },
      { [existingPath]: true }, // exists on disk
    );

    const result = await createWorktree(deps, { branch: "existing" }, { cwd: "/repo" });
    expect(setEffectiveCwd).toHaveBeenCalledWith(existingPath);
    expect(result.content).toContain("already exists");
  });

  it("#5 破損した既存 worktree は prune して再作成", async () => {
    const brokenPath = "/repo/.worktrees/damaged";
    const { deps, exec, setEffectiveCwd } = makeDeps(
      async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return ok(
            "worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
              `worktree ${brokenPath}\nHEAD 5678\nbranch refs/heads/damaged\nprunable gitdir missing\n\n`,
          );
        }
        if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
          return ok(".git\n");
        }
        if (args[0] === "rev-parse") return fail();
        return ok();
      },
      {}, // damagedPath does NOT exist on disk
    );

    const result = await createWorktree(deps, { branch: "damaged" }, { cwd: "/repo" });
    // prune must be called to purge dead metadata
    expect(exec).toHaveBeenCalledWith(["worktree", "prune"], "/repo");
    // then new worktree added at safe path
    expect(exec).toHaveBeenCalledWith(
      ["worktree", "add", "-b", "damaged", "/repo/.worktrees/damaged"],
      "/repo",
    );
    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo/.worktrees/damaged");
    expect(result.details.path).toBe("/repo/.worktrees/damaged");
  });

  it("#5b (I2) feature/login と feature-login が同一ベース名でも衝突を回避して作成可能", async () => {
    // Existing worktree for feature-login occupies /repo/.worktrees/feature-login
    const existingHyphenPath = "/repo/.worktrees/feature-login";
    const { deps, exec } = makeDeps(
      async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return ok(
            "worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
              `worktree ${existingHyphenPath}\nHEAD 5678\nbranch refs/heads/feature-login\n\n`,
          );
        }
        if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
          return ok(".git\n");
        }
        if (args[0] === "rev-parse") return fail(); // branch doesn't exist -> use -b
        if (args[0] === "worktree" && args[1] === "add") return ok();
        return ok();
      },
      // Note: /repo/.worktrees/feature-login exists on disk!
      { [existingHyphenPath]: true },
    );

    // Now create worktree for feature/login (slash variant)
    const result = await createWorktree(deps, { branch: "feature/login" }, { cwd: "/repo" });

    // Under I2, it must NOT use /repo/.worktrees/feature-login (which is taken).
    // Instead it uses a disambiguated hash suffix.
    expect(result.details.path).not.toBe(existingHyphenPath);
    expect((result.details.path as string).startsWith("/repo/.worktrees/feature-login-")).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add", "-b", "feature/login", result.details.path]),
      "/repo",
    );
  });
});

describe("switchWorktree", () => {
  function makeDeps(statMap: Record<string, boolean> = {}): {
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
            "worktree /repo/.worktrees/feat\nHEAD 5678\nbranch refs/heads/feat\n\n",
        );
      }
      if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
        return ok(".git\n");
      }
      if (args[0] === "rev-parse") return fail("not found");
      if (args[0] === "worktree" && args[1] === "add") return ok();
      return ok();
    });
    const setEffectiveCwd = vi.fn();
    const appendEntry = vi.fn();
    const updateFooterStatus = vi.fn();
    const statSync = vi.fn().mockImplementation((p: string) => {
      if (statMap[p]) {
        return { isDirectory: () => true };
      }
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
    };
  }

  it("#6 default branch (main) へ復帰", async () => {
    const { deps, setEffectiveCwd } = makeDeps();
    const result = await switchWorktree(deps, { branch: "main" }, { cwd: "/repo" });

    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo");
    expect(result.details.branch).toBe("main");
  });

  it("#7 既存の健全な worktree へ切替", async () => {
    const { deps, setEffectiveCwd } = makeDeps({ "/repo/.worktrees/feat": true });
    const result = await switchWorktree(deps, { branch: "feat" }, { cwd: "/repo" });

    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo/.worktrees/feat");
    expect(result.details.branch).toBe("feat");
  });

  it("#8 未存在の worktree は自動作成して切替（.worktrees/ 配下）", async () => {
    const { deps, setEffectiveCwd, exec } = makeDeps();
    const result = await switchWorktree(deps, { branch: "new-feature" }, { cwd: "/repo" });

    expect(exec).toHaveBeenCalledWith(
      ["worktree", "add", "-b", "new-feature", "/repo/.worktrees/new-feature"],
      "/repo",
    );
    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo/.worktrees/new-feature");
    expect(result.details.branch).toBe("new-feature");
  });

  it("#8b (Q4) 不正なブランチ名（.. / スペース等）で switchWorktree がエラー", async () => {
    // Healthy worktree already exists for feat..foo, so the auto-create path is NOT reached
    const { deps, exec } = makeDeps({ "/repo/.worktrees/feat..foo": true });
    // Make git worktree list return feat..foo as an existing healthy worktree
    exec.mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(
          "worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
            "worktree /repo/.worktrees/feat..foo\nHEAD 5678\nbranch refs/heads/feat..foo\n\n",
        );
      }
      return ok();
    });

    await expect(switchWorktree(deps, { branch: "feat..foo" }, { cwd: "/repo" })).rejects.toThrow(
      "Invalid branch name",
    );
  });
});

describe("cleanupWorktree", () => {
  function makeDeps(isDirty = false, missing = false): {
    deps: OpsDeps;
    exec: ReturnType<typeof vi.fn>;
    setEffectiveCwd: ReturnType<typeof vi.fn>;
  } {
    const wtPath = "/repo/.worktrees/feat";
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(
          "worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
            `worktree ${wtPath}\nHEAD 5678\nbranch refs/heads/feat\n\n`,
        );
      }
      if (args[0] === "status") {
        return isDirty ? ok(" M dirty.txt\n") : ok("");
      }
      if (args[0] === "worktree" && args[1] === "remove") return ok();
      if (args[0] === "branch" && args[1] === "-d") return ok();
      return ok();
    });
    const setEffectiveCwd = vi.fn();
    const appendEntry = vi.fn();
    const updateFooterStatus = vi.fn();
    const statSync = vi.fn().mockImplementation((p: string) => {
      if (!missing && p === wtPath) {
        return { isDirectory: () => true };
      }
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
    };
  }

  it("#9 未コミット変更ありでエラー（remove を呼ばない）", async () => {
    const { deps, exec } = makeDeps(true, false); // dirty
    await expect(cleanupWorktree(deps, { branch: "feat" }, { cwd: "/repo" })).rejects.toThrow(
      "has uncommitted changes",
    );
    expect(exec).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]), expect.anything());
  });

  it("#10 正常削除: remove, prune, branch -d 実行 & CWD 復帰", async () => {
    const { deps, exec, setEffectiveCwd } = makeDeps(false, false);
    const result = await cleanupWorktree(deps, { branch: "feat" }, { cwd: "/repo" });

    expect(exec).toHaveBeenCalledWith(
      ["worktree", "remove", "-f", "/repo/.worktrees/feat"],
      "/repo",
    );
    expect(exec).toHaveBeenCalledWith(["worktree", "prune"], "/repo");
    expect(exec).toHaveBeenCalledWith(["branch", "-d", "feat"], "/repo");
    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo");
    expect(result.details.branchDeleted).toBe(true);
  });

  it("#11 存在しない worktree でエラー", async () => {
    const { deps } = makeDeps(false, false);
    await expect(cleanupWorktree(deps, { branch: "nonexistent" }, { cwd: "/repo" })).rejects.toThrow(
      "No worktree found for branch 'nonexistent'",
    );
  });

  it("#12 実体ディレクトリが既に欠落している場合も安全に prune してブランチ削除（エラーで落ちない）", async () => {
    const { deps, exec, setEffectiveCwd } = makeDeps(false, true); // missing on disk
    const result = await cleanupWorktree(deps, { branch: "feat" }, { cwd: "/repo" });

    // remove must NOT be called on a non-existent path
    expect(exec).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]), expect.anything());
    // prune must be called to clear dead metadata
    expect(exec).toHaveBeenCalledWith(["worktree", "prune"], "/repo");
    expect(exec).toHaveBeenCalledWith(["branch", "-d", "feat"], "/repo");
    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo");
    expect(result.details.branchDeleted).toBe(true);
  });

  it("#13 (I1) 非アクティブな worktree の cleanup でアクティブな CWD が破壊されない", async () => {
    const { deps, setEffectiveCwd, appendEntry } = makeDeps(false, false);
    // Session is currently active in a DIFFERENT worktree
    deps.getEffectiveCwd = () => "/repo/.worktrees/other-active";

    const result = await cleanupWorktree(deps, { branch: "feat" }, { cwd: "/repo" });

    // wt is cleaned up
    expect(result.details.branch).toBe("feat");
    // BUT effectiveCwd is NOT reset to /repo
    expect(setEffectiveCwd).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalledWith("cwd-change", expect.anything());
    expect(appendEntry).not.toHaveBeenCalledWith("worktree-change", expect.anything());
  });
});
