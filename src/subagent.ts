import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { SubagentResult } from "./types.js";
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

export function buildCommitterArgs(
  agentDef: AgentDefinition,
  task: string,
  modelOverride?: string
): string[] {
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
    agentDef.tools,
    "-p",
    `Task: ${task}`,
  ];

  if (agentDef.skills) {
    const skills = agentDef.skills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const skill of skills) {
      args.push("--skill", skill);
    }
  }

  if (agentDef.extensions) {
    const exts = agentDef.extensions
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
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

  const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMITTER_TIMEOUT_MS;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let closed = false;
  let killGraceTimer: NodeJS.Timeout | null = null;

  proc.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
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

  const waitForExit = new Promise<
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
      waitForExit,
      delay(timeoutMs, { kind: "timeout" as const }),
    ]);

    let settled: Awaited<typeof waitForExit>;
    if (outcome.kind === "timeout") {
      timedOut = true;
      terminateProcess();
      settled = await waitForExit;
    } else {
      settled = outcome;
    }
    closed = true;

    if (settled.kind === "error") {
      const error = timedOut
        ? `Subagent timed out after ${Math.round(timeoutMs / 1000)}s`
        : `Failed to spawn subagent: ${settled.error.message}`;

      return {
        text: "",
        exitCode: timedOut ? 124 : 1,
        error,
      };
    }

    let error: string | undefined;
    if (timedOut) {
      error = `Subagent timed out after ${Math.round(timeoutMs / 1000)}s`;
    } else if (settled.code !== 0) {
      error = stderr.trim() || "Subagent exited with non-zero code";
    }

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
