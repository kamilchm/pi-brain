import type * as PiCodingAgent from "@mariozechner/pi-coding-agent";

import { MemoryCommitOperation } from "./enums.js";
import {
  parseChunkSummarySubmission,
  parseCommitBlocksSubmission,
} from "./structured-memory.js";
import { spawnCommitterSdk } from "./subagent-sdk.js";

const createAgentSessionMock = vi.hoisted(() => vi.fn());
const createReadOnlyToolsMock = vi.hoisted(() => vi.fn());
const authStorageCreateMock = vi.hoisted(() => vi.fn());
const modelRegistryGetAllMock = vi.hoisted(() => vi.fn());
const resourceLoaderReloadMock = vi.hoisted(() => vi.fn());

vi.mock(
  import("@mariozechner/pi-coding-agent"),
  async (): Promise<Partial<typeof PiCodingAgent>> => {
    const MockModelRegistry = vi
      .fn()
      .mockImplementation(function MockModelRegistry(
        this: {
          authStorage: unknown;
          getAll: () => unknown[];
        },
        authStorage: unknown
      ) {
        this.authStorage = authStorage;
        this.getAll = () => modelRegistryGetAllMock();
      });

    const MockDefaultResourceLoader = vi
      .fn()
      .mockImplementation(function MockDefaultResourceLoader(
        this: {
          options: unknown;
          reload: () => Promise<void>;
        },
        options: unknown
      ) {
        this.options = options;
        this.reload = async () => {
          resourceLoaderReloadMock(this.options);
        };
      });

    return {
      AuthStorage: {
        create: authStorageCreateMock,
      } as unknown as typeof PiCodingAgent.AuthStorage,
      createAgentSession: createAgentSessionMock,
      createReadOnlyTools: createReadOnlyToolsMock,
      DefaultResourceLoader:
        MockDefaultResourceLoader as unknown as typeof PiCodingAgent.DefaultResourceLoader,
      ModelRegistry:
        MockModelRegistry as unknown as typeof PiCodingAgent.ModelRegistry,
      SessionManager: {
        inMemory() {
          return { kind: "session-manager" };
        },
      } as unknown as typeof PiCodingAgent.SessionManager,
      SettingsManager: {
        inMemory(settings: unknown) {
          return { kind: "settings-manager", settings };
        },
      } as unknown as typeof PiCodingAgent.SettingsManager,
    };
  }
);

function emitEvent(
  listeners: ((event: unknown) => void)[],
  event: unknown
): void {
  for (const listener of listeners) {
    listener(event);
  }
}

describe("spawnCommitterSdk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createAgentSessionMock.mockReset();
    createReadOnlyToolsMock.mockReset();
    authStorageCreateMock.mockReset();
    modelRegistryGetAllMock.mockReset();
    resourceLoaderReloadMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should require the structured commit-block tool and return its serialized JSON", async () => {
    const listeners: ((event: unknown) => void)[] = [];
    const disposeMock = vi.fn();
    let customTools: PiCodingAgent.ToolDefinition[] = [];

    const promptMock = vi.fn(async () => {
      const submitTool = customTools.find(
        (tool) => tool.name === "submit_memory_commit_blocks"
      );
      expect(submitTool).toBeDefined();

      emitEvent(listeners, {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "submit_memory_commit_blocks" }],
        },
      });

      await submitTool?.execute(
        "tc-submit-commit-blocks",
        {
          branchPurpose: "Preserve durable project memory.",
          previousProgressSummary:
            "Existing milestones are retained in rolling summary form.",
          thisCommitContributionBullets: [
            "Captured the latest branch conclusions.",
            "Recorded the rationale for the chosen direction.",
          ],
        },
        undefined,
        undefined,
        {} as PiCodingAgent.ExtensionContext
      );

      emitEvent(listeners, { type: "agent_end", messages: [] });
    });

    createReadOnlyToolsMock.mockReturnValue([{ name: "read" }]);
    authStorageCreateMock.mockReturnValue({ kind: "auth" });
    modelRegistryGetAllMock.mockReturnValue([
      {
        provider: "github-copilot",
        id: "grok-code-fast-1",
        reasoning: true,
      },
    ]);
    createAgentSessionMock.mockImplementation(async (args: unknown) => {
      customTools =
        (args as { customTools?: PiCodingAgent.ToolDefinition[] })
          .customTools ?? [];

      return {
        session: {
          subscribe(listener: (event: unknown) => void) {
            listeners.push(listener);
            return () => {};
          },
          prompt: promptMock,
          abort: vi.fn(),
          dispose: disposeMock,
        },
        extensionsResult: { extensions: [], errors: [], runtime: {} },
      };
    });

    const result = await spawnCommitterSdk(process.cwd(), "distill", {
      model: "github-copilot/grok-code-fast-1",
    });

    expect(result.exitCode).toBe(0);
    expect(parseCommitBlocksSubmission(result.text)).toStrictEqual({
      branchPurpose: "Preserve durable project memory.",
      previousProgressSummary:
        "Existing milestones are retained in rolling summary form.",
      thisCommitContributionBullets: [
        "Captured the latest branch conclusions.",
        "Recorded the rationale for the chosen direction.",
      ],
    });
    expect(createReadOnlyToolsMock).toHaveBeenCalledWith(process.cwd());
    expect(resourceLoaderReloadMock).toHaveBeenCalledOnce();
    expect(resourceLoaderReloadMock.mock.calls[0]?.[0]).toMatchObject({
      appendSystemPrompt: expect.stringContaining(
        "Your response is invalid unless you call the tool `submit_memory_commit_blocks`"
      ),
    });
    expect(promptMock).toHaveBeenCalledWith("Task: distill");
    expect(customTools.map((tool) => tool.name)).toStrictEqual([
      "submit_memory_commit_blocks",
    ]);
    expect(disposeMock).toHaveBeenCalledOnce();
  });

  it("should return serialized structured chunk summaries from the chunk-summary tool", async () => {
    const listeners: ((event: unknown) => void)[] = [];
    const disposeMock = vi.fn();
    let customTools: PiCodingAgent.ToolDefinition[] = [];

    const promptMock = vi.fn(async () => {
      const submitTool = customTools.find(
        (tool) => tool.name === "submit_memory_chunk_summary"
      );
      expect(submitTool).toBeDefined();

      emitEvent(listeners, {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "submit_memory_chunk_summary" }],
        },
      });

      await submitTool?.execute(
        "tc-submit-chunk-summary",
        {
          summaryBullets: [
            "Captured the decision made in this chunk.",
            "Recorded one rejected alternative.",
          ],
        },
        undefined,
        undefined,
        {} as PiCodingAgent.ExtensionContext
      );

      emitEvent(listeners, { type: "agent_end", messages: [] });
    });

    createReadOnlyToolsMock.mockReturnValue([{ name: "read" }]);
    authStorageCreateMock.mockReturnValue({ kind: "auth" });
    modelRegistryGetAllMock.mockReturnValue([
      {
        provider: "github-copilot",
        id: "grok-code-fast-1",
        reasoning: true,
      },
    ]);
    createAgentSessionMock.mockImplementation(async (args: unknown) => {
      customTools =
        (args as { customTools?: PiCodingAgent.ToolDefinition[] })
          .customTools ?? [];

      return {
        session: {
          subscribe(listener: (event: unknown) => void) {
            listeners.push(listener);
            return () => {};
          },
          prompt: promptMock,
          abort: vi.fn(),
          dispose: disposeMock,
        },
        extensionsResult: { extensions: [], errors: [], runtime: {} },
      };
    });

    const result = await spawnCommitterSdk(process.cwd(), "distill chunk", {
      model: "github-copilot/grok-code-fast-1",
      operation: MemoryCommitOperation.ChunkDistill,
    });

    expect(result.exitCode).toBe(0);
    expect(parseChunkSummarySubmission(result.text)).toStrictEqual({
      summaryBullets: [
        "Captured the decision made in this chunk.",
        "Recorded one rejected alternative.",
      ],
    });
    expect(resourceLoaderReloadMock.mock.calls[0]?.[0]).toMatchObject({
      appendSystemPrompt: expect.stringContaining(
        "Your response is invalid unless you call the tool `submit_memory_chunk_summary`"
      ),
    });
    expect(customTools.map((tool) => tool.name)).toStrictEqual([
      "submit_memory_chunk_summary",
    ]);
    expect(disposeMock).toHaveBeenCalledOnce();
  });

  it("should return serialized contribution synthesis summaries", async () => {
    const listeners: ((event: unknown) => void)[] = [];
    let customTools: PiCodingAgent.ToolDefinition[] = [];

    const promptMock = vi.fn(async () => {
      const submitTool = customTools.find(
        (tool) => tool.name === "submit_memory_chunk_summary"
      );
      expect(submitTool).toBeDefined();

      emitEvent(listeners, {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "submit_memory_chunk_summary" }],
        },
      });

      await submitTool?.execute(
        "tc-submit-contribution-summary",
        {
          summaryBullets: [
            "Synthesized the current uncommitted work.",
            "Kept only the final contribution bullets.",
          ],
        },
        undefined,
        undefined,
        {} as PiCodingAgent.ExtensionContext
      );

      emitEvent(listeners, { type: "agent_end", messages: [] });
    });

    createReadOnlyToolsMock.mockReturnValue([{ name: "read" }]);
    authStorageCreateMock.mockReturnValue({ kind: "auth" });
    modelRegistryGetAllMock.mockReturnValue([
      {
        provider: "github-copilot",
        id: "grok-code-fast-1",
        reasoning: true,
      },
    ]);
    createAgentSessionMock.mockImplementation(async (args: unknown) => {
      customTools =
        (args as { customTools?: PiCodingAgent.ToolDefinition[] })
          .customTools ?? [];

      return {
        session: {
          subscribe(listener: (event: unknown) => void) {
            listeners.push(listener);
            return () => {};
          },
          prompt: promptMock,
          abort: vi.fn(),
          dispose: vi.fn(),
        },
        extensionsResult: { extensions: [], errors: [], runtime: {} },
      };
    });

    const result = await spawnCommitterSdk(process.cwd(), "synthesize", {
      model: "github-copilot/grok-code-fast-1",
      operation: MemoryCommitOperation.ContributionSynthesis,
    });

    expect(result.exitCode).toBe(0);
    expect(parseChunkSummarySubmission(result.text)).toStrictEqual({
      summaryBullets: [
        "Synthesized the current uncommitted work.",
        "Kept only the final contribution bullets.",
      ],
    });
  });

  it("should fail clearly when the model finishes without submitting structured commit blocks", async () => {
    const listeners: ((event: unknown) => void)[] = [];

    createReadOnlyToolsMock.mockReturnValue([{ name: "read" }]);
    authStorageCreateMock.mockReturnValue({ kind: "auth" });
    modelRegistryGetAllMock.mockReturnValue([
      {
        provider: "github-copilot",
        id: "grok-code-fast-1",
        reasoning: true,
      },
    ]);
    createAgentSessionMock.mockResolvedValue({
      session: {
        subscribe(listener: (event: unknown) => void) {
          listeners.push(listener);
          return () => {};
        },
        prompt: async () => {
          emitEvent(listeners, {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "I forgot the tool call." }],
            },
          });
          emitEvent(listeners, { type: "agent_end", messages: [] });
        },
        abort: vi.fn(),
        dispose: vi.fn(),
      },
      extensionsResult: { extensions: [], errors: [], runtime: {} },
    });

    const result = await spawnCommitterSdk(process.cwd(), "distill", {
      model: "github-copilot/grok-code-fast-1",
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain(
      "SDK committer did not submit structured commit blocks"
    );
  });

  it("should abort the SDK session when it exceeds the timeout", async () => {
    const listeners: ((event: unknown) => void)[] = [];
    const abortMock = vi.fn();
    const disposeMock = vi.fn();

    createReadOnlyToolsMock.mockReturnValue([{ name: "read" }]);
    authStorageCreateMock.mockReturnValue({ kind: "auth" });
    modelRegistryGetAllMock.mockReturnValue([
      {
        provider: "github-copilot",
        id: "grok-code-fast-1",
        reasoning: true,
      },
    ]);
    createAgentSessionMock.mockResolvedValue({
      session: {
        subscribe(listener: (event: unknown) => void) {
          listeners.push(listener);
          return () => {};
        },
        prompt: () => new Promise<void>(() => {}),
        abort: abortMock,
        dispose: disposeMock,
      },
      extensionsResult: { extensions: [], errors: [], runtime: {} },
    });

    const resultPromise = spawnCommitterSdk(process.cwd(), "distill", {
      model: "github-copilot/grok-code-fast-1",
      timeoutMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;

    expect(result.exitCode).toBe(124);
    expect(result.error).toContain("Subagent timed out after");
    expect(abortMock).toHaveBeenCalledOnce();
    expect(disposeMock).toHaveBeenCalledOnce();
  });
});
