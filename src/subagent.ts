import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { MemoryCommitProgressStage } from "./enums.js";
import type { MemoryCommitProgress, SubagentResult } from "./types.js";
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

interface SpawnCommitterOptions {
  signal?: AbortSignal;
  model?: string;
  timeoutMs?: number;
  onProgress?: (progress: MemoryCommitProgress) => void;
}

const DEFAULT_COMMITTER_TIMEOUT_MS = 60_000;
const COMMITTER_KILL_GRACE_PERIOD_MS = 3000;

/**
 * Resolve the memory-committer agent definition from the agent definition file.
 * Checks multiple locations to support both local development and npm installs.
 * Parses the YAML frontmatter for properties and uses the body as the system prompt.
 */
function resolveAgentPrompt(): AgentDefinition {
  const currentFile = new URL(import.meta.url).pathname;
  const currentDir = path.dirname(currentFile);

  // Possible locations for the agent definition file
  const candidates = [
    // Installed package: dist/ or src/ -> ../agents/ (bundled in package)
    path.resolve(currentDir, "../agents/memory-committer.md"),
    // Local development: src/ -> ../.pi/agents/
    path.resolve(currentDir, "../.pi/agents/memory-committer.md"),
    // Fallback: check if bundled alongside source
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
          // Ignore parse errors, fallback to defaults
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
    `- .memory/branches/${branch}/log.md (OTA trace to distill)`,
    `- .memory/branches/${branch}/commits.md (previous commits for rolling summary)`,
    "",
    "Produce the three commit blocks.",
  ].join("\n");
}

/**
 * Extract the last assistant text from pi's JSON-mode stdout.
 * Each line is a JSON event; we want the last message_end with role=assistant.
 */
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
      // Not JSON — skip
    }
  }
  return lastText;
}

/**
 * Extract the three commit blocks from subagent response text.
 * Returns the text from "### Branch Purpose" through the end of
 * "### This Commit's Contribution" content, stripping preamble
 * and trailing prose.
 */
export function extractCommitBlocks(text: string): string | null {
  const branchPurposeIndex = text.indexOf("### Branch Purpose");
  if (branchPurposeIndex === -1) {
    return null;
  }

  const progressIndex = text.indexOf("### Previous Progress Summary");
  if (progressIndex === -1) {
    return null;
  }

  const contributionIndex = text.indexOf("### This Commit's Contribution");
  if (contributionIndex === -1) {
    return null;
  }

  // Extract from "### Branch Purpose" onward
  const fromStart = text.slice(branchPurposeIndex);
  const lines = fromStart.split("\n");

  // Find where "### This Commit's Contribution" starts, then collect
  // content lines until we hit a blank line followed by non-content.
  let inContribution = false;
  let lastContentLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("### This Commit's Contribution")) {
      inContribution = true;
      lastContentLine = i;
      continue;
    }

    if (!inContribution) {
      lastContentLine = i;
      continue;
    }

    // In contribution block: keep content lines, stop at blank+non-blank
    if (line.trim() === "") {
      continue;
    }

    // Non-empty line in contribution section — is it still contribution content?
    // If there was a blank line gap since lastContentLine, check if this
    // looks like trailing prose (doesn't start with -, *, or indent).
    const gapHasBlank = lines
      .slice(lastContentLine + 1, i)
      .some((l) => l.trim() === "");

    if (
      gapHasBlank &&
      !line.startsWith("-") &&
      !line.startsWith("*") &&
      !line.startsWith(" ")
    ) {
      // Trailing text after the contribution block — stop here
      break;
    }

    lastContentLine = i;
  }

  return lines
    .slice(0, lastContentLine + 1)
    .join("\n")
    .trimEnd();
}

function writePromptToTempFile(prompt: string): {
  dir: string;
  filePath: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-committer-"));
  const filePath = path.join(tmpDir, "system-prompt.md");
  fs.writeFileSync(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function emitCommitterProgress(
  options: SpawnCommitterOptions | undefined,
  startedAt: number,
  progress: Omit<MemoryCommitProgress, "elapsedMs">
): void {
  options?.onProgress?.({
    ...progress,
    elapsedMs: Date.now() - startedAt,
  });
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
      // Ignore invalid JSON; raw-line fallback below keeps the latest line.
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

function buildTimedOutErrorMessage(
  timeoutMs: number,
  stdout: string,
  stderr: string,
  tools: string
): string {
  const baseMessage = `Subagent timed out after ${Math.round(timeoutMs / 1000)}s`;
  const diagnostics = buildTimeoutDiagnosticSummary(stdout, stderr, tools);
  if (diagnostics === "") {
    return baseMessage;
  }

  return `${baseMessage}\n\n${diagnostics}`;
}

export function buildCommitterArgs(
  agentDef: AgentDefinition,
  task: string,
  modelOverride?: string
): string[] {
  const normalizedTools = normalizeCsvString(agentDef.tools);

  const args = [
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--model",
    modelOverride ?? agentDef.model,
    "--tools",
    normalizedTools,
    "-p",
    `Task: ${task}`,
  ];

  if (agentDef.skills) {
    const skills = normalizeCsvList(agentDef.skills);
    for (const skill of skills) {
      args.push("--skill", skill);
    }
  }

  if (agentDef.extensions) {
    const exts = normalizeCsvList(agentDef.extensions);
    for (const ext of exts) {
      args.push("--extension", ext);
    }
  }

  return args;
}

export async function spawnCommitter(
  cwd: string,
  task: string,
  options?: SpawnCommitterOptions
): Promise<SubagentResult> {
  const startedAt = Date.now();
  let agentDef: AgentDefinition;
  try {
    agentDef = resolveAgentPrompt();
  } catch (error: unknown) {
    return {
      text: "",
      exitCode: 1,
      error:
        error instanceof Error
          ? error.message
          : "Failed to resolve agent definition",
    };
  }

  const normalizedTools = normalizeCsvString(agentDef.tools);
  const args = buildCommitterArgs(agentDef, task, options?.model);

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  if (agentDef.prompt) {
    const tmp = writePromptToTempFile(agentDef.prompt);
    tmpPromptDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    args.push("--append-system-prompt", tmpPromptPath);
  }

  const proc = spawn("pi", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  emitCommitterProgress(options, startedAt, {
    stage: MemoryCommitProgressStage.Spawned,
    message: `Started memory committer process${proc.pid ? ` (pid ${proc.pid})` : ""}.`,
    pid: proc.pid,
    model: options?.model ?? agentDef.model,
  });

  const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMITTER_TIMEOUT_MS;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let closed = false;
  let killGraceTimer: NodeJS.Timeout | null = null;
  let sawStdout = false;
  let sawStderr = false;

  proc.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
    if (!sawStdout) {
      sawStdout = true;
      emitCommitterProgress(options, startedAt, {
        stage: MemoryCommitProgressStage.Stdout,
        message: "Memory committer produced output.",
      });
    }
  });
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
    if (!sawStderr) {
      sawStderr = true;
      emitCommitterProgress(options, startedAt, {
        stage: MemoryCommitProgressStage.Stderr,
        message: "Memory committer emitted stderr output.",
        stderrPreview: stderr.trim().slice(0, 200),
      });
    }
  });

  const terminateProcess = (): void => {
    if (closed) {
      return;
    }

    proc.kill("SIGTERM");
    if (killGraceTimer) {
      return;
    }

    killGraceTimer = setTimeout(() => {
      if (!closed) {
        proc.kill("SIGKILL");
      }
    }, COMMITTER_KILL_GRACE_PERIOD_MS);
  };

  const cleanup = (): void => {
    if (killGraceTimer) {
      clearTimeout(killGraceTimer);
    }
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    }
    if (tmpPromptDir) {
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
    }
  };

  const waitForClose = new Promise<
    { kind: "close"; code: number | null } | { kind: "error"; error: Error }
  >((resolve) => {
    function onError(error: Error): void {
      resolve({ kind: "error", error });
    }

    function onClose(code: number | null): void {
      resolve({ kind: "close", code });
    }

    proc.once("close", onClose);
    proc.once("error", onError);
  });

  const waitForExit = new Promise<
    { kind: "exit"; code: number | null } | { kind: "error"; error: Error }
  >((resolve) => {
    function onError(error: Error): void {
      resolve({ kind: "error", error });
    }

    function onExit(code: number | null): void {
      resolve({ kind: "exit", code });
    }

    proc.once("exit", onExit);
    proc.once("error", onError);
  });

  const abortListener = () => {
    terminateProcess();
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      abortListener();
    } else {
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    const outcome = await Promise.race([
      waitForClose,
      delay(timeoutMs, { kind: "timeout" as const }),
    ]);

    let settled: Awaited<typeof waitForClose> | Awaited<typeof waitForExit>;
    if (outcome.kind === "timeout") {
      timedOut = true;
      emitCommitterProgress(options, startedAt, {
        stage: MemoryCommitProgressStage.TimedOut,
        message: `Memory committer timed out after ${Math.round(timeoutMs / 1000)}s; terminating child process.`,
      });
      terminateProcess();
      settled = await Promise.race([waitForClose, waitForExit]);
    } else {
      settled = outcome;
    }
    closed = true;

    if (settled.kind === "error") {
      const error = timedOut
        ? buildTimedOutErrorMessage(timeoutMs, stdout, stderr, normalizedTools)
        : `Failed to spawn subagent: ${settled.error.message}`;

      return {
        text: "",
        exitCode: timedOut ? 124 : 1,
        error,
      };
    }

    let error: string | undefined;
    if (timedOut) {
      error = buildTimedOutErrorMessage(
        timeoutMs,
        stdout,
        stderr,
        normalizedTools
      );
    } else if (settled.code !== 0) {
      error = stderr.trim() || "Subagent exited with non-zero code";
    }

    emitCommitterProgress(options, startedAt, {
      stage: MemoryCommitProgressStage.Finished,
      message: error
        ? `Memory committer exited with code ${timedOut ? 124 : (settled.code ?? 1)}.`
        : "Memory committer finished successfully.",
      exitCode: timedOut ? 124 : (settled.code ?? 1),
      stderrPreview: stderr.trim().slice(0, 200) || undefined,
    });

    return {
      text: extractFinalText(stdout),
      exitCode: timedOut ? 124 : (settled.code ?? 1),
      error,
    };
  } finally {
    closed = true;
    cleanup();
    options?.signal?.removeEventListener("abort", abortListener);
  }
}
