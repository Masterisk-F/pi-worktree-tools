import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveWorktreeBaseDir,
  isInside,
  flatBranchDirName,
  bashSingleQuote,
  expandTilde,
  DEFAULT_BASE_DIR,
} from "./paths.js";

describe("DEFAULT_BASE_DIR", () => {
  it("defaults to .worktrees/", () => {
    expect(DEFAULT_BASE_DIR).toBe(".worktrees/");
  });
});

describe("flatBranchDirName", () => {
  it("replaces forward slashes with hyphens", () => {
    expect(flatBranchDirName("feature/login")).toBe("feature-login");
    expect(flatBranchDirName("fix/nested/branch")).toBe("fix-nested-branch");
  });

  it("leaves single-token names unchanged", () => {
    expect(flatBranchDirName("main")).toBe("main");
    expect(flatBranchDirName("feature-login")).toBe("feature-login");
  });

  // Collision handling lives in ops.ts (free-suffix probe) and is covered there.
});

describe("bashSingleQuote", () => {
  it("wraps in single quotes", () => {
    expect(bashSingleQuote("/simple/path")).toBe("'/simple/path'");
  });

  it("handles spaces", () => {
    expect(bashSingleQuote("/path/with space/dir")).toBe("'/path/with space/dir'");
  });

  it("escapes embedded single quotes safely", () => {
    expect(bashSingleQuote("foo'bar")).toBe("'foo'\\''bar'");
  });

  it("prevents shell expansion of dollar signs and backticks", () => {
    expect(bashSingleQuote("$HOME/`whoami`")).toBe("'$HOME/`whoami`'");
  });
});

describe("isInside", () => {
  it("returns true for exact match", () => {
    expect(isInside("/repo/.git", "/repo/.git")).toBe(true);
  });

  it("returns true for sub-paths", () => {
    expect(isInside("/repo/.git/worktrees", "/repo/.git")).toBe(true);
    expect(isInside("/repo/.git/worktrees/feat", "/repo/.git")).toBe(true);
  });

  it("returns false for non-descendant paths sharing a prefix", () => {
    expect(isInside("/repo/.github", "/repo/.git")).toBe(false);
    expect(isInside("/repo/.git-something", "/repo/.git")).toBe(false);
  });

  it("returns false for sibling paths", () => {
    expect(isInside("/repo/.worktrees", "/repo/.git")).toBe(false);
    expect(isInside("/other/path", "/repo/.git")).toBe(false);
  });
});

describe("expandTilde", () => {
  it("expands leading tilde", () => {
    const result = expandTilde("~/foo");
    expect(result.startsWith("~")).toBe(false);
    expect(result.endsWith("/foo")).toBe(true);
  });

  it("leaves non-tilde paths unchanged", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
    expect(expandTilde("./rel/path")).toBe("./rel/path");
  });
});

describe("resolveWorktreeBaseDir", () => {
  const mainRepo = "/path/to/repo";
  const gitDir = "/path/to/repo/.git";

  it("returns <mainRepo>/.worktrees/ by default when settings file does not exist", () => {
    const baseDir = resolveWorktreeBaseDir(mainRepo, gitDir, "/nonexistent/settings.json");
    expect(baseDir).toBe("/path/to/repo/.worktrees/");
  });

  it("returns <mainRepo>/.worktrees/ when settings has no worktrees section", () => {
    const settingsPath = join(tmpdir(), `pi-test-settings-${Date.now()}-1.json`);
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
    try {
      const baseDir = resolveWorktreeBaseDir(mainRepo, gitDir, settingsPath);
      expect(baseDir).toBe("/path/to/repo/.worktrees/");
    } finally {
      try { unlinkSync(settingsPath); } catch {}
    }
  });

  it("respects custom relative baseDir outside of gitDir", () => {
    const settingsPath = join(tmpdir(), `pi-test-settings-${Date.now()}-2.json`);
    writeFileSync(settingsPath, JSON.stringify({ worktrees: { baseDir: "../worktrees" } }));
    try {
      const baseDir = resolveWorktreeBaseDir(mainRepo, gitDir, settingsPath);
      expect(baseDir).toBe("/path/to/worktrees/");
    } finally {
      try { unlinkSync(settingsPath); } catch {}
    }
  });

  it("respects custom absolute baseDir outside of gitDir", () => {
    const settingsPath = join(tmpdir(), `pi-test-settings-${Date.now()}-3.json`);
    writeFileSync(settingsPath, JSON.stringify({ worktrees: { baseDir: "/tmp/custom-worktrees" } }));
    try {
      const baseDir = resolveWorktreeBaseDir(mainRepo, gitDir, settingsPath);
      expect(baseDir).toBe("/tmp/custom-worktrees/");
    } finally {
      try { unlinkSync(settingsPath); } catch {}
    }
  });

  it("OVERRULES configured path if it points inside .git (the root cause of the data-loss bug)", () => {
    const settingsPath = join(tmpdir(), `pi-test-settings-${Date.now()}-4.json`);
    // Legacy default or misguided user setting pointing into .git/worktrees/
    writeFileSync(settingsPath, JSON.stringify({ worktrees: { baseDir: "./.git/worktrees/" } }));
    try {
      const baseDir = resolveWorktreeBaseDir(mainRepo, gitDir, settingsPath);
      // Must fall back to safe .worktrees/ at repo root
      expect(baseDir).toBe("/path/to/repo/.worktrees/");
    } finally {
      try { unlinkSync(settingsPath); } catch {}
    }
  });

  it("ensures a trailing slash", () => {
    const settingsPath = join(tmpdir(), `pi-test-settings-${Date.now()}-5.json`);
    writeFileSync(settingsPath, JSON.stringify({ worktrees: { baseDir: ".worktrees" } }));
    try {
      const baseDir = resolveWorktreeBaseDir(mainRepo, gitDir, settingsPath);
      expect(baseDir.endsWith("/")).toBe(true);
    } finally {
      try { unlinkSync(settingsPath); } catch {}
    }
  });
});
