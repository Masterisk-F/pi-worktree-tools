import { describe, it, expect, vi } from "vitest";
import {
  listWorktrees,
  createWorktree,
  switchWorktree,
  cleanupWorktree,
  type OpsDeps,
} from "./ops.js";
import {
  detectMainRepoWithExec,
  detectDefaultBranchWithExec,
  hasUncommittedChangesWithExec,
} from "./git.js";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

// Helper to make dummy ExecResult
function ok(stdout = "", stderr = ""): ExecResult {
  return { stdout, stderr, code: 0, killed: false };
}

function fail(stderr = "error", stdout = "", code = 1): ExecResult {
  return { stdout, stderr, code, killed: false };
}

function makeStatMap(statMap: Record<string, boolean>) {
  return (p: string) => {
    if (statMap[p]) return { isDirectory: () => true };
    const err = new Error("ENOENT");
    (err as unknown as { code: string }).code = "ENOENT";
    throw err;
  };
}

function createMockDeps(
  execImpl: (args: string[], cwd?: string) => Promise<ExecResult>,
  statFn?: (p: string) => { isDirectory: () => boolean },
) {
  const exec = vi.fn().mockImplementation(execImpl);
  const setEffectiveCwd = vi.fn();
  const appendEntry = vi.fn();
  const updateFooterStatus = vi.fn();
  const statSync = vi.fn().mockImplementation(
    statFn ??
      ((_p: string) => {
        const err = new Error("ENOENT");
        (err as unknown as { code: string }).code = "ENOENT";
        throw err;
      }),
  );
  return {
    deps: { exec, setEffectiveCwd, appendEntry, updateFooterStatus, statSync },
    exec,
    setEffectiveCwd,
    appendEntry,
    updateFooterStatus,
    statSync,
  };
}

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
  ) {
    return createMockDeps(
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
      makeStatMap(statMap),
    );
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
    expect(updateFooterStatus).toHaveBeenCalledWith({ cwd: "/repo" });
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
    // Instead it probes the first free numeric suffix.
    expect(result.details.path).toBe("/repo/.worktrees/feature-login-2");
    expect(exec).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add", "-b", "feature/login", result.details.path]),
      "/repo",
    );
  });

  it("#5c (I2) ディスクに存在するが worktree list に無い占有ディレクトリでも作成できる", async () => {
    // A directory sits at the base flat name but has NO registered worktree
    // (abandoned checkout, or a `prunable` entry the old `!w.prunable` filter
    // excluded). The old predicate then returned false, and the old code fell
    // through to a hard `Directory already exists:` throw.
    const occupiedPath = "/repo/.worktrees/feature-login";
    const { deps, exec } = makeDeps(
      async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          // No entry at occupiedPath — only the main repo.
          return ok("worktree /repo\nHEAD 1234\nbranch refs/heads/main\n\n");
        }
        if (args[0] === "rev-parse" && args.includes("--git-common-dir")) return ok(".git\n");
        if (args[0] === "rev-parse") return fail(); // branch doesn't exist -> use -b
        return ok();
      },
      { [occupiedPath]: true }, // but the directory EXISTS on disk
    );

    const result = await createWorktree(deps, { branch: "feature-login" }, { cwd: "/repo" });

    expect(result.details.path).toBe(occupiedPath + "-2");
    expect(exec).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add", "-b", "feature-login", occupiedPath + "-2"]),
      "/repo",
    );
  });
});

describe("switchWorktree", () => {
  function makeDeps(statMap: Record<string, boolean> = {}) {
    return createMockDeps(
      async (args: string[]) => {
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
      },
      makeStatMap(statMap),
    );
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
  function makeDeps(isDirty = false, missing = false) {
    const wtPath = "/repo/.worktrees/feat";
    return createMockDeps(
      async (args: string[]) => {
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
      },
      (p: string) => {
        if (!missing && p === wtPath) {
          return { isDirectory: () => true };
        }
        const err = new Error("ENOENT");
        (err as unknown as { code: string }).code = "ENOENT";
        throw err;
      },
    );
  }

  it("#9 未コミット変更ありでエラー（remove を呼ばない）", async () => {
    const { deps, exec } = makeDeps(true, false); // dirty
    await expect(
      cleanupWorktree(deps, { branch: "feat", repo: "/repo" }, { cwd: "/repo" }),
    ).rejects.toThrow("has uncommitted changes");
    expect(exec).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]), expect.anything());
  });

  it("repo が空文字または空白のみの場合はエラー", async () => {
    const { deps } = makeDeps(false, false);
    await expect(
      cleanupWorktree(deps, { branch: "feat", repo: "" }, { cwd: "/repo" }),
    ).rejects.toThrow("Repository path cannot be empty");
    await expect(
      cleanupWorktree(deps, { branch: "feat", repo: "   " }, { cwd: "/repo" }),
    ).rejects.toThrow("Repository path cannot be empty");
  });

  it("git リポジトリ外のパスが渡された場合はエラー", async () => {
    const exec = vi.fn().mockResolvedValue(fail("not a git repo"));
    const deps: OpsDeps = {
      exec,
      setEffectiveCwd: vi.fn(),
      appendEntry: vi.fn(),
      updateFooterStatus: vi.fn(),
    };
    await expect(
      cleanupWorktree(deps, { branch: "feat", repo: "/not/a/repo" }, { cwd: "/repo" }),
    ).rejects.toThrow("Not inside a git repository: /not/a/repo");
  });

  it("#10 正常削除: remove, prune, branch -d 実行 & CWD 復帰", async () => {
    const { deps, exec, setEffectiveCwd } = makeDeps(false, false);
    const result = await cleanupWorktree(deps, { branch: "feat", repo: "/repo" }, { cwd: "/repo" });

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
    await expect(
      cleanupWorktree(deps, { branch: "nonexistent", repo: "/repo" }, { cwd: "/repo" }),
    ).rejects.toThrow("No worktree found for branch 'nonexistent'");
  });

  it("#12 実体ディレクトリが既に欠落している場合も安全に prune してブランチ削除（エラーで落ちない）", async () => {
    const { deps, exec, setEffectiveCwd } = makeDeps(false, true); // missing on disk
    const result = await cleanupWorktree(deps, { branch: "feat", repo: "/repo" }, { cwd: "/repo" });

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

    const result = await cleanupWorktree(deps, { branch: "feat", repo: "/repo" }, { cwd: "/repo" });

    // wt is cleaned up
    expect(result.details.branch).toBe("feat");
    // BUT effectiveCwd is NOT reset to /repo
    expect(setEffectiveCwd).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalledWith("cwd-change", expect.anything());
    expect(appendEntry).not.toHaveBeenCalledWith("worktree-change", expect.anything());
  });

  it("(I1) 削除対象がアクティブな worktree のときは main repo へ復帰する", async () => {
    const { deps, setEffectiveCwd } = makeDeps(false, false);
    deps.getEffectiveCwd = () => "/repo/.worktrees/feat"; // the active worktree IS removed

    await cleanupWorktree(deps, { branch: "feat", repo: "/repo" }, { cwd: "/repo" });

    expect(setEffectiveCwd).toHaveBeenCalledWith("/repo");
  });

  it("(I1) 既に main repo にいる状態で別 worktree を掃除しても CWD を動かさない", async () => {
    const { deps, setEffectiveCwd, appendEntry } = makeDeps(false, false);
    deps.getEffectiveCwd = () => "/repo"; // already at main repo

    await cleanupWorktree(deps, { branch: "feat", repo: "/repo" }, { cwd: "/repo" });

    expect(setEffectiveCwd).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalledWith("cwd-change", expect.anything());
  });

  it("#14 (I1) repo 引数で指定したリポジトリの worktree を cleanup する（別リポジトリがアクティブでも）", async () => {
    // Two repositories: repoA is the session-active one, repoB is the cleanup target.
    // exec() branches on its cwd argument so that a repo mix-up is observable.
    const exec = vi.fn().mockImplementation(async (args: string[], cwd?: string) => {
      if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
      if (args[0] === "worktree" && args[1] === "list") {
        return cwd === "/repoB"
          ? ok(
              "worktree /repoB\nHEAD 1\nbranch refs/heads/main\n\n" +
                "worktree /repoB/.worktrees/feat\nHEAD 2\nbranch refs/heads/feat\n\n",
            )
          : ok("worktree /repoA\nHEAD 3\nbranch refs/heads/main\n\n");
      }
      if (args[0] === "status") return ok("");
      return ok();
    });
    const setEffectiveCwd = vi.fn();
    const deps: OpsDeps = {
      exec,
      setEffectiveCwd,
      appendEntry: vi.fn(),
      updateFooterStatus: vi.fn(),
      statSync: vi.fn(() => ({ isDirectory: () => true })),
      getEffectiveCwd: () => "/repoA/.worktrees/active",
    };

    const result = await cleanupWorktree(deps, { branch: "feat", repo: "/repoB" }, { cwd: "/repoA" });

    expect(exec).toHaveBeenCalledWith(["worktree", "list", "--porcelain"], "/repoB");
    expect(exec).toHaveBeenCalledWith(
      ["worktree", "remove", "-f", "/repoB/.worktrees/feat"],
      "/repoB",
    );
    expect(result.details.mainRepo).toBe("/repoB");
  });

  it("#15 default branch の worktree 削除を拒否する", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(
          "worktree /repo\nHEAD 1\nbranch refs/heads/main\n\n" +
            "worktree /repo/.worktrees/feat\nHEAD 2\nbranch refs/heads/feat\n\n",
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

    await expect(
      cleanupWorktree(deps, { branch: "main", repo: "/repo" }, { cwd: "/repo" }),
    ).rejects.toThrow("Cannot remove the default branch (main) worktree");
    expect(exec).not.toHaveBeenCalledWith(expect.arrayContaining(["remove"]), expect.anything());
  });

  it("#16 default が main のとき master worktree は通常通り削除できる（magic alias なし）", async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref") return ok("refs/remotes/origin/main\n");
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(
          "worktree /repo\nHEAD 1\nbranch refs/heads/main\n\n" +
            "worktree /repo/.worktrees/master\nHEAD 2\nbranch refs/heads/master\n\n",
        );
      }
      if (args[0] === "status") return ok("");
      if (args[0] === "worktree" && args[1] === "remove") return ok();
      if (args[0] === "branch" && args[1] === "-d") return ok();
      return ok();
    });
    const deps: OpsDeps = {
      exec,
      setEffectiveCwd: vi.fn(),
      appendEntry: vi.fn(),
      updateFooterStatus: vi.fn(),
      statSync: vi.fn(() => ({ isDirectory: () => true })),
    };

    const result = await cleanupWorktree(deps, { branch: "master", repo: "/repo" }, { cwd: "/repo" });
    expect(exec).toHaveBeenCalledWith(
      ["worktree", "remove", "-f", "/repo/.worktrees/master"],
      "/repo",
    );
    expect(result.details.branch).toBe("master");
  });
});
