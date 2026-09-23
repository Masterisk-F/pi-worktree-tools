import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getEffectiveCwd,
  setEffectiveCwd,
  getOriginalCwd,
  initOriginalCwd,
  getMainRepoPath,
  setMainRepoPath,
  getCurrentBranch,
  setCurrentBranch,
  getCurrentWorktreePath,
  setCurrentWorktreePath,
  getDefaultBranch,
  setDefaultBranch,
  resetWorktreeState,
  restoreFromBranch,
  updateCwdFooter,
  updateWorktreeFooter,
  CWD_CHANGE_TYPE,
  WORKTREE_CHANGE_TYPE,
  CWD_STATUS_KEY,
  WORKTREE_STATUS_KEY,
} from "./state.js";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

describe("CWD State", () => {
  beforeEach(() => {
    initOriginalCwd("/initial");
    setEffectiveCwd("/initial");
  });

  it("get/set effective cwd", () => {
    expect(getEffectiveCwd()).toBe("/initial");
    setEffectiveCwd("/new/path");
    expect(getEffectiveCwd()).toBe("/new/path");
    expect(getOriginalCwd()).toBe("/initial");
  });

  it("initOriginalCwd correctly updates originalCwd when resuming in a different directory", () => {
    initOriginalCwd("/resumed-dir");
    expect(getOriginalCwd()).toBe("/resumed-dir");
  });
});

describe("Worktree State", () => {
  beforeEach(() => {
    resetWorktreeState();
  });

  it("stores main repo path and branch info", () => {
    setMainRepoPath("/repo");
    setCurrentWorktreePath("/repo/.worktrees/feat");
    setCurrentBranch("feat");
    setDefaultBranch("master");

    expect(getMainRepoPath()).toBe("/repo");
    expect(getCurrentWorktreePath()).toBe("/repo/.worktrees/feat");
    expect(getCurrentBranch()).toBe("feat");
    expect(getDefaultBranch()).toBe("master");
  });

  it("reset restores defaults", () => {
    setCurrentBranch("something");
    resetWorktreeState();
    expect(getCurrentBranch()).toBe("main");
    expect(getMainRepoPath()).toBe("");
  });
});

describe("Footer Status", () => {
  function makeMockContext(): { ctx: ExtensionContext; setStatus: ReturnType<typeof vi.fn> } {
    const setStatus = vi.fn();
    const ctx = {
      hasUI: true,
      ui: {
        setStatus,
        theme: {
          fg: (_color: string, text: string) => text,
        },
      },
    } as unknown as ExtensionContext;
    return { ctx, setStatus };
  }

  it("clears CWD footer when effectiveCwd equals originalCwd", () => {
    initOriginalCwd("/same");
    setEffectiveCwd("/same");
    const { ctx, setStatus } = makeMockContext();

    updateCwdFooter(ctx);
    expect(setStatus).toHaveBeenCalledWith(CWD_STATUS_KEY, undefined);
  });

  it("displays 📂 indicator when effectiveCwd differs from originalCwd", () => {
    initOriginalCwd("/repo");
    setEffectiveCwd("/repo/.worktrees/feat");
    const { ctx, setStatus } = makeMockContext();

    updateCwdFooter(ctx);
    expect(setStatus).toHaveBeenCalledWith(
      CWD_STATUS_KEY,
      expect.stringContaining("📂 /repo/.worktrees/feat"),
    );
  });

  it("clears Worktree footer when on main branch at main repo", () => {
    setMainRepoPath("/repo");
    setCurrentWorktreePath("/repo");
    setCurrentBranch("main");
    setDefaultBranch("main");
    const { ctx, setStatus } = makeMockContext();

    updateWorktreeFooter(ctx);
    expect(setStatus).toHaveBeenCalledWith(WORKTREE_STATUS_KEY, undefined);
  });

  it("displays 🌳 indicator when on feature worktree", () => {
    setMainRepoPath("/repo");
    setCurrentWorktreePath("/repo/.worktrees/feature-x");
    setCurrentBranch("feature/x");
    setDefaultBranch("main");
    const { ctx, setStatus } = makeMockContext();

    updateWorktreeFooter(ctx);
    expect(setStatus).toHaveBeenCalledWith(
      WORKTREE_STATUS_KEY,
      expect.stringContaining("🌳 feature/x"),
    );
  });
});

describe("restoreFromBranch", () => {
  function makeMockContext(entries: SessionEntry[]): ExtensionContext {
    return {
      sessionManager: {
        getBranch: () => entries,
      },
    } as unknown as ExtensionContext;
  }

  it("restores cwd from last valid cwd-change entry", () => {
    const entries: SessionEntry[] = [
      {
        type: "custom",
        customType: CWD_CHANGE_TYPE,
        data: { cwd: "/tmp" },
      } as unknown as SessionEntry,
    ];

    restoreFromBranch(makeMockContext(entries));
    expect(getEffectiveCwd()).toBe("/tmp");
  });

  it("ignores deleted/inaccessible directories when restoring cwd", () => {
    const entries: SessionEntry[] = [
      {
        type: "custom",
        customType: CWD_CHANGE_TYPE,
        data: { cwd: "/tmp" },
      } as unknown as SessionEntry,
      {
        type: "custom",
        customType: CWD_CHANGE_TYPE,
        data: { cwd: "/nonexistent/deleted/dir" },
      } as unknown as SessionEntry,
    ];

    restoreFromBranch(makeMockContext(entries));
    expect(getEffectiveCwd()).toBe("/tmp");
  });
});
