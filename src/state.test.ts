import { describe, it, expect, beforeEach } from "vitest";
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
  CWD_CHANGE_TYPE,
  WORKTREE_CHANGE_TYPE,
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
});


  it("initOriginalCwd correctly updates originalCwd when resuming in a different directory", () => {
    initOriginalCwd("/resumed-dir");
    expect(getOriginalCwd()).toBe("/resumed-dir");
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

describe("restoreFromBranch", () => {
  function makeMockContext(entries: SessionEntry[]): ExtensionContext {
    return {
      sessionManager: {
        getBranch: () => entries,
      },
    } as unknown as ExtensionContext;
  }

  it("restores cwd from last valid cwd-change entry", () => {
    // /tmp exists as directory on all Linux environments
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
        data: { cwd: "/tmp" }, // valid
      } as unknown as SessionEntry,
      {
        type: "custom",
        customType: CWD_CHANGE_TYPE,
        data: { cwd: "/nonexistent/deleted/dir" }, // invalid
      } as unknown as SessionEntry,
    ];

    restoreFromBranch(makeMockContext(entries));
    // Falls back to the earlier valid entry /tmp
    expect(getEffectiveCwd()).toBe("/tmp");
  });
});
