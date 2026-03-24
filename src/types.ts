import type { MemoryCommitProgressStage } from "./enums.js";

export interface OtaEntryInput {
  turnNumber: number;
  timestamp: string;
  model: string;
  thought: string;
  thinking: string;
  actions: string[];
  observations: string[];
}

export interface SubagentResult {
  text: string;
  exitCode: number;
  error?: string;
}

export interface MemoryCommitProgress {
  stage: MemoryCommitProgressStage;
  message: string;
  elapsedMs: number;
  branch?: string;
  model?: string;
  logSizeBytes?: number;
  commitsSizeBytes?: number;
  pid?: number;
  exitCode?: number;
  stderrPreview?: string;
}
