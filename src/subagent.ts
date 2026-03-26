import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildPreviousProgressSummaryForNextCommit } from "./commit-context.js";
import { MemoryCommitOperation, MemoryCommitProgressStage } from "./enums.js";
import {
  parseChunkSummarySubmission,
  parseCommitBlocksSubmission,
  parsePersistedOtaLog,
  serializeCommitBlocksSubmission,
} from "./structured-memory.js";
import type {
  BranchCommitContext,
  MemoryCommitBlocksSubmission,
  MemoryCommitProgress,
  MemoryChunkSummarySubmission,
  SpawnCommitterFunction,
  SpawnCommitterOptions,
  SubagentResult,
} from "./types.js";
import { parseYaml } from "./yaml.js";

const COMMITTER_MODEL = "google-antigravity/gemini-3-flash";
const COMMITTER_TOOLS = "read,grep,find,ls";

interface AgentDefinition {
  prompt: string;
  model: string;
  tools: string;
  skills: string;
  extensions: string;
}

interface DistillCommitBlocksOptions extends SpawnCommitterOptions {
  maxChunkBytes?: number;
  maxChunkTurns?: number;
  spawnCommitterFn?: SpawnCommitterFunction;
}

const DEFAULT_COMMITTER_CHUNK_MAX_BYTES = 12_000;
const DEFAULT_COMMITTER_CHUNK_MAX_TURNS = 4;
const CHUNK_DISTILLER_PROMPT = [
  "You are a chunk distiller for Brain (agent memory).",
  "",
  "Read the requested structured chunk log only.",
  "Respond only by calling the structured chunk-summary tool.",
  "The chunk content is a JSON array of OTA entries; each object is one turn.",
  "",
  "- Capture decisions and rationale from this chunk only.",
  "- Include notable negative results or rejected paths.",
  "- Omit implementation trivia, examples, and filler.",
  "- Keep each bullet to one sentence whenever possible.",
].join("\n");
const CHUNK_SYNTHESIZER_PROMPT = [
  "You are the final contribution synthesizer for a chunked Brain memory commit.",
  "",
  "Before doing anything else, read `.memory/AGENTS.md` for the protocol reference.",
  "",
  "Read the chunk summaries file and synthesize only the current commit contribution.",
  "",
  "Return 3-7 concise bullets that synthesize ALL chunk summaries for the current uncommitted work.",
  "Do not mention chunk numbers or internal chunking mechanics.",
].join("\n");

interface ChunkSummaryRecord {
  chunkIndex: number;
  summaryBullets: string[];
}

function elapsedSince(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

export function resolveAgentPrompt(): AgentDefinition {
  const currentFile = new URL(import.meta.url).pathname;
  const currentDir = path.dirname(currentFile);

  const candidates = [
    path.resolve(currentDir, "../agents/memory-committer.md"),
    path.resolve(currentDir, "../.pi/agents/memory-committer.md"),
    path.resolve(currentDir, "./agents/memory-committer.md"),
  ];

  for (const agentFile of candidates) {
    try {
      const content = fs.readFileSync(agentFile, "utf8");

      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      let frontmatter = "";
      let prompt = content.trim();

      if (match) {
        const [, matchedFrontmatter, matchedPrompt] = match;
        frontmatter = matchedFrontmatter;
        prompt = matchedPrompt.trim();
      }

      let parsed: Record<string, unknown> = {};
      if (frontmatter) {
        try {
          parsed = parseYaml(frontmatter) as Record<string, unknown>;
        } catch {
          // Ignore parse errors, fallback to defaults.
        }
      }

      return {
        prompt,
        model:
          typeof parsed.model === "string" ? parsed.model : COMMITTER_MODEL,
        tools:
          typeof parsed.tools === "string" ? parsed.tools : COMMITTER_TOOLS,
        skills: typeof parsed.skills === "string" ? parsed.skills : "",
        extensions:
          typeof parsed.extensions === "string" ? parsed.extensions : "",
      };
    } catch {
      continue;
    }
  }

  throw new Error("Could not locate memory-committer.md agent definition file");
}

export function buildCommitterTask(branch: string, summary: string): string {
  return [
    `Distill a memory commit for branch "${branch}".`,
    `Summary: ${summary}`,
    "",
    "Read these files:",
    "- .memory/AGENTS.md (protocol reference — read first)",
    `- .memory/branches/${branch}/log.jsonl (OTA trace to distill)`,
    `- .memory/branches/${branch}/commit-context.json (structured latest branch context)`,
    "",
    "Finish by calling `submit_memory_commit_blocks`.",
    "Do not answer with freeform prose or markdown outside the tool call.",
  ].join("\n");
}

function buildChunkDistillerTask(
  branch: string,
  summary: string,
  chunkContent: string,
  chunkIndex: number,
  totalChunks: number
): string {
  return [
    `Distill Chunk ${chunkIndex} of ${totalChunks} for branch "${branch}".`,
    `Summary: ${summary}`,
    "",
    "Do not ask clarifying questions. Summarize the chunk content exactly as provided.",
    "Each JSON object in the chunk is one OTA turn.",
    "",
    "Chunk content (JSON array):",
    "```json",
    chunkContent,
    "```",
    "",
    "Finish by calling `submit_memory_chunk_summary`.",
    "Do not answer with freeform prose or markdown outside the tool call.",
    "Provide 1-3 concise bullets about this chunk only.",
  ].join("\n");
}

function buildChunkSynthesisTask(branch: string, summary: string): string {
  return [
    `Synthesize the final contribution for branch "${branch}".`,
    `Summary: ${summary}`,
    "",
    "Read these files:",
    "- .memory/AGENTS.md (protocol reference — read first)",
    `- .memory/branches/${branch}/commit-context.json (structured latest branch context)`,
    `- .memory/branches/${branch}/chunk-summaries.json (structured summaries of the current uncommitted work)`,
    "",
    "Finish by calling `submit_memory_chunk_summary`.",
    "Do not answer with freeform prose or markdown outside the tool call.",
  ].join("\n");
}

function serializeLogChunkEntries(
  entries: ReturnType<typeof parsePersistedOtaLog>
): string {
  return JSON.stringify(entries, null, 2);
}

export function splitLogIntoCommitChunks(
  log: string,
  maxChunkBytes: number = DEFAULT_COMMITTER_CHUNK_MAX_BYTES,
  maxChunkTurns: number = DEFAULT_COMMITTER_CHUNK_MAX_TURNS
): string[] {
  const entries = parsePersistedOtaLog(log);
  if (entries.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  let currentEntries: typeof entries = [];

  for (const entry of entries) {
    const nextEntries = [...currentEntries, entry];
    const nextChunk = serializeLogChunkEntries(nextEntries);
    const exceedsTurnLimit =
      currentEntries.length > 0 && nextEntries.length > maxChunkTurns;
    const exceedsByteLimit =
      currentEntries.length > 0 &&
      Buffer.byteLength(nextChunk, "utf8") > maxChunkBytes;

    if (exceedsTurnLimit || exceedsByteLimit) {
      chunks.push(serializeLogChunkEntries(currentEntries));
      currentEntries = [entry];
      continue;
    }

    currentEntries = nextEntries;
  }

  if (currentEntries.length > 0) {
    chunks.push(serializeLogChunkEntries(currentEntries));
  }

  return chunks;
}

export function extractFinalText(stdout: string): string {
  let lastText = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const evt = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          content?: { type?: string; text?: string }[];
        };
      };
      if (evt.type === "message_end" && evt.message?.role === "assistant") {
        const texts = (evt.message.content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string);
        if (texts.length > 0) {
          lastText = texts.join("\n\n");
        }
      }
    } catch {
      // Not JSON — skip.
    }
  }
  return lastText;
}

export function extractCommitBlocks(
  text: string
): MemoryCommitBlocksSubmission | null {
  return parseCommitBlocksSubmission(text);
}

function extractChunkSummary(
  text: string
): MemoryChunkSummarySubmission | null {
  return parseChunkSummarySubmission(text);
}

function buildCommitBlocksFromStructuredPieces(
  branchContext: BranchCommitContext,
  contributionBullets: string[]
): MemoryCommitBlocksSubmission {
  return {
    branchPurpose: branchContext.branchPurpose,
    previousProgressSummary:
      buildPreviousProgressSummaryForNextCommit(branchContext),
    thisCommitContributionBullets: contributionBullets,
  };
}

function buildChunkFailureResult(
  chunkIndex: number,
  totalChunks: number,
  result: SubagentResult
): SubagentResult {
  const prefix = `Chunk ${chunkIndex}/${totalChunks} failed`;

  return {
    ...result,
    error: result.error ? `${prefix}: ${result.error}` : prefix,
  };
}

function getChunkSummariesRelativePath(branch: string): string {
  return `.memory/branches/${branch}/chunk-summaries.json`;
}

function createChunkWorkspace(
  cwd: string,
  branch: string,
  branchCommitContext: BranchCommitContext
): {
  rootDir: string;
  branchDir: string;
  chunkSummariesPath: string;
} {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "memory-commit-chunks-")
  );
  const memoryDir = path.join(rootDir, ".memory");
  const branchDir = path.join(memoryDir, "branches", branch);
  fs.mkdirSync(branchDir, { recursive: true });

  const agentsPath = path.join(cwd, ".memory", "AGENTS.md");
  const agentsContent = fs.existsSync(agentsPath)
    ? fs.readFileSync(agentsPath, "utf8")
    : "";
  fs.writeFileSync(path.join(memoryDir, "AGENTS.md"), agentsContent);
  fs.writeFileSync(
    path.join(branchDir, "commit-context.json"),
    `${JSON.stringify(branchCommitContext, null, 2)}\n`
  );
  fs.writeFileSync(path.join(branchDir, "log.jsonl"), "");

  const chunkSummariesPath = path.join(
    rootDir,
    getChunkSummariesRelativePath(branch)
  );
  fs.writeFileSync(chunkSummariesPath, "[]\n");

  return {
    rootDir,
    branchDir,
    chunkSummariesPath,
  };
}

function normalizeCsvList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCsvString(value: string): string {
  return normalizeCsvList(value).join(",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function truncatePreview(text: string, maxLength = 160): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function extractTextPreview(value: unknown): string | null {
  if (typeof value === "string") {
    const preview = truncatePreview(value);
    return preview === "" ? null : preview;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const preview = extractTextPreview(item);
      if (preview) {
        return preview;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const { text } = value;
  if (typeof text === "string") {
    const preview = truncatePreview(text);
    return preview === "" ? null : preview;
  }

  return extractTextPreview(value.content);
}

function describeToolEvent(event: Record<string, unknown>): string | null {
  const toolName = typeof event.toolName === "string" ? event.toolName : null;
  if (!toolName) {
    return null;
  }

  const parts = [`tool ${toolName}`];

  const args = isRecord(event.args) ? event.args : null;
  if (args && typeof args.path === "string") {
    parts.push(`path=${args.path}`);
  } else if (args && typeof args.command === "string") {
    parts.push(`command=${truncatePreview(args.command)}`);
  }

  const preview =
    extractTextPreview(event.partialResult) ??
    extractTextPreview(event.result) ??
    extractTextPreview(event.message);
  if (preview) {
    parts.push(`preview="${preview}"`);
  }

  return parts.join(" ");
}

function describeMessageEvent(event: Record<string, unknown>): string | null {
  const message = isRecord(event.message) ? event.message : null;
  if (!message) {
    return null;
  }

  const role = typeof message.role === "string" ? message.role : "message";
  const preview = extractTextPreview(message.content);
  if (!preview) {
    return `${role} message`;
  }

  return `${role} message preview="${preview}"`;
}

function describeStructuredStdoutEvent(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const summary = describeToolEvent(event) ?? describeMessageEvent(event);

  if (!summary) {
    return `Last stdout event: ${type}`;
  }

  return `Last stdout event: ${type} — ${summary}`;
}

export function describeLastStdoutEvent(stdout: string): string | null {
  let lastStructuredEvent: Record<string, unknown> | null = null;
  let lastRawLine: string | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }

    lastRawLine = truncatePreview(trimmed);

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        lastStructuredEvent = parsed;
      }
    } catch {
      // Ignore invalid JSON; raw-line fallback keeps the latest line.
    }
  }

  if (lastStructuredEvent) {
    return describeStructuredStdoutEvent(lastStructuredEvent);
  }

  if (lastRawLine) {
    return `Last stdout line: ${lastRawLine}`;
  }

  return null;
}

export function buildTimeoutDiagnosticSummary(
  stdout: string,
  stderr: string,
  tools?: string
): string {
  const diagnostics: string[] = [];

  if (tools) {
    diagnostics.push(`Normalized tools: ${tools}`);
  }

  const stdoutSummary = describeLastStdoutEvent(stdout);
  if (stdoutSummary) {
    diagnostics.push(stdoutSummary);
  }

  const stderrLines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (stderrLines.length > 0) {
    const tail = stderrLines.slice(-3).map((line) => truncatePreview(line));
    diagnostics.push(`Stderr tail: ${tail.join(" | ")}`);
  }

  return diagnostics.join("\n");
}

function emitCommitterProgress(
  options: DistillCommitBlocksOptions | undefined,
  startedAt: number,
  progress: Omit<MemoryCommitProgress, "elapsedMs">,
  metadata?: {
    operation?: MemoryCommitOperation;
    chunkIndex?: number;
    chunkCount?: number;
  }
): void {
  options?.onProgress?.({
    ...progress,
    elapsedMs: elapsedSince(startedAt),
    operation: metadata?.operation ?? progress.operation,
    chunkIndex: metadata?.chunkIndex ?? progress.chunkIndex,
    chunkCount: metadata?.chunkCount ?? progress.chunkCount,
  });
}

function withForwardedProgress(
  options: DistillCommitBlocksOptions | undefined,
  startedAt: number,
  metadata: {
    operation: MemoryCommitOperation;
    chunkIndex?: number;
    chunkCount?: number;
    promptOverride?: string;
  }
): SpawnCommitterOptions {
  return {
    signal: options?.signal,
    model: options?.model,
    timeoutMs: options?.timeoutMs,
    promptOverride: metadata.promptOverride,
    operation: metadata.operation,
    chunkIndex: metadata.chunkIndex,
    chunkCount: metadata.chunkCount,
    onProgress(progress) {
      emitCommitterProgress(options, startedAt, progress, metadata);
    },
  };
}

export async function distillCommitBlocks(
  cwd: string,
  branch: string,
  summary: string,
  logContent: string,
  branchCommitContext: BranchCommitContext,
  options?: DistillCommitBlocksOptions
): Promise<SubagentResult> {
  const chunks = splitLogIntoCommitChunks(
    logContent,
    options?.maxChunkBytes,
    options?.maxChunkTurns
  );
  const spawnCommitterFn = options?.spawnCommitterFn;
  if (!spawnCommitterFn) {
    return {
      text: "",
      exitCode: 1,
      error: "No memory committer runner configured.",
    };
  }

  const startedAt = performance.now();

  if (chunks.length <= 1) {
    return spawnCommitterFn(
      cwd,
      buildCommitterTask(branch, summary),
      withForwardedProgress(options, startedAt, {
        operation: MemoryCommitOperation.SinglePass,
      })
    );
  }

  const workspace = createChunkWorkspace(cwd, branch, branchCommitContext);

  try {
    const chunkSummaries: ChunkSummaryRecord[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const chunkIndex = index + 1;
      const chunkMetadata = {
        operation: MemoryCommitOperation.ChunkDistill,
        chunkIndex,
        chunkCount: chunks.length,
      };

      emitCommitterProgress(
        options,
        startedAt,
        {
          stage: MemoryCommitProgressStage.Chunking,
          message: `Distilling memory commit chunk ${chunkIndex}/${chunks.length}...`,
        },
        chunkMetadata
      );

      const result = await spawnCommitterFn(
        workspace.rootDir,
        buildChunkDistillerTask(
          branch,
          summary,
          chunk,
          chunkIndex,
          chunks.length
        ),
        withForwardedProgress(options, startedAt, {
          ...chunkMetadata,
          promptOverride: CHUNK_DISTILLER_PROMPT,
        })
      );

      if (result.exitCode !== 0 || result.error) {
        return buildChunkFailureResult(chunkIndex, chunks.length, result);
      }

      const chunkSummary = extractChunkSummary(result.text);
      if (!chunkSummary) {
        return {
          text: "",
          exitCode: 1,
          error: `Chunk ${chunkIndex}/${chunks.length} failed: could not extract chunk summary from subagent response.`,
        };
      }

      const { summaryBullets } = chunkSummary;
      if (summaryBullets.length === 0) {
        return {
          text: "",
          exitCode: 1,
          error: `Chunk ${chunkIndex}/${chunks.length} failed: could not extract chunk summary bullets from subagent response.`,
        };
      }

      chunkSummaries.push({
        chunkIndex,
        summaryBullets,
      });
    }

    fs.writeFileSync(
      workspace.chunkSummariesPath,
      `${JSON.stringify(chunkSummaries, null, 2)}\n`
    );

    emitCommitterProgress(
      options,
      startedAt,
      {
        stage: MemoryCommitProgressStage.Synthesizing,
        message: `Synthesizing final memory commit from ${chunks.length} chunk summaries...`,
      },
      {
        operation: MemoryCommitOperation.ContributionSynthesis,
      }
    );

    const synthesisResult = await spawnCommitterFn(
      workspace.rootDir,
      buildChunkSynthesisTask(branch, summary),
      withForwardedProgress(options, startedAt, {
        operation: MemoryCommitOperation.ContributionSynthesis,
        promptOverride: CHUNK_SYNTHESIZER_PROMPT,
      })
    );

    if (synthesisResult.exitCode !== 0 || synthesisResult.error) {
      return synthesisResult;
    }

    const contributionSummary = extractChunkSummary(synthesisResult.text);
    if (!contributionSummary) {
      return {
        text: "",
        exitCode: 1,
        error:
          "Final contribution synthesis failed: could not extract contribution bullets from subagent response.",
      };
    }

    const { summaryBullets: contributionBullets } = contributionSummary;
    if (contributionBullets.length === 0) {
      return {
        text: "",
        exitCode: 1,
        error:
          "Final contribution synthesis failed: no contribution bullets were returned.",
      };
    }

    return {
      text: serializeCommitBlocksSubmission(
        buildCommitBlocksFromStructuredPieces(
          branchCommitContext,
          contributionBullets
        )
      ),
      exitCode: 0,
    };
  } finally {
    fs.rmSync(workspace.rootDir, { recursive: true, force: true });
  }
}

export function getNormalizedCommitterTools(): string {
  return normalizeCsvString(resolveAgentPrompt().tools);
}
