import type { BranchManager } from "./branches.js";
import { buildCommitContextFromSubmission } from "./commit-context.js";
import { generateHash } from "./hash.js";
import { buildStatusView } from "./memory-context.js";
import type { MemoryState } from "./state.js";
import { parseCommitBlocksSubmission } from "./structured-memory.js";
import { buildCommitterTask } from "./subagent.js";
import type {
  CommitterModelConfig,
  MemoryCommitBlocksSubmission,
  MemoryCommitRecord,
} from "./types.js";

interface MemoryCommitParams {
  summary: string;
  update_roadmap?: boolean;
  model?: string;
}

interface CommitterModelSelection {
  model?: string;
  source: string;
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
  _params: MemoryCommitParams,
  sessionModel: unknown,
  configuredModel?: string
): string | undefined {
  const configured = configuredModel?.trim();
  if (configured) {
    return configured;
  }

  if (!isModelSelection(sessionModel)) {
    return undefined;
  }

  return `${sessionModel.provider}/${sessionModel.id}`;
}

export function resolveCommitterModelSelection(
  _params: MemoryCommitParams,
  sessionModel: unknown,
  configuredModel?: CommitterModelConfig
): CommitterModelSelection {
  if (configuredModel) {
    return {
      model: configuredModel.model,
      source: configuredModel.source,
    };
  }

  if (!isModelSelection(sessionModel)) {
    return {
      model: undefined,
      source: "memory-committer default (agents/memory-committer.md)",
    };
  }

  return {
    model: `${sessionModel.provider}/${sessionModel.id}`,
    source: `session model (${sessionModel.provider}/${sessionModel.id})`,
  };
}

export function formatCommitterModelDiagnostics(
  selection: CommitterModelSelection
): string {
  return [
    `Resolved committer model: ${selection.model ?? "memory-committer default"}`,
    `Model source: ${selection.source}`,
    "Committer runner: sdk",
  ].join("\n");
}

function isStructuredToolComplianceFailure(error: string): boolean {
  return (
    error.includes("did not submit structured commit blocks") ||
    error.includes("did not submit structured chunk summary") ||
    error.includes("did not submit structured contribution summary")
  );
}

function extractResolvedModelFromDiagnostics(error: string): string | null {
  const match = error.match(/^Resolved committer model:\s*(.+)$/m);
  const model = match?.[1]?.trim();
  return model && model !== "memory-committer default" ? model : null;
}

export function buildCommitFailureMessage(error: string): string {
  if (error.includes("timed out")) {
    return [
      `Commit failed: ${error}`,
      "",
      "The committer SDK session was terminated before it finished. If this keeps happening, try a faster or smaller model, or commit more often so `.memory/branches/<branch>/log.jsonl` stays smaller.",
    ].join("\n");
  }

  if (isStructuredToolComplianceFailure(error)) {
    const resolvedModel = extractResolvedModelFromDiagnostics(error);
    const modelSentence = resolvedModel
      ? `The selected committer model appears unable to call the required structured tools for memory_commit: ${resolvedModel}.`
      : "The selected committer model appears unable to call the required structured tools for memory_commit.";

    return [
      `Commit failed: ${error}`,
      "",
      `${modelSentence} This is a model capability/compliance problem, not a memory size problem. If this keeps happening, consider switching to a different model with more reliable tool-use support for structured tool calls.`,
    ].join("\n");
  }

  return [
    `Commit failed: ${error}`,
    "",
    "The committer now runs in a fresh in-memory SDK session. Inspect the memory_commit profile timeline to see whether the slowdown happened during resource loading, session creation, prompting, or synthesis.",
  ].join("\n");
}

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

export function finalizeMemoryCommit(
  summary: string,
  submission: MemoryCommitBlocksSubmission,
  state: MemoryState,
  branches: BranchManager,
  projectDir: string,
  updateRoadmap?: boolean
): string {
  const branch = state.activeBranch;
  const hash = generateHash();
  const timestamp = new Date().toISOString();

  const record: MemoryCommitRecord = {
    version: 1,
    kind: "commit",
    hash,
    timestamp,
    summary,
    branchPurpose: submission.branchPurpose,
    previousProgressSummary: submission.previousProgressSummary,
    contributionBullets: submission.thisCommitContributionBullets,
  };

  branches.appendCommit(branch, record);
  branches.clearLog(branch);
  branches.writeCommitContext(
    branch,
    buildCommitContextFromSubmission(submission)
  );

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

export function extractCommitSubmission(
  text: string
): MemoryCommitBlocksSubmission | null {
  return parseCommitBlocksSubmission(text);
}
