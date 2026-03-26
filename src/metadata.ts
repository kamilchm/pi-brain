import type { BranchMetadata } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

export function createInitialBranchMetadata(): BranchMetadata {
  return {
    version: 1,
    fileStructure: {},
    envConfig: {},
    notes: [],
  };
}

export function parseBranchMetadata(text: string): BranchMetadata | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    if (
      parsed.version !== 1 ||
      !isStringMap(parsed.fileStructure) ||
      !isStringMap(parsed.envConfig) ||
      !isStringArray(parsed.notes)
    ) {
      return null;
    }

    return {
      version: 1,
      fileStructure: parsed.fileStructure,
      envConfig: parsed.envConfig,
      notes: parsed.notes,
    };
  } catch {
    return null;
  }
}

export function serializeBranchMetadata(metadata: BranchMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}
