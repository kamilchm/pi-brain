import type {
  MemoryCommitBlocksSubmission,
  MemoryCommitRecord,
  MemoryChunkSummarySubmission,
  OtaEntryInput,
  PersistedOtaEntry,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");

  return items.length === value.length ? items : null;
}

export function serializeOtaEntry(input: OtaEntryInput): string {
  const entry: PersistedOtaEntry = {
    version: 1,
    ...input,
  };

  return `${JSON.stringify(entry)}\n`;
}

export function parsePersistedOtaEntry(text: string): PersistedOtaEntry | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const actions = parseStringArray(parsed.actions);
    const observations = parseStringArray(parsed.observations);
    if (
      parsed.version !== 1 ||
      typeof parsed.turnNumber !== "number" ||
      typeof parsed.timestamp !== "string" ||
      typeof parsed.model !== "string" ||
      typeof parsed.thought !== "string" ||
      typeof parsed.thinking !== "string" ||
      !actions ||
      !observations
    ) {
      return null;
    }

    return {
      version: 1,
      turnNumber: parsed.turnNumber,
      timestamp: parsed.timestamp,
      model: parsed.model,
      thought: parsed.thought,
      thinking: parsed.thinking,
      actions,
      observations,
    };
  } catch {
    return null;
  }
}

export function parsePersistedOtaLog(content: string): PersistedOtaEntry[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => parsePersistedOtaEntry(line))
    .filter((entry): entry is PersistedOtaEntry => entry !== null);
}

export function serializeMemoryCommitRecord(
  record: MemoryCommitRecord
): string {
  return `${JSON.stringify(record)}\n`;
}

export function parseMemoryCommitRecord(
  text: string
): MemoryCommitRecord | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const contributionBullets = parseStringArray(parsed.contributionBullets);
    if (
      parsed.version !== 1 ||
      (parsed.kind !== "commit" && parsed.kind !== "merge") ||
      typeof parsed.hash !== "string" ||
      typeof parsed.timestamp !== "string" ||
      typeof parsed.summary !== "string" ||
      typeof parsed.branchPurpose !== "string" ||
      typeof parsed.previousProgressSummary !== "string" ||
      !contributionBullets
    ) {
      return null;
    }

    const sourceBranch =
      typeof parsed.sourceBranch === "string" ? parsed.sourceBranch : undefined;

    return {
      version: 1,
      kind: parsed.kind,
      hash: parsed.hash,
      timestamp: parsed.timestamp,
      summary: parsed.summary,
      branchPurpose: parsed.branchPurpose,
      previousProgressSummary: parsed.previousProgressSummary,
      contributionBullets,
      ...(sourceBranch ? { sourceBranch } : {}),
    };
  } catch {
    return null;
  }
}

export function parseMemoryCommitHistory(
  content: string
): MemoryCommitRecord[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => parseMemoryCommitRecord(line))
    .filter((record): record is MemoryCommitRecord => record !== null);
}

export function serializeCommitBlocksSubmission(
  submission: MemoryCommitBlocksSubmission
): string {
  return JSON.stringify(submission);
}

export function parseCommitBlocksSubmission(
  text: string
): MemoryCommitBlocksSubmission | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const bullets = parseStringArray(parsed.thisCommitContributionBullets);
    if (
      typeof parsed.branchPurpose !== "string" ||
      typeof parsed.previousProgressSummary !== "string" ||
      !bullets
    ) {
      return null;
    }

    return {
      branchPurpose: parsed.branchPurpose.trim(),
      previousProgressSummary: parsed.previousProgressSummary.trim(),
      thisCommitContributionBullets: bullets,
    };
  } catch {
    return null;
  }
}

export function serializeChunkSummarySubmission(
  submission: MemoryChunkSummarySubmission
): string {
  return JSON.stringify(submission);
}

export function parseChunkSummarySubmission(
  text: string
): MemoryChunkSummarySubmission | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const bullets = parseStringArray(parsed.summaryBullets);
    if (!bullets) {
      return null;
    }

    return { summaryBullets: bullets };
  } catch {
    return null;
  }
}
