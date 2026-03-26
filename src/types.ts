import type {
  MemoryCommitOperation,
  MemoryCommitProgressStage,
} from "./enums.js";

export interface OtaEntryInput {
  turnNumber: number;
  timestamp: string;
  model: string;
  thought: string;
  thinking: string;
  actions: string[];
  observations: string[];
}

export interface PersistedOtaEntry extends OtaEntryInput {
  version: 1;
}

export interface SubagentResult {
  text: string;
  exitCode: number;
  error?: string;
}

export interface CommitterModelConfig {
  model: string;
  source: string;
}

export interface BranchCommitContext {
  version: 1;
  branchPurpose: string;
  previousProgressSummary: string;
  latestContributionBullets: string[];
}

export interface BranchMetadata {
  version: 1;
  fileStructure: Record<string, string>;
  envConfig: Record<string, string>;
  notes: string[];
}

export interface MemoryCommitRecord {
  version: 1;
  kind: "commit" | "merge";
  hash: string;
  timestamp: string;
  summary: string;
  branchPurpose: string;
  previousProgressSummary: string;
  contributionBullets: string[];
  sourceBranch?: string;
}

export interface MemoryCommitBlocksSubmission {
  branchPurpose: string;
  previousProgressSummary: string;
  thisCommitContributionBullets: string[];
}

export interface MemoryChunkSummarySubmission {
  summaryBullets: string[];
}

export interface MemoryCommitProgress {
  stage: MemoryCommitProgressStage;
  message: string;
  elapsedMs: number;
  branch?: string;
  model?: string;
  logSizeBytes?: number;
  commitsSizeBytes?: number;
  exitCode?: number;
  stderrPreview?: string;
  operation?: MemoryCommitOperation;
  chunkIndex?: number;
  chunkCount?: number;
}

export interface MemoryCommitStaircaseCase {
  key: string;
  turns: number;
  hour: number;
}

export interface SpawnCommitterOptions {
  signal?: AbortSignal;
  model?: string;
  timeoutMs?: number;
  onProgress?: (progress: MemoryCommitProgress) => void;
  promptOverride?: string;
  operation?: MemoryCommitOperation;
  chunkIndex?: number;
  chunkCount?: number;
}

export type SpawnCommitterFunction = (
  cwd: string,
  task: string,
  options?: SpawnCommitterOptions
) => Promise<SubagentResult>;
