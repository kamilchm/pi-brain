import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import activate from "./index.js";
import type * as SubagentModule from "./subagent.js";

const spawnCommitterMock = vi.hoisted(() => vi.fn());

vi.mock(import("./subagent.js"), async (importOriginal) => {
  const actual = (await importOriginal()) as typeof SubagentModule;
  return {
    ...actual,
    spawnCommitter: spawnCommitterMock,
  };
});

interface RegisteredHandler {
  event: string;
  handler: (event: unknown, ctx: ExtensionContext) => unknown;
}

interface MockUi {
  notifications: { message: string; type: "info" | "warning" | "error" }[];
  statuses: Map<string, string | undefined>;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  setStatus: (key: string, text: string | undefined) => void;
}

interface MockPi {
  tools: ToolDefinition[];
  handlers: RegisteredHandler[];
  api: ExtensionAPI;
}

function createMockUi(): MockUi {
  const notifications: {
    message: string;
    type: "info" | "warning" | "error";
  }[] = [];
  const statuses = new Map<string, string | undefined>();

  return {
    notifications,
    statuses,
    notify(message: string, type: "info" | "warning" | "error" = "info") {
      notifications.push({ message, type });
    },
    setStatus(key: string, text: string | undefined) {
      if (text === undefined) {
        statuses.delete(key);
      } else {
        statuses.set(key, text);
      }
    },
  };
}

function createMockPi(): MockPi {
  const tools: ToolDefinition[] = [];
  const handlers: RegisteredHandler[] = [];

  const api = {
    registerTool(def: ToolDefinition) {
      tools.push(def);
    },
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown
    ) {
      handlers.push({ event, handler });
    },
  } as unknown as ExtensionAPI;

  return { tools, handlers, api };
}

function getHandler(
  handlers: RegisteredHandler[],
  eventName: string
): ((event: unknown, ctx: ExtensionContext) => unknown) | undefined {
  return handlers.find((handler) => handler.event === eventName)?.handler;
}

function setupInitializedProject(): {
  projectDir: string;
  cleanup: () => void;
} {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "memory-commit-progress-test-")
  );
  const memoryDir = path.join(projectDir, ".memory");
  const branchDir = path.join(memoryDir, "branches", "main");

  fs.mkdirSync(branchDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "state.yaml"),
    [
      "active_branch: main",
      'initialized: "2026-02-23T00:00:00Z"',
      "last_commit:",
      "  branch: main",
      "  hash: a1b2c3d4",
      '  timestamp: "2026-02-23T00:30:00Z"',
      '  summary: "Initial foundation"',
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(branchDir, "log.md"),
    [
      "## Turn 1 | 2026-02-23T02:00:00Z | anthropic/claude",
      "",
      "**Thought**: investigate memory commit latency",
      "",
    ].join("\n")
  );
  fs.writeFileSync(path.join(branchDir, "commits.md"), "# main\n\n");
  fs.writeFileSync(path.join(branchDir, "metadata.yaml"), "");
  fs.writeFileSync(
    path.join(memoryDir, "main.md"),
    "# Roadmap\n\nCurrent state.\n"
  );

  return {
    projectDir,
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

function createCtx(projectDir: string): ExtensionContext {
  return {
    cwd: projectDir,
    ui: createMockUi(),
    sessionManager: {
      getSessionFile: () => "/tmp/pi-session-test.jsonl",
    },
  } as unknown as ExtensionContext;
}

function getFirstText(result: AgentToolResult<unknown>): string {
  const [first] = result.content;
  if (first?.type !== "text") {
    return "";
  }

  return first.text;
}

describe("memory_commit progress", () => {
  beforeEach(() => {
    spawnCommitterMock.mockReset();
    spawnCommitterMock.mockImplementation(
      async (
        _cwd: string,
        _task: string,
        options?: {
          onProgress?: (progress: {
            stage: string;
            message: string;
            elapsedMs: number;
            pid?: number;
            exitCode?: number;
          }) => void;
        }
      ) => {
        options?.onProgress?.({
          stage: "spawned",
          message: "Started memory committer process.",
          elapsedMs: 5,
          pid: 4321,
        });
        options?.onProgress?.({
          stage: "stdout",
          message: "Memory committer produced output.",
          elapsedMs: 20,
        });
        options?.onProgress?.({
          stage: "finished",
          message: "Memory committer finished successfully.",
          elapsedMs: 30,
          exitCode: 0,
        });

        return {
          text: [
            "### Branch Purpose",
            "",
            "Investigate memory commit responsiveness.",
            "",
            "### Previous Progress Summary",
            "",
            "Initial commit.",
            "",
            "### This Commit's Contribution",
            "",
            "- Added visible progress reporting for memory_commit.",
          ].join("\n"),
          exitCode: 0,
        };
      }
    );
  });

  it("should stream visible progress updates while memory_commit runs", async () => {
    const { projectDir, cleanup } = setupInitializedProject();

    try {
      const mockPi = createMockPi();
      activate(mockPi.api);

      const ctx = createCtx(projectDir);
      const sessionStart = getHandler(mockPi.handlers, "session_start");
      await sessionStart?.({ type: "session_start" }, ctx);

      const memoryCommit = mockPi.tools.find(
        (tool) => tool.name === "memory_commit"
      );
      expect(memoryCommit).toBeDefined();

      const updates: AgentToolResult<unknown>[] = [];
      const onUpdate = (update: AgentToolResult<unknown>) => {
        updates.push(update);
      };

      const result = await memoryCommit?.execute(
        "tc-memory-commit-progress",
        { summary: "Investigate commit visibility" },
        undefined,
        onUpdate,
        ctx
      );

      expect(result).toBeDefined();
      expect(getFirstText(result as AgentToolResult<unknown>)).toContain(
        "Commit "
      );

      const updateTexts = updates.map((update) => getFirstText(update));
      expect(updateTexts[0]).toContain("Starting memory committer");
      expect(updateTexts[0]).toContain('branch "main"');
      expect(updateTexts).toContain("Started memory committer process.");
      expect(updateTexts).toContain("Memory committer produced output.");
      expect(updateTexts).toContain("Memory committer finished successfully.");
      expect(updateTexts).toContain("Parsing distilled commit blocks...");
      expect(updateTexts).toContain("Finalizing memory commit...");
    } finally {
      cleanup();
    }
  });
});
