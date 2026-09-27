import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  getEffectiveCwd,
  getOriginalCwd,
  resetWorktreeState,
} from "./state.js";

type EventHandler = (event: any, ctx: any) => Promise<any> | any;

interface MockExtensionAPI {
  registeredTools: Map<string, any>;
  eventHandlers: Map<string, EventHandler[]>;
  exec: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  registerTool: (tool: any) => void;
  on: (event: string, handler: EventHandler) => void;
}

function makeMockPi(): MockExtensionAPI {
  const registeredTools = new Map<string, any>();
  const eventHandlers = new Map<string, EventHandler[]>();

  return {
    registeredTools,
    eventHandlers,
    exec: vi.fn(),
    appendEntry: vi.fn(),
    registerTool(tool: any) {
      registeredTools.set(tool.name, tool);
    },
    on(event: string, handler: EventHandler) {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler);
      eventHandlers.set(event, list);
    },
  };
}

describe("index.ts (Extension Harness)", () => {
  let pi: MockExtensionAPI;

  beforeEach(() => {
    resetWorktreeState();
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

    it("(Q3) does not throw TypeError when input.path is undefined, non-string, or null", () => {
      const handler = pi.eventHandlers.get("tool_call")?.[0];
      setEffectiveCwd("/orig/repo/.worktrees/feat");

      // Required path tools (read, write, edit) with missing or invalid path
      for (const toolName of ["read", "write", "edit"]) {
        const evUndefined = { toolName, input: { path: undefined } };
        expect(() => handler?.(evUndefined, {})).not.toThrow();

        const evNumber = { toolName, input: { path: 12345 } };
        expect(() => handler?.(evNumber, {})).not.toThrow();

        const evNull = { toolName, input: { path: null } };
        expect(() => handler?.(evNull, {})).not.toThrow();
      }

      // Optional path tools (grep, find, ls) with invalid non-string path
      for (const toolName of ["grep", "find", "ls"]) {
        const evNumber = { toolName, input: { path: 12345 } };
        expect(() => handler?.(evNumber, {})).not.toThrow();

        const evNull = { toolName, input: { path: null } };
        expect(() => handler?.(evNull, {})).not.toThrow();
      }
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
  });
});
