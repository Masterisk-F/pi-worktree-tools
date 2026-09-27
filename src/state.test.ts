import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getEffectiveCwd,
  setEffectiveCwd,
  getOriginalCwd,
  initOriginalCwd,
  setWorktreeState,
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
  function makeMockContext(): { ctx: ExtensionContext; setStatus: ReturnType<typeof vi.fn> } {
    const setStatus = vi.fn();
    const ctx = {
      hasUI: true,
      ui: {
        setStatus,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;
    return { ctx, setStatus };
  }

  it("setWorktreeState feeds the footer: feature worktree shows 🌳", () => {
    setWorktreeState("/repo", "/repo/.worktrees/feat", "feat", "master");
    const { ctx, setStatus } = makeMockContext();

    updateWorktreeFooter(ctx);
    expect(setStatus).toHaveBeenCalledWith(
      WORKTREE_STATUS_KEY,
      expect.stringContaining("🌳 feat"),
    );
  });

  it("setWorktreeState feeds the footer: main repo at main branch clears 🌳", () => {
    setWorktreeState("/repo", "/repo", "main", "main");
    const { ctx, setStatus } = makeMockContext();

    updateWorktreeFooter(ctx);
    expect(setStatus).toHaveBeenCalledWith(WORKTREE_STATUS_KEY, undefined);
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
    setWorktreeState("/repo", "/repo", "main", "main");
    const { ctx, setStatus } = makeMockContext();

    updateWorktreeFooter(ctx);
    expect(setStatus).toHaveBeenCalledWith(WORKTREE_STATUS_KEY, undefined);
  });

  it("displays 🌳 indicator when on feature worktree", () => {
    setWorktreeState("/repo", "/repo/.worktrees/feature-x", "feature/x", "main");
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

  it("(I4) 消えたワークツリーからの復元で CWD が mainRepoPath に同期する", () => {
    // Session branch history:
    // Entry 1: cwd-change to /tmp (an older, still-existing directory)
    // Entry 2: cwd-change to /missing-wt (most recent cwd, deleted out-of-band)
    // Entry 3: worktree-change pointing to /missing-wt with mainRepoPath = /repo-root
    // Note: /repo-root exists, /tmp exists, but /missing-wt is gone.
    //
    // WITHOUT I4 fix:
    //   Loop 1 (CWD): scans backwards, sees /missing-wt is missing, keeps scanning,
    //                 finds /tmp (still exists!), adopts effectiveCwd = /tmp.
    //   Loop 2 (worktree): sees /missing-wt is missing, falls back to mainRepoPath = /repo-root.
    //   Result: CWD is /tmp while worktree says /repo-root -> DIVERGENCE!
    const entries: SessionEntry[] = [
      {
        type: "custom",
        customType: CWD_CHANGE_TYPE,
        data: { cwd: "/tmp" },
      } as unknown as SessionEntry,
      {
        type: "custom",
        customType: CWD_CHANGE_TYPE,
        data: { cwd: "/missing-wt" },
      } as unknown as SessionEntry,
      {
        type: "custom",
        customType: WORKTREE_CHANGE_TYPE,
        data: {
          mainRepoPath: process.cwd(), // a real directory on disk
          currentWorktreePath: "/missing-wt", // does NOT exist
          currentBranch: "feature-missing",
          defaultBranch: "main",
        },
      } as unknown as SessionEntry,
    ];

    restoreFromBranch(makeMockContext(entries));

    // Loop 2 must take the missing-checkout fallback: worktree state becomes
    // main-on-mainRepoPath, so the 🌳 footer clears. (If restore had adopted
    // the stale feature-branch state instead, it would still show 🌳.)
    const setStatus = vi.fn();
    updateWorktreeFooter({
      hasUI: true,
      ui: { setStatus, theme: { fg: (_c: string, t: string) => t } },
    } as unknown as ExtensionContext);
    expect(setStatus).toHaveBeenCalledWith(WORKTREE_STATUS_KEY, undefined);

    // Under I4, CWD must NOT diverge to the older /tmp. It must be synchronized with mainRepoPath!
    expect(getEffectiveCwd()).toBe(process.cwd());
  });
});
