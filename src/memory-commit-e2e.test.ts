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
  return handlers.find((entry) => entry.event === eventName)?.handler;
}

function getFirstText(result: AgentToolResult<unknown> | undefined): string {
  const first = result?.content[0];
  if (first?.type !== "text") {
    return "";
  }

  return first.text;
}

function createCtx(projectDir: string): ExtensionContext {
  return {
    cwd: projectDir,
    ui: createMockUi(),
    sessionManager: {
      getSessionFile: () => "/tmp/pi-memory-commit-e2e-session.jsonl",
    },
  } as unknown as ExtensionContext;
}

function createTurnLog(turnCount: number): string {
  return Array.from({ length: turnCount }, (_, index) =>
    serializeOtaEntry({
      turnNumber: index + 1,
      timestamp: `2026-03-25T08:${String(index + 1).padStart(2, "0")}:00Z`,
      model: "github-copilot/grok-code-fast-1",
      thought: `Recorded turn ${index + 1} for the memory_commit e2e test.`,
      thinking: "",
      actions: [],
      observations: [],
    }).trim()
  ).join("\n");
}

function setupInitializedProject(logContent: string): {
  projectDir: string;
  cleanup: () => void;
} {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "memory-commit-e2e-")
  );
  const memoryDir = path.join(projectDir, ".memory");
  const branchDir = path.join(memoryDir, "branches", "main");

  fs.mkdirSync(branchDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "state.yaml"),
    ["active_branch: main", 'initialized: "2026-03-25T08:00:00Z"'].join("\n")
  );
  fs.writeFileSync(path.join(memoryDir, "AGENTS.md"), "# Brain Protocol\n");
  fs.writeFileSync(
    path.join(memoryDir, "main.md"),
    "# Roadmap\n\nTest roadmap.\n"
  );
  fs.writeFileSync(path.join(branchDir, "log.jsonl"), `${logContent}\n`);
  fs.writeFileSync(path.join(branchDir, "commits.jsonl"), "");
  fs.writeFileSync(path.join(branchDir, "metadata.json"), "{}\n");
  fs.writeFileSync(
    path.join(branchDir, "commit-context.json"),
    `${JSON.stringify(
      {
        version: 1,
        branchPurpose: "Main memory branch.",
        previousProgressSummary: "Initial commit.",
        latestContributionBullets: [],
      },
      null,
      2
    )}\n`
  );
  fs.mkdirSync(path.join(projectDir, ".pi", "extensions"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectDir, ".pi", "extensions", "pi-brain.json"),
    JSON.stringify({
      committerModel: "github-copilot/grok-code-fast-1",
    })
  );

  return {
    projectDir,
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

describe("memory_commit e2e", () => {
  beforeEach(() => {
    spawnCommitterSdkMock.mockReset();
  });

  it("should complete a single-pass memory_commit through the real extension flow", async () => {
    const { projectDir, cleanup } = setupInitializedProject(createTurnLog(1));

    try {
      spawnCommitterSdkMock.mockResolvedValue({
        text: JSON.stringify({
          branchPurpose: "Preserve durable memory for the e2e-tested branch.",
          previousProgressSummary: "Initial commit.",
          thisCommitContributionBullets: [
            "Verified the memory_commit SDK path end-to-end through the extension.",
          ],
        }),
        exitCode: 0,
      });

      const mockPi = createMockPi();
      activate(mockPi.api);

      const ctx = createCtx(projectDir);
      const sessionStart = getHandler(mockPi.handlers, "session_start");
      await sessionStart?.({ type: "session_start" }, ctx);

      const memoryCommit = mockPi.tools.find(
        (tool) => tool.name === "memory_commit"
      );
      expect(memoryCommit).toBeDefined();

      const updates: string[] = [];
      const result = await memoryCommit?.execute(
        "tc-memory-commit-e2e-single",
        {
          summary: "Single-pass e2e test checkpoint",
          update_roadmap: false,
        },
        undefined,
        (update) => {
          updates.push(getFirstText(update as AgentToolResult<unknown>));
        },
        ctx
      );

      const text = getFirstText(result);
      expect(text).toContain("Commit ");
      expect(text).toContain('written to branch "main"');
      expect(text).toContain("# Memory Status");
      expect(
        updates.some(
          (update) =>
            update.includes('Starting memory committer for branch "main"') &&
            update.includes("model github-copilot/grok-code-fast-1") &&
            update.includes("source project config")
        )
      ).toBeTruthy();
      expect(updates).toContain("Parsing distilled commit blocks...");
      expect(updates).toContain("Finalizing memory commit...");

      const logAfterCommit = fs.readFileSync(
        path.join(projectDir, ".memory", "branches", "main", "log.jsonl"),
        "utf8"
      );
      const commitsAfterCommit = fs.readFileSync(
        path.join(projectDir, ".memory", "branches", "main", "commits.jsonl"),
        "utf8"
      );

      expect(logAfterCommit).toBe("");
      expect(commitsAfterCommit).toContain('"kind":"commit"');
      expect(commitsAfterCommit).toContain(
        "Verified the memory_commit SDK path end-to-end through the extension."
      );
      expect(spawnCommitterSdkMock).toHaveBeenCalledOnce();
      expect(spawnCommitterSdkMock.mock.calls[0]?.[1]).toContain(
        'Distill a memory commit for branch "main".'
      );
    } finally {
      cleanup();
    }
  });

  it("should complete a chunked memory_commit through the real extension flow", async () => {
    const { projectDir, cleanup } = setupInitializedProject(createTurnLog(5));

    try {
      spawnCommitterSdkMock.mockImplementation(
        async (_cwd: string, task: string) => {
          if (task.includes("Distill Chunk 1 of 2")) {
            return {
              text: JSON.stringify({
                summaryBullets: ["Summarized chunk one."],
              }),
              exitCode: 0,
            };
          }

          if (task.includes("Distill Chunk 2 of 2")) {
            return {
              text: JSON.stringify({
                summaryBullets: ["Summarized chunk two."],
              }),
              exitCode: 0,
            };
          }

          return {
            text: JSON.stringify({
              summaryBullets: [
                "Combined chunk summaries into the final commit.",
              ],
            }),
            exitCode: 0,
          };
        }
      );

      const mockPi = createMockPi();
      activate(mockPi.api);

      const ctx = createCtx(projectDir);
      const sessionStart = getHandler(mockPi.handlers, "session_start");
      await sessionStart?.({ type: "session_start" }, ctx);

      const memoryCommit = mockPi.tools.find(
        (tool) => tool.name === "memory_commit"
      );
      expect(memoryCommit).toBeDefined();

      const result = await memoryCommit?.execute(
        "tc-memory-commit-e2e-chunked",
        {
          summary: "Chunked e2e test checkpoint",
          update_roadmap: false,
        },
        undefined,
        undefined,
        ctx
      );

      const text = getFirstText(result);
      expect(text).toContain("Commit ");
      expect(text).toContain('written to branch "main"');
      expect(spawnCommitterSdkMock).toHaveBeenCalledTimes(3);
      expect(spawnCommitterSdkMock.mock.calls[0]?.[1]).toContain(
        'Distill Chunk 1 of 2 for branch "main".'
      );
      expect(spawnCommitterSdkMock.mock.calls[1]?.[1]).toContain(
        'Distill Chunk 2 of 2 for branch "main".'
      );
      expect(spawnCommitterSdkMock.mock.calls[2]?.[1]).toContain(
        'Synthesize the final contribution for branch "main".'
      );

      const commitsAfterCommit = fs.readFileSync(
        path.join(projectDir, ".memory", "branches", "main", "commits.jsonl"),
        "utf8"
      );
      expect(commitsAfterCommit).toContain('"kind":"commit"');
      expect(commitsAfterCommit).toContain(
        "Combined chunk summaries into the final commit."
      );
    } finally {
      cleanup();
    }
  });
});
