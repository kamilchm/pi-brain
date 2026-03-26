import { parseMemoryCommitHistory } from "./structured-memory.js";
import type {
  BranchCommitContext,
  MemoryCommitBlocksSubmission,
  MemoryCommitRecord,
} from "./types.js";

function normalizeBullets(bullets: string[]): string[] {
  return bullets
    .map((bullet) => bullet.trim())
    .filter((bullet) => bullet !== "");
}

export function createInitialBranchCommitContext(
  branchPurpose: string
): BranchCommitContext {
  return {
    version: 1,
    branchPurpose,
    previousProgressSummary: "Initial commit.",
    latestContributionBullets: [],
  };
}

export function buildCommitContextFromSubmission(
  submission: MemoryCommitBlocksSubmission
): BranchCommitContext {
  return {
    version: 1,
    branchPurpose: submission.branchPurpose.trim(),
    previousProgressSummary: submission.previousProgressSummary.trim(),
    latestContributionBullets: normalizeBullets(
      submission.thisCommitContributionBullets
    ),
  };
}

function buildCommitContextFromRecord(
  record: MemoryCommitRecord
): BranchCommitContext {
  return {
    version: 1,
    branchPurpose: record.branchPurpose,
    previousProgressSummary: record.previousProgressSummary,
    latestContributionBullets: normalizeBullets(record.contributionBullets),
  };
}

export function deriveBranchCommitContextFromCommits(
  branch: string,
  commitsContent: string
): BranchCommitContext {
  const records = parseMemoryCommitHistory(commitsContent);
  const latestRecord = records.at(-1);
  if (!latestRecord) {
    return createInitialBranchCommitContext(`Branch ${branch}`);
  }

  return buildCommitContextFromRecord(latestRecord);
}

export function buildPreviousProgressSummaryForNextCommit(
  context: BranchCommitContext
): string {
  const previousSummary = context.previousProgressSummary.trim();
  const latestContributionBullets = normalizeBullets(
    context.latestContributionBullets
  );

  if (latestContributionBullets.length === 0) {
    return previousSummary || "Initial commit.";
  }

  if (previousSummary === "" || previousSummary === "Initial commit.") {
    return latestContributionBullets.map((bullet) => `- ${bullet}`).join("\n");
  }

  return [
    previousSummary,
    "",
    "Latest prior milestone:",
    ...latestContributionBullets.map((bullet) => `- ${bullet}`),
  ].join("\n");
}
