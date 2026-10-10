import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
}));

import * as readlinePromises from "node:readline/promises";
import plugin, { ensureWorktreesExcluded } from "./index.js";
import {
  initOriginalCwd,
  setEffectiveCwd,
  setWorktreeState,
} from "./state.js";

type EventHandler = (event: any, ctx: any) => Promise<any> | any;
type MockExtensionAPI = ReturnType<typeof makeMockPi>;

function makeMockPi() {
  const registeredTools = new Map<string, any>();
  const eventHandlers = new Map<string, EventHandler[]>();
  return {
    registeredTools,
    eventHandlers,
    exec: vi.fn(),
    appendEntry: vi.fn(),
    registerTool: (tool: any) => registeredTools.set(tool.name, tool),
    on: (event: string, handler: EventHandler) => {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler);
      eventHandlers.set(event, list);
    },
  };
}

describe("index.ts (Extension Harness)", () => {
  let pi: MockExtensionAPI;

  beforeEach(() => {
    setWorktreeState("", "", "main", "main");
    initOriginalCwd("/orig/repo");
    setEffectiveCwd("/orig/repo");
    pi = makeMockPi();
    plugin(pi as any);
  });

  describe("tool_call interceptor", () => {
    it("is active only when effectiveCwd differs from originalCwd", () => {
      const handler = pi.eventHandlers.get("tool_call")?.[0];
      expect(handler).toBeDefined();

      // Same cwd -> no interception
      const event = { toolName: "bash", input: { command: "ls" } };
      handler?.(event, {});
      expect(event.input.command).toBe("ls");

      // Different cwd -> command is prefixed
      setEffectiveCwd("/orig/repo/.worktrees/feat");
      handler?.(event, {});
      expect(event.input.command).toContain("cd '/orig/repo/.worktrees/feat' && ls");
    });

    it("(Q3/guards) handles non-string, missing, or invalid input safely across all tools", () => {
      const handler = pi.eventHandlers.get("tool_call")?.[0];
      setEffectiveCwd("/orig/repo/.worktrees/feat");

      // Non-object inputs survive across all tools
      for (const input of [undefined, null, "string", 42]) {
        for (const toolName of ["bash", "read", "write", "edit", "grep", "find", "ls"]) {
          expect(() => handler?.({ toolName, input }, {})).not.toThrow();
        }
      }

      // Invalid or missing path values survive across file tools
      for (const toolName of ["read", "write", "edit", "grep", "find", "ls"]) {
        for (const path of [undefined, null, 12345]) {
          expect(() => handler?.({ toolName, input: { path } }, {})).not.toThrow();
        }
      }

      // bash with non-string command is not corrupted
      const ev: { toolName: string; input: unknown } = { toolName: "bash", input: {} };
      handler?.(ev, {});
      expect((ev.input as { command?: unknown }).command).toBeUndefined();
    });
  });

  describe("before_agent_start hook (D-02)", () => {
    it("points systemPromptOptions.cwd at the effective worktree cwd and returns undefined", () => {
      const handler = pi.eventHandlers.get("before_agent_start")?.[0];
      expect(handler).toBeDefined();

      setEffectiveCwd("/orig/repo/.worktrees/feat");
      const event = {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: "You are an assistant.\n\n<cwd>\n/orig/repo\n</cwd>",
        systemPromptOptions: { cwd: "/orig/repo" },
      };

      const result = handler?.(event, {});
      expect(event.systemPromptOptions.cwd).toBe("/orig/repo/.worktrees/feat");
      expect(result).toBeUndefined();
    });

    it("leaves systemPromptOptions.cwd untouched when effectiveCwd equals originalCwd", () => {
      const handler = pi.eventHandlers.get("before_agent_start")?.[0];
      expect(handler).toBeDefined();

      // effectiveCwd === originalCwd ("/orig/repo")
      const event = {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: "You are an assistant.\n\n<cwd>\n/orig/repo\n</cwd>",
        systemPromptOptions: { cwd: "/orig/repo" },
      };

      const result = handler?.(event, {});
      expect(event.systemPromptOptions.cwd).toBe("/orig/repo");
      expect(result).toBeUndefined();
    });
  });

  describe("session_shutdown hook (Q2)", () => {
    it("skips interactive question prompt when stdin is not a TTY", async () => {
      const shutdownHandler = pi.eventHandlers.get("session_shutdown")?.[0];
      expect(shutdownHandler).toBeDefined();

      const createInterfaceMock = vi.mocked(readlinePromises.createInterface);
      createInterfaceMock.mockClear();

      // Set up a session branch with a touched worktree
      const branchEntries = [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "worktree_create",
            details: {
              branch: "feat-test",
              path: "/orig/repo/.worktrees/feat-test",
              mainRepo: "/orig/repo",
            },
          },
        },
      ];

      const mockCtx = {
        cwd: "/orig/repo",
        sessionManager: {
          getBranch: () => branchEntries,
        },
      };

      // Mock git worktree list to return the touched worktree so cleanup candidates exist
      pi.exec.mockImplementation(async (bin: string, args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return {
            stdout:
              "worktree /orig/repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
              "worktree /orig/repo/.worktrees/feat-test\nHEAD 5678\nbranch refs/heads/feat-test\n\n",
            code: 0,
          };
        }
        return { stdout: "", code: 0 };
      });

      // Save and override stdin.isTTY to false (non-interactive / CI / headless)
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

      try {
        await shutdownHandler?.({ reason: "quit" }, mockCtx);
        // Under Q2, readline.createInterface must NOT be called when !isTTY
        expect(createInterfaceMock).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });
  });

  describe("ensureWorktreesExcluded (I5)", () => {
    it("respects custom baseDir and writes custom pattern into info/exclude", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "pi-exclude-test-"));
      try {
        const gitDir = join(tempDir, ".git");
        const excludeDir = join(gitDir, "info");
        const excludePath = join(excludeDir, "exclude");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(excludeDir, { recursive: true });
        writeFileSync(excludePath, "# Existing excludes\nnode_modules/\n");

        const mockExec = vi.fn().mockImplementation(async (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
            return { stdout: gitDir + "\n", code: 0 };
          }
          return { stdout: "", code: 0 };
        });

        // Pass a custom baseDir ".wt/" located inside the repo
        const customBaseDir = join(tempDir, ".wt/");
        await ensureWorktreesExcluded(mockExec, tempDir, customBaseDir);

        const content = readFileSync(excludePath, "utf-8");
        // Under I5, .wt/ must be excluded; currently it writes .worktrees/
        expect(content).toContain(".wt/\n");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("does not duplicate an already-registered pattern", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "pi-exclude-dupe-"));
      try {
        const gitDir = join(tempDir, ".git");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(join(gitDir, "info"), { recursive: true });
        const excludePath = join(gitDir, "info", "exclude");
        writeFileSync(excludePath, "# Existing excludes\n.wt/\n");

        const mockExec = vi.fn().mockImplementation(async (args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
            return { stdout: gitDir + "\n", code: 0 };
          }
          return { stdout: "", code: 0 };
        });

        const customBaseDir = join(tempDir, ".wt/");
        await ensureWorktreesExcluded(mockExec, tempDir, customBaseDir);
        await ensureWorktreesExcluded(mockExec, tempDir, customBaseDir);

        const lines = readFileSync(excludePath, "utf-8").split("\n");
        expect(lines.filter((l) => l === ".wt/").length).toBe(1);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("worktree_switch -> .git/info/exclude (B)", () => {
    it("excludes the base dir even when switchWorktree takes an internal path", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "pi-switch-exclude-"));
      try {
        const gitDir = join(tempDir, ".git");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(join(gitDir, "info"), { recursive: true });
        const excludePath = join(gitDir, "info", "exclude");
        writeFileSync(excludePath, "# existing\n");
        const countLines = () =>
          readFileSync(excludePath, "utf-8").split("\n").filter((l) => l.length > 0).length;

        pi.exec.mockImplementation(async (_bin: string, args: string[]) => {
          if (args[0] === "worktree" && args[1] === "list") {
            return { stdout: `worktree ${tempDir}\nHEAD 1234\nbranch refs/heads/main\n\n`, code: 0 };
          }
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
            return { stdout: gitDir + "\n", code: 0 };
          }
          return { stdout: "", code: 1 };
        });

        const switchTool = pi.registeredTools.get("worktree_switch");
        const first = await switchTool.execute("c1", { branch: "main" }, null, null, {
          cwd: tempDir,
        });
        expect(first.details.mainRepo).toBe(tempDir);
        // Exactly one pattern appended — this only happens via ensureWorktreesExcluded.
        expect(countLines()).toBe(2);

        // Idempotent: a second switch must not append a duplicate.
        await switchTool.execute("c2", { branch: "main" }, null, null, { cwd: tempDir });
        expect(countLines()).toBe(2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("tool registration & dispatch (G1)", () => {
    it("registers the 4 worktree tools with expected names and schemas", () => {
      expect(pi.registeredTools.has("worktree_list")).toBe(true);
      expect(pi.registeredTools.has("worktree_create")).toBe(true);
      expect(pi.registeredTools.has("worktree_switch")).toBe(true);
      expect(pi.registeredTools.has("worktree_cleanup")).toBe(true);

      const createTool = pi.registeredTools.get("worktree_create");
      expect(createTool.parameters.properties.branch).toBeDefined();

      const switchTool = pi.registeredTools.get("worktree_switch");
      expect(switchTool.parameters.properties.branch).toBeDefined();

      const cleanupTool = pi.registeredTools.get("worktree_cleanup");
      expect(cleanupTool.parameters.properties.branch).toBeDefined();
      expect(cleanupTool.parameters.properties.repo).toBeDefined();
    });

    it("dispatches worktree_list tool execution to listWorktrees", async () => {
      const listTool = pi.registeredTools.get("worktree_list");
      expect(listTool).toBeDefined();

      // Mock git worktree list porcelain response
      pi.exec.mockImplementation(async (bin: string, args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return {
            stdout: "worktree /orig/repo\nHEAD 1234\nbranch refs/heads/main\n\n",
            code: 0,
          };
        }
        if (args[0] === "symbolic-ref") {
          return { stdout: "refs/remotes/origin/main\n", code: 0 };
        }
        return { stdout: "", code: 0 };
      });

      const res = await listTool.execute("call-1", {}, null, null, { cwd: "/orig/repo" });
      expect(res.content[0].text).toContain("Found 1 worktree(s):");
      expect(res.details.mainRepo).toBe("/orig/repo");
    });

    it("dispatches worktree_cleanup with default repo (getEffectiveCwd)", async () => {
      const cleanupTool = pi.registeredTools.get("worktree_cleanup");
      expect(cleanupTool).toBeDefined();

      pi.exec.mockImplementation(async (_bin: string, args: string[], opts?: { cwd?: string }) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return {
            stdout:
              "worktree /orig/repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
              "worktree /orig/repo/.worktrees/feat\nHEAD 5678\nbranch refs/heads/feat\n\n",
            code: 0,
          };
        }
        if (args[0] === "symbolic-ref") return { stdout: "refs/remotes/origin/main\n", code: 0 };
        if (args[0] === "status") return { stdout: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "remove") return { stdout: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "prune") return { stdout: "", code: 0 };
        if (args[0] === "branch" && args[1] === "-d") return { stdout: "", code: 0 };
        return { stdout: "", code: 0 };
      });

      const res = await cleanupTool.execute("call-2", { branch: "feat" }, null, null, {
        cwd: "/different/dir",
      });
      expect(res.content[0].text).toContain("Cleaned up worktree 'feat'.");
      expect(res.details.mainRepo).toBe("/orig/repo");
    });

    it("dispatches worktree_cleanup with explicit repo parameter", async () => {
      const cleanupTool = pi.registeredTools.get("worktree_cleanup");
      expect(cleanupTool).toBeDefined();

      const executedCwds: string[] = [];
      pi.exec.mockImplementation(async (_bin: string, args: string[], opts?: { cwd?: string }) => {
        if (opts?.cwd) executedCwds.push(opts.cwd);
        if (args[0] === "worktree" && args[1] === "list") {
          return {
            stdout:
              "worktree /custom/repo\nHEAD 1234\nbranch refs/heads/main\n\n" +
              "worktree /custom/repo/.worktrees/feat\nHEAD 5678\nbranch refs/heads/feat\n\n",
            code: 0,
          };
        }
        if (args[0] === "symbolic-ref") return { stdout: "refs/remotes/origin/main\n", code: 0 };
        if (args[0] === "status") return { stdout: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "remove") return { stdout: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "prune") return { stdout: "", code: 0 };
        if (args[0] === "branch" && args[1] === "-d") return { stdout: "", code: 0 };
        return { stdout: "", code: 0 };
      });

      const res = await cleanupTool.execute(
        "call-3",
        { branch: "feat", repo: "/custom/repo" },
        null,
        null,
        { cwd: "/orig/repo" },
      );
      expect(res.content[0].text).toContain("Cleaned up worktree 'feat'.");
      expect(res.details.mainRepo).toBe("/custom/repo");
      expect(executedCwds).toContain("/custom/repo");
    });
  });

  describe("session_shutdown candidates collection (G2)", () => {
    it("ignores shutdown when reason is not quit", async () => {
      const shutdownHandler = pi.eventHandlers.get("session_shutdown")?.[0];
      const mockCtx = {
        cwd: "/orig/repo",
        sessionManager: { getBranch: vi.fn() },
      };

      await shutdownHandler?.({ reason: "reload" }, mockCtx);
      expect(mockCtx.sessionManager.getBranch).not.toHaveBeenCalled();
    });

    it("collects touched branches/paths from session entries across create, switch, and custom types", async () => {
      const shutdownHandler = pi.eventHandlers.get("session_shutdown")?.[0];
      const branchEntries = [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "worktree_create",
            details: { branch: "feat-a", path: "/orig/repo/.worktrees/feat-a" },
          },
        },
        {
          type: "custom",
          customType: "cwd-change",
          data: { cwd: "/orig/repo/.worktrees/feat-b" },
        },
        {
          type: "custom",
          customType: "worktree-change",
          data: {
            currentBranch: "feat-c",
            currentWorktreePath: "/orig/repo/.worktrees/feat-c",
            mainRepoPath: "/orig/repo",
          },
        },
      ];

      const mockCtx = {
        cwd: "/orig/repo",
        sessionManager: { getBranch: () => branchEntries },
      };

      let listCalled = false;
      pi.exec.mockImplementation(async (bin: string, args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          listCalled = true;
          return {
            stdout: "worktree /orig/repo\nHEAD 1234\nbranch refs/heads/main\n\n",
            code: 0,
          };
        }
        return { stdout: "", code: 0 };
      });

      await shutdownHandler?.({ reason: "quit" }, mockCtx);
      expect(listCalled).toBe(true);
    });
  });
});
