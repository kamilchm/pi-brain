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
import { serializeOtaEntry } from "./structured-memory.js";
import type * as SubagentSdkModule from "./subagent-sdk.js";

const spawnCommitterSdkMock = vi.hoisted(() => vi.fn());

vi.mock(import("./subagent-sdk.js"), async (importOriginal) => {
  const actual = (await importOriginal()) as typeof SubagentSdkModule;
  return {
    ...actual,
    spawnCommitterSdk: spawnCommitterSdkMock,
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
    path.join(branchDir, "log.jsonl"),
    serializeOtaEntry({
      turnNumber: 1,
      timestamp: "2026-02-23T02:00:00Z",
      model: "anthropic/claude",
      thought: "investigate memory commit latency",
      thinking: "",
      actions: [],
      observations: [],
    })
  );
  fs.writeFileSync(path.join(branchDir, "commits.jsonl"), "");
  fs.writeFileSync(path.join(branchDir, "metadata.json"), "{}\n");
  fs.writeFileSync(
    path.join(branchDir, "commit-context.json"),
    `${JSON.stringify(
      {
        version: 1,
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        latestContributionBullets: [],
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(memoryDir, "main.md"),
    "# Roadmap\n\nCurrent state.\n"
  );
  fs.mkdirSync(path.join(projectDir, ".pi", "extensions"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectDir, ".pi", "extensions", "pi-brain.json"),
    JSON.stringify({ committerModel: "github-copilot/grok-code-fast-1" })
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
    spawnCommitterSdkMock.mockReset();
    spawnCommitterSdkMock.mockImplementation(
      async (
        _cwd: string,
        _task: string,
        options?: {
          onProgress?: (progress: {
            stage: string;
            message: string;
            elapsedMs: number;
            operation?: string;
          }) => void;
        }
      ) => {
        options?.onProgress?.({
          stage: "spawned",
          message: "Started memory committer SDK session.",
          elapsedMs: 5,
          operation: "single_pass",
        });
        options?.onProgress?.({
          stage: "loading_resources",
          message: "Reloaded SDK resources.",
          elapsedMs: 12,
          operation: "single_pass",
        });
        options?.onProgress?.({
          stage: "creating_session",
          message: "Created memory committer SDK session.",
          elapsedMs: 25,
          operation: "single_pass",
        });
        options?.onProgress?.({
          stage: "stdout",
          message: "Memory committer produced output.",
          elapsedMs: 40,
          operation: "single_pass",
        });
        options?.onProgress?.({
          stage: "finished",
          message: "Memory committer finished successfully.",
          elapsedMs: 50,
          operation: "single_pass",
        });

        return {
          text: JSON.stringify({
            branchPurpose: "Investigate memory commit responsiveness.",
            previousProgressSummary: "Initial commit.",
            thisCommitContributionBullets: [
              "Tracked SDK stage timings in progress updates.",
            ],
          }),
          exitCode: 0,
        };
      }
    );
  });

  it("should stream progress updates from the SDK committer", async () => {
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

      const updates: { text: string; details: unknown }[] = [];
      const result = await memoryCommit?.execute(
        "tc-memory-commit-progress",
        {
          summary: "Track SDK stages",
          update_roadmap: false,
        },
        undefined,
        (update) => {
          updates.push({
            text: getFirstText(update as AgentToolResult<unknown>),
            details: (update as AgentToolResult<unknown>).details,
          });
        },
        ctx
      );

      expect(getFirstText(result as AgentToolResult<unknown>)).toContain(
        'written to branch "main"'
      );
      expect(
        updates.some((u) =>
          u.text.includes('Starting memory committer for branch "main"')
        )
      ).toBeTruthy();
      expect(updates.map((u) => u.text)).toContain(
        "Parsing distilled commit blocks..."
      );
      expect(updates.map((u) => u.text)).toContain(
        "Finalizing memory commit..."
      );
      expect(
        updates.some(
          (u) =>
            typeof u.details === "object" &&
            u.details !== null &&
            (u.details as { stage?: string }).stage === "spawned"
        )
      ).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});
