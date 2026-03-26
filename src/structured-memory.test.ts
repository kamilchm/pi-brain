import {
  parseChunkSummarySubmission,
  parseCommitBlocksSubmission,
  parseMemoryCommitHistory,
  parseMemoryCommitRecord,
  parsePersistedOtaEntry,
  parsePersistedOtaLog,
  serializeChunkSummarySubmission,
  serializeCommitBlocksSubmission,
  serializeMemoryCommitRecord,
  serializeOtaEntry,
} from "./structured-memory.js";

describe("structured-memory", () => {
  it("should serialize and parse persisted OTA entries", () => {
    const line = serializeOtaEntry({
      turnNumber: 1,
      timestamp: "2026-03-25T00:00:00Z",
      model: "github-copilot/grok-code-fast-1",
      thought: "Investigate the problem.",
      thinking: "",
      actions: ["read(src/index.ts)"],
      observations: ["read: success"],
    });

    expect(parsePersistedOtaEntry(line.trim())).toStrictEqual({
      version: 1,
      turnNumber: 1,
      timestamp: "2026-03-25T00:00:00Z",
      model: "github-copilot/grok-code-fast-1",
      thought: "Investigate the problem.",
      thinking: "",
      actions: ["read(src/index.ts)"],
      observations: ["read: success"],
    });
  });

  it("should parse OTA jsonl logs", () => {
    const log = [
      serializeOtaEntry({
        turnNumber: 1,
        timestamp: "2026-03-25T00:00:00Z",
        model: "model/test",
        thought: "One",
        thinking: "",
        actions: [],
        observations: [],
      }).trim(),
      serializeOtaEntry({
        turnNumber: 2,
        timestamp: "2026-03-25T00:01:00Z",
        model: "model/test",
        thought: "Two",
        thinking: "",
        actions: [],
        observations: [],
      }).trim(),
    ].join("\n");

    expect(parsePersistedOtaLog(log)).toHaveLength(2);
  });

  it("should serialize and parse commit records", () => {
    const line = serializeMemoryCommitRecord({
      version: 1,
      kind: "commit",
      hash: "deadbeef",
      timestamp: "2026-03-25T00:00:00Z",
      summary: "Milestone",
      branchPurpose: "Main branch",
      previousProgressSummary: "Initial commit.",
      contributionBullets: ["Added structured memory records."],
    });

    expect(parseMemoryCommitRecord(line.trim())).toStrictEqual({
      version: 1,
      kind: "commit",
      hash: "deadbeef",
      timestamp: "2026-03-25T00:00:00Z",
      summary: "Milestone",
      branchPurpose: "Main branch",
      previousProgressSummary: "Initial commit.",
      contributionBullets: ["Added structured memory records."],
    });
  });

  it("should parse commit history jsonl", () => {
    const history = [
      serializeMemoryCommitRecord({
        version: 1,
        kind: "commit",
        hash: "aaaa1111",
        timestamp: "2026-03-25T00:00:00Z",
        summary: "First",
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        contributionBullets: ["First step."],
      }).trim(),
      serializeMemoryCommitRecord({
        version: 1,
        kind: "merge",
        hash: "bbbb2222",
        timestamp: "2026-03-25T00:05:00Z",
        summary: "Merge from branch-x",
        branchPurpose: "Main branch",
        previousProgressSummary: "First step.",
        contributionBullets: ["Merged branch-x."],
        sourceBranch: "branch-x",
      }).trim(),
    ].join("\n");

    expect(parseMemoryCommitHistory(history)).toHaveLength(2);
  });

  it("should serialize and parse commit block submissions", () => {
    const text = serializeCommitBlocksSubmission({
      branchPurpose: "Main branch",
      previousProgressSummary: "Initial commit.",
      thisCommitContributionBullets: ["Added structured commit output."],
    });

    expect(parseCommitBlocksSubmission(text)).toStrictEqual({
      branchPurpose: "Main branch",
      previousProgressSummary: "Initial commit.",
      thisCommitContributionBullets: ["Added structured commit output."],
    });
  });

  it("should serialize and parse chunk summary submissions", () => {
    const text = serializeChunkSummarySubmission({
      summaryBullets: ["Captured a decision.", "Captured a rejection."],
    });

    expect(parseChunkSummarySubmission(text)).toStrictEqual({
      summaryBullets: ["Captured a decision.", "Captured a rejection."],
    });
  });
});
