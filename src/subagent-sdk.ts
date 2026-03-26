import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  AuthStorage,
  createAgentSession,
  createReadOnlyTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

import { MemoryCommitOperation, MemoryCommitProgressStage } from "./enums.js";
import {
  serializeChunkSummarySubmission,
  serializeCommitBlocksSubmission,
} from "./structured-memory.js";
import {
  buildTimeoutDiagnosticSummary,
  getNormalizedCommitterTools,
  resolveAgentPrompt,
} from "./subagent.js";
import type {
  MemoryCommitBlocksSubmission,
  MemoryCommitProgress,
  MemoryChunkSummarySubmission,
  SpawnCommitterOptions,
  SubagentResult,
} from "./types.js";

const DEFAULT_COMMITTER_TIMEOUT_MS = 60_000;
const SUBMIT_MEMORY_COMMIT_BLOCKS_TOOL = "submit_memory_commit_blocks";
const SUBMIT_MEMORY_CHUNK_SUMMARY_TOOL = "submit_memory_chunk_summary";

type RegistryModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

interface StructuredOutputController {
  customTools: ToolDefinition[];
  resolveText(): string;
  waitForSubmission(): Promise<void>;
}

function getCommitterOperation(
  options: SpawnCommitterOptions | undefined
): MemoryCommitOperation {
  return options?.operation ?? MemoryCommitOperation.SinglePass;
}

function trimNonEmptyString(value: string): string {
  return value.trim();
}

function normalizeNonEmptyBullets(bullets: string[]): string[] {
  return bullets
    .map((bullet) => bullet.trim())
    .filter((bullet) => bullet !== "");
}

function createAbortOutcome(
  signal: AbortSignal | undefined
): Promise<{ kind: "aborted" }> | null {
  if (!signal) {
    return null;
  }

  return new Promise<{ kind: "aborted" }>((resolve) => {
    const handleAbort = () => {
      resolve({ kind: "aborted" });
    };

    if (signal.aborted) {
      handleAbort();
      return;
    }

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function buildStructuredOutputInstruction(
  operation: MemoryCommitOperation
): string {
  if (
    operation === MemoryCommitOperation.ChunkDistill ||
    operation === MemoryCommitOperation.ContributionSynthesis
  ) {
    return [
      "Your response is invalid unless you call the tool `submit_memory_chunk_summary`.",
      "You must finish by calling the tool `submit_memory_chunk_summary`.",
      "Do not respond with normal markdown or prose instead of the tool call.",
      "Do not answer with freeform prose.",
      operation === MemoryCommitOperation.ChunkDistill
        ? "Provide 1-3 concise bullets in `summaryBullets`."
        : "Provide 3-7 concise bullets in `summaryBullets`.",
    ].join("\n");
  }

  return [
    "Your response is invalid unless you call the tool `submit_memory_commit_blocks`.",
    "You must finish by calling the tool `submit_memory_commit_blocks`.",
    "Do not respond with normal markdown or prose instead of the tool call.",
    "Do not answer with freeform prose.",
    "Provide `branchPurpose`, `previousProgressSummary`, and `thisCommitContributionBullets`.",
  ].join("\n");
}

function buildSdkCommitterPrompt(
  basePrompt: string,
  operation: MemoryCommitOperation
): string {
  return [basePrompt, "", buildStructuredOutputInstruction(operation)].join(
    "\n"
  );
}

const submitMemoryCommitBlocksSchema = Type.Object({
  branchPurpose: Type.String({
    minLength: 1,
    description: "1-2 sentences restating what the branch is for.",
  }),
  previousProgressSummary: Type.String({
    minLength: 1,
    description:
      "A self-contained rolling summary synthesizing all previous commits.",
  }),
  thisCommitContributionBullets: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 7,
    description: "3-7 concise bullets for what this commit adds or concludes.",
  }),
});

const submitMemoryChunkSummarySchema = Type.Object({
  summaryBullets: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 7,
    description:
      "1-7 concise bullets for either a single chunk or the final synthesized contribution.",
  }),
});

type SubmitMemoryCommitBlocksParams = Static<
  typeof submitMemoryCommitBlocksSchema
>;
type SubmitMemoryChunkSummaryParams = Static<
  typeof submitMemoryChunkSummarySchema
>;

function createSubmitMemoryCommitBlocksTool(
  onSubmit: (submission: MemoryCommitBlocksSubmission) => void
): ToolDefinition<typeof submitMemoryCommitBlocksSchema> {
  return {
    name: SUBMIT_MEMORY_COMMIT_BLOCKS_TOOL,
    label: "Submit Memory Commit Blocks",
    description:
      "Submit the final structured Brain commit blocks as validated fields.",
    parameters: submitMemoryCommitBlocksSchema,
    execute(
      _toolCallId,
      params: SubmitMemoryCommitBlocksParams,
      _signal,
      _onUpdate,
      _ctx
    ) {
      const branchPurpose = trimNonEmptyString(params.branchPurpose);
      const previousProgressSummary = trimNonEmptyString(
        params.previousProgressSummary
      );
      const thisCommitContributionBullets = normalizeNonEmptyBullets(
        params.thisCommitContributionBullets
      );

      if (
        branchPurpose === "" ||
        previousProgressSummary === "" ||
        thisCommitContributionBullets.length === 0
      ) {
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: "Rejected empty structured commit-block submission.",
            },
          ],
          details: {},
        });
      }

      onSubmit({
        branchPurpose,
        previousProgressSummary,
        thisCommitContributionBullets,
      });

      return Promise.resolve({
        content: [
          {
            type: "text",
            text: "Structured memory commit blocks recorded.",
          },
        ],
        details: {},
      });
    },
  };
}

function createSubmitMemoryChunkSummaryTool(
  onSubmit: (submission: MemoryChunkSummarySubmission) => void
): ToolDefinition<typeof submitMemoryChunkSummarySchema> {
  return {
    name: SUBMIT_MEMORY_CHUNK_SUMMARY_TOOL,
    label: "Submit Memory Chunk Summary",
    description:
      "Submit the distilled chunk summary as validated bullet fields.",
    parameters: submitMemoryChunkSummarySchema,
    execute(
      _toolCallId,
      params: SubmitMemoryChunkSummaryParams,
      _signal,
      _onUpdate,
      _ctx
    ) {
      const summaryBullets = normalizeNonEmptyBullets(params.summaryBullets);
      if (summaryBullets.length === 0) {
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: "Rejected empty structured chunk-summary submission.",
            },
          ],
          details: {},
        });
      }

      onSubmit({ summaryBullets });

      return Promise.resolve({
        content: [
          {
            type: "text",
            text: "Structured memory chunk summary recorded.",
          },
        ],
        details: {},
      });
    },
  };
}

function createCommitterOutputTools(
  operation: MemoryCommitOperation,
  handlers: {
    onCommitBlocks: (submission: MemoryCommitBlocksSubmission) => void;
    onChunkSummary: (submission: MemoryChunkSummarySubmission) => void;
  }
): ToolDefinition[] {
  if (operation === MemoryCommitOperation.ChunkDistill) {
    return [
      createSubmitMemoryChunkSummaryTool(
        handlers.onChunkSummary
      ) as unknown as ToolDefinition,
    ];
  }

  if (operation === MemoryCommitOperation.ContributionSynthesis) {
    return [
      createSubmitMemoryChunkSummaryTool(
        handlers.onChunkSummary
      ) as unknown as ToolDefinition,
    ];
  }

  return [
    createSubmitMemoryCommitBlocksTool(
      handlers.onCommitBlocks
    ) as unknown as ToolDefinition,
  ];
}

function createStructuredOutputController(
  operation: MemoryCommitOperation
): StructuredOutputController {
  let submittedCommitBlocks: MemoryCommitBlocksSubmission | null = null;
  let submittedChunkSummary: MemoryChunkSummarySubmission | null = null;
  let resolveSubmission: (() => void) | null = null;
  const submissionPromise = new Promise<void>((resolve) => {
    resolveSubmission = resolve;
  });

  function markSubmitted(): void {
    resolveSubmission?.();
    resolveSubmission = null;
  }

  return {
    customTools: createCommitterOutputTools(operation, {
      onCommitBlocks(submission) {
        submittedCommitBlocks = submission;
        markSubmitted();
      },
      onChunkSummary(submission) {
        submittedChunkSummary = submission;
        markSubmitted();
      },
    }),
    resolveText() {
      if (
        operation === MemoryCommitOperation.ChunkDistill ||
        operation === MemoryCommitOperation.ContributionSynthesis
      ) {
        return submittedChunkSummary
          ? serializeChunkSummarySubmission(submittedChunkSummary)
          : "";
      }

      return submittedCommitBlocks
        ? serializeCommitBlocksSubmission(submittedCommitBlocks)
        : "";
    },
    waitForSubmission() {
      return submissionPromise;
    },
  };
}

function getStructuredSubmissionError(
  operation: MemoryCommitOperation
): string {
  if (operation === MemoryCommitOperation.ChunkDistill) {
    return "SDK committer did not submit structured chunk summary";
  }

  if (operation === MemoryCommitOperation.ContributionSynthesis) {
    return "SDK committer did not submit structured contribution summary";
  }

  return "SDK committer did not submit structured commit blocks";
}

function elapsedSince(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

function emitCommitterProgress(
  options: SpawnCommitterOptions | undefined,
  startedAt: number,
  progress: Omit<MemoryCommitProgress, "elapsedMs">
): void {
  options?.onProgress?.({
    ...progress,
    elapsedMs: elapsedSince(startedAt),
    operation: progress.operation ?? options?.operation,
    chunkIndex: progress.chunkIndex ?? options?.chunkIndex,
    chunkCount: progress.chunkCount ?? options?.chunkCount,
  });
}

function parseModelSelection(
  model: string | undefined
): { provider: string; modelId: string } | undefined {
  if (!model) {
    return undefined;
  }

  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= model.length - 1) {
    return undefined;
  }

  return {
    provider: model.slice(0, slashIndex),
    modelId: model.slice(slashIndex + 1),
  };
}

function buildSyntheticModel(
  registry: ModelRegistry,
  provider: string,
  modelId: string
): RegistryModel | undefined {
  const template = registry
    .getAll()
    .find((entry) => entry.provider === provider);
  if (!template) {
    return undefined;
  }

  return {
    ...template,
    id: modelId,
    name: modelId,
  };
}

function resolveSdkModel(
  registry: ModelRegistry,
  model: string | undefined
): RegistryModel | undefined {
  const parsed = parseModelSelection(model);
  if (!parsed) {
    return undefined;
  }

  const resolvedModel = registry
    .getAll()
    .find(
      (entry) =>
        entry.provider === parsed.provider && entry.id === parsed.modelId
    );

  return (
    resolvedModel ??
    buildSyntheticModel(registry, parsed.provider, parsed.modelId)
  );
}

const MAX_DIAGNOSTIC_EVENT_LINES = 64;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 240;

function truncateText(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH - 1)}…`;
}

function compactEventValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateText(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 4).map((item) => compactEventValue(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const compactRecord: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (
      key === "type" ||
      key === "role" ||
      key === "toolName" ||
      key === "path" ||
      key === "command" ||
      key === "text" ||
      key === "content" ||
      key === "message" ||
      key === "args" ||
      key === "partialResult" ||
      key === "result"
    ) {
      compactRecord[key] = compactEventValue(entry);
    }
  }

  return compactRecord;
}

function compactEventForDiagnostics(event: AgentSessionEvent): string {
  return `${JSON.stringify(compactEventValue(event))}\n`;
}

function appendDiagnosticEventLine(
  lines: string[],
  event: AgentSessionEvent
): string[] {
  const nextLines = [...lines, compactEventForDiagnostics(event)];
  if (nextLines.length <= MAX_DIAGNOSTIC_EVENT_LINES) {
    return nextLines;
  }

  return nextLines.slice(nextLines.length - MAX_DIAGNOSTIC_EVENT_LINES);
}

function extractAssistantTextFromEvent(
  event: AgentSessionEvent
): string | null {
  if (event.type !== "message_end" || event.message?.role !== "assistant") {
    return null;
  }

  const texts = (event.message.content ?? [])
    .map((item) => {
      if (item.type !== "text") {
        return null;
      }

      return typeof item.text === "string" ? item.text : null;
    })
    .filter((item): item is string => item !== null);

  return texts.length > 0 ? texts.join("\n\n") : null;
}

function buildTimedOutErrorMessage(
  timeoutMs: number,
  diagnosticStdout: string
): string {
  const baseMessage = `Subagent timed out after ${Math.round(timeoutMs / 1000)}s`;
  const diagnostics = buildTimeoutDiagnosticSummary(
    diagnosticStdout,
    "",
    getNormalizedCommitterTools()
  );
  if (diagnostics === "") {
    return baseMessage;
  }

  return `${baseMessage}\n\n${diagnostics}`;
}

function buildStructuredSubmissionFailureMessage(
  operation: MemoryCommitOperation,
  latestAssistantText: string
): string {
  const baseError = getStructuredSubmissionError(operation);
  if (latestAssistantText.trim() === "") {
    return baseError;
  }

  return `${baseError}. Assistant text fallback was: ${truncateText(
    latestAssistantText
  )}`;
}

function finalizeStructuredResult(options: {
  operation: MemoryCommitOperation;
  controller: StructuredOutputController;
  timedOut: boolean;
  timeoutMs: number;
  diagnosticEventLines: string[];
  latestAssistantText: string;
  sawAgentEnd: boolean;
  sawStructuredSubmission: boolean;
  existingError?: string;
  existingExitCode: number;
}): { text: string; error?: string; exitCode: number } {
  const text = options.controller.resolveText();

  if (options.timedOut) {
    return {
      text,
      error: buildTimedOutErrorMessage(
        options.timeoutMs,
        options.diagnosticEventLines.join("")
      ),
      exitCode: 124,
    };
  }

  if (options.existingError) {
    return {
      text,
      error: options.existingError,
      exitCode: options.existingExitCode,
    };
  }

  if (!options.sawAgentEnd && !options.sawStructuredSubmission) {
    return {
      text,
      error: "SDK committer completed without emitting agent_end",
      exitCode: 1,
    };
  }

  if (text === "") {
    return {
      text,
      error: buildStructuredSubmissionFailureMessage(
        options.operation,
        options.latestAssistantText
      ),
      exitCode: 1,
    };
  }

  return {
    text,
    exitCode: options.existingExitCode,
  };
}

export async function spawnCommitterSdk(
  cwd: string,
  task: string,
  options?: SpawnCommitterOptions
): Promise<SubagentResult> {
  if (options?.signal?.aborted) {
    return {
      text: "",
      exitCode: 1,
      error: "SDK committer aborted by caller",
    };
  }

  const startedAt = performance.now();
  const agentDef = resolveAgentPrompt();
  const operation = getCommitterOperation(options);
  const model = options?.model ?? agentDef.model;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMITTER_TIMEOUT_MS;
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const resolvedModel = resolveSdkModel(modelRegistry, model);

  if (!resolvedModel) {
    return {
      text: "",
      exitCode: 1,
      error: `Could not resolve SDK committer model: ${model ?? "(undefined)"}`,
    };
  }

  const sdkAgentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "memory-committer-sdk-agent-")
  );
  const prompt = buildSdkCommitterPrompt(
    options?.promptOverride ?? agentDef.prompt,
    operation
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const structuredOutput = createStructuredOutputController(operation);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: sdkAgentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: prompt,
  });

  let diagnosticEventLines: string[] = [];
  let latestAssistantText = "";
  let sawOutput = false;
  let sawAgentEnd = false;
  let sawStructuredSubmission = false;
  let timedOut = false;

  emitCommitterProgress(options, startedAt, {
    stage: MemoryCommitProgressStage.Spawned,
    message: "Started memory committer SDK session.",
    model,
  });

  try {
    emitCommitterProgress(options, startedAt, {
      stage: MemoryCommitProgressStage.LoadingResources,
      message: "Loading memory committer SDK resources...",
      model,
    });
    await resourceLoader.reload();
    emitCommitterProgress(options, startedAt, {
      stage: MemoryCommitProgressStage.LoadingResources,
      message: "Reloaded SDK resources.",
      model,
    });

    emitCommitterProgress(options, startedAt, {
      stage: MemoryCommitProgressStage.CreatingSession,
      message: "Creating memory committer SDK session.",
      model,
    });
    const { session } = await createAgentSession({
      cwd,
      authStorage,
      modelRegistry,
      model: resolvedModel,
      thinkingLevel: "off",
      tools: createReadOnlyTools(cwd),
      customTools: structuredOutput.customTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
    });
    emitCommitterProgress(options, startedAt, {
      stage: MemoryCommitProgressStage.CreatingSession,
      message: "Created memory committer SDK session.",
      model,
    });

    const unsubscribe = session.subscribe((event) => {
      diagnosticEventLines = appendDiagnosticEventLine(
        diagnosticEventLines,
        event
      );

      const assistantText = extractAssistantTextFromEvent(event);
      if (assistantText) {
        latestAssistantText = assistantText;
      }

      if (!sawOutput && event.type === "message_update") {
        sawOutput = true;
        emitCommitterProgress(options, startedAt, {
          stage: MemoryCommitProgressStage.Stdout,
          message: "Memory committer produced output.",
        });
      }

      if (event.type === "agent_end") {
        sawAgentEnd = true;
      }
    });

    try {
      emitCommitterProgress(options, startedAt, {
        stage: MemoryCommitProgressStage.Prompting,
        message: "Prompting memory committer SDK session.",
        model,
      });
      const promptPromise = session.prompt(`Task: ${task}`);
      const submissionPromise = (async () => {
        await structuredOutput.waitForSubmission();
        return { kind: "submitted" as const };
      })();
      const abortOutcome = createAbortOutcome(options?.signal);
      const outcome = await Promise.race([
        promptPromise.then(() => ({ kind: "completed" as const })),
        submissionPromise,
        delay(timeoutMs, { kind: "timeout" as const }),
        ...(abortOutcome ? [abortOutcome] : []),
      ]);

      let error: string | undefined;
      let exitCode = 0;
      if (outcome.kind === "timeout") {
        timedOut = true;
        emitCommitterProgress(options, startedAt, {
          stage: MemoryCommitProgressStage.TimedOut,
          message: `Memory committer timed out after ${Math.round(timeoutMs / 1000)}s; aborting SDK session.`,
        });
        await session.abort();
      } else if (outcome.kind === "aborted") {
        await session.abort();
        error = "SDK committer aborted by caller";
        exitCode = 1;
      } else if (outcome.kind === "submitted") {
        sawStructuredSubmission = true;
        await session.abort();
      }

      const finalized = finalizeStructuredResult({
        operation,
        controller: structuredOutput,
        timedOut,
        timeoutMs,
        diagnosticEventLines,
        latestAssistantText,
        sawAgentEnd,
        sawStructuredSubmission,
        existingError: error,
        existingExitCode: exitCode,
      });

      emitCommitterProgress(options, startedAt, {
        stage: MemoryCommitProgressStage.Finished,
        message: finalized.error
          ? `Memory committer exited with code ${finalized.exitCode}.`
          : "Memory committer finished successfully.",
        exitCode: finalized.exitCode,
      });

      return finalized;
    } finally {
      unsubscribe();
      session.dispose();
    }
  } catch (error: unknown) {
    emitCommitterProgress(options, startedAt, {
      stage: MemoryCommitProgressStage.Finished,
      message: "Memory committer exited with code 1.",
      exitCode: 1,
    });

    return {
      text: "",
      exitCode: 1,
      error:
        error instanceof Error
          ? error.message
          : "SDK committer failed unexpectedly",
    };
  } finally {
    fs.rmSync(sdkAgentDir, { recursive: true, force: true });
  }
}
