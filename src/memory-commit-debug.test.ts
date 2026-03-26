import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemoryCommitProgressStage } from "./enums.js";
import {
  buildSyntheticOtaLog,
  buildMemoryCommitPrompt,
  buildMemoryCommitProfile,
  getDefaultMemoryCommitStaircaseCases,
  prepareMemoryCommitBranch,
  runMemoryCommitStaircase,
  setActiveMemoryBranch,
  summarizeMemoryCommitJsonl,
} from "./memory-commit-debug.js";

describe("prepareMemoryCommitBranch", () => {
  it("should create a branch workspace and switch active_branch", () => {
    const projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "memory-commit-debug-")
    );

    try {
      const memoryDir = path.join(projectDir, ".memory");
      fs.mkdirSync(path.join(memoryDir, "branches"), { recursive: true });
      fs.writeFileSync(
        path.join(memoryDir, "state.yaml"),
        ["active_branch: main", 'initialized: "2026-03-25T00:00:00Z"'].join(
          "\n"
        )
      );

      prepareMemoryCommitBranch({
        projectDir,
        branch: "tiny-rerun",
        purpose: "Tiny rerun branch",
        logContent:
          '{"version":1,"turnNumber":1,"timestamp":"2026-03-25T00:00:00Z","model":"model/test","thought":"Tiny rerun log.","thinking":"","actions":[],"observations":[]}\n',
      });

      const stateYaml = fs.readFileSync(
        path.join(memoryDir, "state.yaml"),
        "utf8"
      );
      const commits = fs.readFileSync(
        path.join(memoryDir, "branches", "tiny-rerun", "commits.jsonl"),
        "utf8"
      );
      const commitContext = fs.readFileSync(
        path.join(memoryDir, "branches", "tiny-rerun", "commit-context.json"),
        "utf8"
      );
      const log = fs.readFileSync(
        path.join(memoryDir, "branches", "tiny-rerun", "log.jsonl"),
        "utf8"
      );

      expect(stateYaml).toContain('active_branch: "tiny-rerun"');
      expect(commits).toBe("");
      expect(commitContext).toContain("Tiny rerun branch");
      expect(log).toContain("Tiny rerun log.");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("should switch the active branch without overwriting branch files", () => {
    const projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "memory-commit-switch-")
    );

    try {
      const memoryDir = path.join(projectDir, ".memory");
      const branchDir = path.join(memoryDir, "branches", "main");
      fs.mkdirSync(branchDir, { recursive: true });
      fs.writeFileSync(
        path.join(memoryDir, "state.yaml"),
        ["active_branch: tiny", 'initialized: "2026-03-25T00:00:00Z"'].join(
          "\n"
        )
      );
      fs.writeFileSync(path.join(branchDir, "commits.jsonl"), "# main\n");

      setActiveMemoryBranch(projectDir, "main");

      const stateYaml = fs.readFileSync(
        path.join(memoryDir, "state.yaml"),
        "utf8"
      );
      const commits = fs.readFileSync(
        path.join(branchDir, "commits.jsonl"),
        "utf8"
      );

      expect(stateYaml).toContain('active_branch: "main"');
      expect(commits).toBe("# main\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("buildMemoryCommitPrompt", () => {
  it("should build a deterministic prompt for the outer pi invocation", () => {
    const prompt = buildMemoryCommitPrompt("Checkpoint", false);

    expect(prompt).toContain("Use the memory_commit tool now");
    expect(prompt).toContain('summary "Checkpoint"');
    expect(prompt).toContain("update_roadmap false");
    expect(prompt).toContain("Report the exact tool result only.");
  });
});

describe("summarizeMemoryCommitJsonl", () => {
  it("should extract progress updates and derive a profile timeline", () => {
    const jsonl = [
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "memory_commit",
        args: { summary: "First" },
      }),
      JSON.stringify({
        type: "tool_execution_update",
        toolName: "memory_commit",
        partialResult: {
          content: [{ type: "text", text: "Starting memory committer..." }],
          details: {
            stage: "starting",
            message: "Starting memory committer...",
            elapsedMs: 0.2,
          },
        },
      }),
      JSON.stringify({
        type: "tool_execution_update",
        toolName: "memory_commit",
        partialResult: {
          content: [{ type: "text", text: "Reloaded SDK resources." }],
          details: {
            stage: "loading_resources",
            message: "Reloaded SDK resources.",
            elapsedMs: 31.4,
            operation: "single_pass",
          },
        },
      }),
      JSON.stringify({
        type: "tool_execution_update",
        toolName: "memory_commit",
        partialResult: {
          content: [
            { type: "text", text: "Memory committer produced output." },
          ],
          details: {
            stage: "stdout",
            message: "Memory committer produced output.",
            elapsedMs: 90.9,
            operation: "single_pass",
          },
        },
      }),
      JSON.stringify({
        type: "tool_execution_update",
        toolName: "memory_commit",
        partialResult: {
          content: [
            { type: "text", text: "Memory committer finished successfully." },
          ],
          details: {
            stage: "finished",
            message: "Memory committer finished successfully.",
            elapsedMs: 120.1,
            operation: "single_pass",
          },
        },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolName: "memory_commit",
        isError: false,
        result: {
          content: [
            { type: "text", text: 'Commit abc written to branch "tiny".' },
          ],
        },
      }),
    ].join("\n");

    const summary = summarizeMemoryCommitJsonl(jsonl);

    expect(summary.invocations).toHaveLength(1);
    expect(summary.invocations[0]).toMatchObject({
      args: { summary: "First" },
      updates: [
        "Starting memory committer...",
        "Reloaded SDK resources.",
        "Memory committer produced output.",
        "Memory committer finished successfully.",
      ],
      finalText: 'Commit abc written to branch "tiny".',
      isError: false,
    });
    expect(summary.invocations[0]?.progress).toHaveLength(4);
    expect(summary.invocations[0]?.profile).toMatchObject({
      totalElapsedMs: 120.1,
    });
    expect(summary.invocations[0]?.profile?.timeline[1]).toMatchObject({
      stage: "loading_resources",
      elapsedMs: 31.4,
      deltaMs: 31.2,
    });
    expect(summary.invocations[0]?.profile?.stageTotals[0]).toMatchObject({
      stage: "loading_resources",
      durationMs: 59.5,
    });
  });
});

describe("buildMemoryCommitProfile", () => {
  it("should sort stage totals by descending duration", () => {
    const profile = buildMemoryCommitProfile([
      {
        stage: MemoryCommitProgressStage.Starting,
        message: "start",
        elapsedMs: 0,
      },
      {
        stage: MemoryCommitProgressStage.LoadingResources,
        message: "load",
        elapsedMs: 10,
      },
      {
        stage: MemoryCommitProgressStage.CreatingSession,
        message: "create",
        elapsedMs: 50,
      },
      {
        stage: MemoryCommitProgressStage.Finished,
        message: "done",
        elapsedMs: 70,
      },
    ]);

    expect(profile.totalElapsedMs).toBe(70);
    expect(profile.stageTotals).toStrictEqual([
      { stage: "loading_resources", durationMs: 40 },
      { stage: "creating_session", durationMs: 20 },
      { stage: "starting", durationMs: 10 },
    ]);
  });
});

describe("buildSyntheticOtaLog", () => {
  it("should generate deterministic structured OTA log entries", () => {
    const log = buildSyntheticOtaLog({
      turns: 3,
      label: "small",
      model: "github-copilot/gemini-3-flash-preview",
      hour: 2,
    });

    const entries = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      version: 1,
      turnNumber: 1,
      model: "github-copilot/gemini-3-flash-preview",
      thought: "Turn 1 for small test.",
    });
    expect(entries[2]).toMatchObject({
      turnNumber: 3,
      timestamp: "2026-03-26T02:03:00Z",
      actions: ["read(file3)"],
      observations: ["read: success"],
    });
  });
});

describe("runMemoryCommitStaircase", () => {
  it("should run the default staircase plan and summarize each case", () => {
    const projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "memory-commit-staircase-")
    );

    try {
      fs.mkdirSync(path.join(projectDir, ".memory", "branches"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(projectDir, ".memory", "state.yaml"), "");

      const calls: Record<string, unknown>[] = [];
      const progress: Record<string, unknown>[] = [];
      const result = runMemoryCommitStaircase(
        {
          projectDir,
          model: "github-copilot/gemini-3-flash-preview",
          branchPrefix: "rerun",
          summaryPrefix: "Gemini rerun",
          purposePrefix: "Gemini rerun branch",
          onProgress: (event) => {
            progress.push({ ...event });
          },
        },
        (options) => {
          calls.push({
            projectDir: options.projectDir,
            summary: options.summary,
            updateRoadmap: options.updateRoadmap,
            jsonlPath: options.jsonlPath,
          });

          return {
            stdout: [
              JSON.stringify({
                type: "tool_execution_start",
                toolName: "memory_commit",
                args: {
                  summary: options.summary,
                  update_roadmap: options.updateRoadmap,
                },
              }),
              JSON.stringify({
                type: "tool_execution_update",
                toolName: "memory_commit",
                partialResult: {
                  content: [{ type: "text", text: "Starting..." }],
                  details: {
                    stage: "starting",
                    message: "Starting...",
                    elapsedMs: 0.5,
                  },
                },
              }),
              JSON.stringify({
                type: "tool_execution_end",
                toolName: "memory_commit",
                isError: false,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Commit ok written to branch "${String(options.summary).replace("Gemini rerun ", "rerun-")}".`,
                    },
                  ],
                },
              }),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
      );

      expect(calls).toHaveLength(getDefaultMemoryCommitStaircaseCases().length);
      expect(calls[0]).toMatchObject({
        projectDir,
        summary: "Gemini rerun tiny",
        updateRoadmap: false,
      });
      expect(result.cases).toHaveLength(
        getDefaultMemoryCommitStaircaseCases().length
      );
      expect(progress[0]).toMatchObject({
        stage: "case_start",
        caseIndex: 1,
        caseCount: getDefaultMemoryCommitStaircaseCases().length,
        key: "tiny",
        branch: "rerun-tiny",
      });
      expect(result.cases[0]).toMatchObject({
        key: "tiny",
        turns: 1,
        branch: "rerun-tiny",
        finalText: 'Commit ok written to branch "rerun-tiny".',
        totalElapsedMs: 0.5,
        isError: false,
      });
      expect(progress.at(-1)).toMatchObject({
        stage: "case_finish",
        key: "stress100",
        branch: "rerun-stress100",
        totalElapsedMs: 0.5,
        exitCode: 0,
        isError: false,
      });
      const stressLog = fs.readFileSync(
        path.join(
          projectDir,
          ".memory",
          "branches",
          "rerun-stress100",
          "log.jsonl"
        ),
        "utf8"
      );

      expect(stressLog.trim().split("\n")).toHaveLength(100);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
