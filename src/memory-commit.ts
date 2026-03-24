import type { BranchManager } from "./branches.js";
import { generateHash } from "./hash.js";
import { buildStatusView } from "./memory-context.js";
import type { MemoryState } from "./state.js";
import { buildCommitterTask } from "./subagent.js";

interface MemoryCommitParams {
  summary: string;
  update_roadmap?: boolean;
  model?: string;
}

function isModelSelection(
  value: unknown
): value is { provider: string; id: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "id" in value &&
    typeof value.id === "string"
  );
}

export function resolveCommitterModel(
  params: MemoryCommitParams,
  sessionModel: unknown,
  configuredModel?: string
): string | undefined {
  const override = params.model?.trim();
  if (override) {
    return override;
  }

  const configured = configuredModel?.trim();
  if (configured) {
    return configured;
  }

  if (!isModelSelection(sessionModel)) {
    return undefined;
  }

  return `${sessionModel.provider}/${sessionModel.id}`;
}

export function buildCommitFailureMessage(error: string): string {
  if (error.includes("timed out")) {
    return [
      `Commit failed: ${error}`,
      "",
      "The committer subagent was terminated before it finished. If this keeps happening, try a faster or smaller model, or commit more often so `.memory/branches/<branch>/log.md` stays smaller.",
    ].join("\n");
  }

  return [
    `Commit failed: ${error}`,
    "",
    "The committer subagent now runs with extension discovery disabled to avoid recursive memory_commit loops. If you still see hangs, inspect the subagent error output and the current log size.",
  ].join("\n");
}

/**
 * Build the subagent task string for commit distillation.
 * The subagent reads log.md and commits.md itself.
 */
export function executeMemoryCommit(
  params: MemoryCommitParams,
  state: MemoryState,
  _branches: BranchManager
): { task: string } {
  const branch = state.activeBranch;

  return {
    task: buildCommitterTask(branch, params.summary),
  };
}

/**
 * Step 2: Write the agent's commit content to commits.md,
 * clear log.md, update state, and return result with status.
 */
export function finalizeMemoryCommit(
  summary: string,
  commitContent: string,
  state: MemoryState,
  branches: BranchManager,
  projectDir: string,
  updateRoadmap?: boolean
): string {
  const branch = state.activeBranch;
  const hash = generateHash();
  const timestamp = new Date().toISOString();

  const entry = [
    "",
    "---",
    "",
    `## Commit ${hash} | ${timestamp}`,
    "",
    commitContent,
    "",
  ].join("\n");

  branches.appendCommit(branch, entry);
  branches.clearLog(branch);

  state.setLastCommit(branch, hash, timestamp, summary);
  state.save();

  const resultText = `Commit ${hash} written to branch "${branch}".`;
  const status = buildStatusView(state, branches, projectDir, {
    compact: true,
  });

  const roadmapReminder =
    updateRoadmap === false
      ? ""
      : "\n\n**Action required:** Re-read `.memory/main.md` in full and rewrite stale sections. Current State should describe what is true right now — curate, don't just append.";

  return `${resultText}\n\n${status}${roadmapReminder}`;
}
