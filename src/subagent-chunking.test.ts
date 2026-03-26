import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemoryCommitProgressStage } from "./enums.js";
import { serializeOtaEntry } from "./structured-memory.js";
import { distillCommitBlocks, splitLogIntoCommitChunks } from "./subagent.js";
import type { BranchCommitContext } from "./types.js";

describe("splitLogIntoCommitChunks", () => {
  it("should split on entry boundaries when the turn limit is exceeded", () => {
    const log = [1, 2, 3]
      .map((turnNumber) =>
        serializeOtaEntry({
          turnNumber,
          timestamp: `2026-03-24T00:0${turnNumber}:00Z`,
          model: "anthropic/claude",
          thought: `Thought ${turnNumber}`,
          thinking: "",
          actions: [],
          observations: [],
        }).trim()
      )
      .join("\n");

    const chunks = splitLogIntoCommitChunks(log, 10_000, 1);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain('"turnNumber": 1');
    expect(chunks[1]).toContain('"turnNumber": 2');
    expect(chunks[2]).toContain('"turnNumber": 3');
  });
});

describe("distillCommitBlocks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-chunking-test-"));
    fs.mkdirSync(path.join(tmpDir, ".memory"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".memory", "AGENTS.md"),
      "# Brain protocol\n"
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should use chunk distillation passes before the final synthesis", async () => {
    const calls: { cwd: string; task: string }[] = [];
    const progress: {
      stage: string;
      message: string;
      elapsedMs: number;
      operation?: string;
      chunkIndex?: number;
      chunkCount?: number;
    }[] = [];
    const branchCommitContext: BranchCommitContext = {
      version: 1,
      branchPurpose: "Main branch",
      previousProgressSummary: "Initial commit.",
      latestContributionBullets: [],
    };

    const result = await distillCommitBlocks(
      tmpDir,
      "main",
      "Chunked commit",
      [1, 2, 3]
        .map((turnNumber) =>
          serializeOtaEntry({
            turnNumber,
            timestamp: `2026-03-24T00:0${turnNumber}:00Z`,
            model: "anthropic/claude",
            thought: `Thought ${turnNumber}`,
            thinking: "",
            actions: [],
            observations: [],
          }).trim()
        )
        .join("\n"),
      branchCommitContext,
      {
        maxChunkBytes: 10_000,
        maxChunkTurns: 1,
        spawnCommitterFn: async (cwd, task, options) => {
          calls.push({ cwd, task });
          options?.onProgress?.({
            stage: MemoryCommitProgressStage.Spawned,
            message: "started",
            elapsedMs: 1,
          });

          if (task.includes("Chunk 1 of 3")) {
            return {
              text: JSON.stringify({
                summaryBullets: ["Summarized the first turn."],
              }),
              exitCode: 0,
            };
          }

          if (task.includes("Chunk 2 of 3")) {
            return {
              text: JSON.stringify({
                summaryBullets: ["Summarized the second turn."],
              }),
              exitCode: 0,
            };
          }

          if (task.includes("Chunk 3 of 3")) {
            return {
              text: JSON.stringify({
                summaryBullets: ["Summarized the third turn."],
              }),
              exitCode: 0,
            };
          }

          return {
            text: JSON.stringify({
              summaryBullets: [
                "Combined chunk summaries into the final commit.",
              ],
            }),
            exitCode: 0,
          };
        },
        onProgress(update) {
          progress.push(update);
        },
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.text).toBe(
      JSON.stringify({
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        thisCommitContributionBullets: [
          "Combined chunk summaries into the final commit.",
        ],
      })
    );
    expect(calls).toHaveLength(4);
    expect(calls[0]?.task).toContain("Chunk 1 of 3");
    expect(calls[1]?.task).toContain("Chunk 2 of 3");
    expect(calls[2]?.task).toContain("Chunk 3 of 3");
    expect(calls[3]?.task).toContain("chunk-summaries.json");
    expect(calls[3]?.task).toContain("submit_memory_chunk_summary");
    expect(progress).toContainEqual(
      expect.objectContaining({
        stage: "chunking",
        operation: "chunk_distill",
        chunkIndex: 1,
        chunkCount: 3,
      })
    );
    expect(progress).toContainEqual(
      expect.objectContaining({
        stage: "synthesizing",
        operation: "contribution_synthesis",
      })
    );
    expect(progress).toContainEqual(
      expect.objectContaining({
        stage: "spawned",
        operation: "chunk_distill",
        chunkIndex: 2,
        chunkCount: 3,
      })
    );
  });

  it("should fall back to a single committer pass when the log fits in one chunk", async () => {
    const calls: { task: string; operation?: string }[] = [];
    const branchCommitContext: BranchCommitContext = {
      version: 1,
      branchPurpose: "Main branch",
      previousProgressSummary: "Initial commit.",
      latestContributionBullets: [],
    };
    const result = await distillCommitBlocks(
      tmpDir,
      "main",
      "Single pass commit",
      serializeOtaEntry({
        turnNumber: 1,
        timestamp: "2026-03-24T00:00:00Z",
        model: "anthropic/claude",
        thought: "Only one turn.",
        thinking: "",
        actions: [],
        observations: [],
      }),
      branchCommitContext,
      {
        maxChunkBytes: 10_000,
        maxChunkTurns: 10,
        spawnCommitterFn: async (_cwd, task, options) => {
          calls.push({ task, operation: options?.operation });
          return {
            text: JSON.stringify({
              branchPurpose: "Main",
              previousProgressSummary: "Initial commit.",
              thisCommitContributionBullets: ["Done."],
            }),
            exitCode: 0,
          };
        },
      }
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toContain(".memory/branches/main/log.jsonl");
    expect(calls[0]?.operation).toBe("single_pass");
  });
});
