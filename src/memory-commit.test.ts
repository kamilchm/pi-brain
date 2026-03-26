import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BranchManager } from "./branches.js";
import {
  buildCommitFailureMessage,
  executeMemoryCommit,
  extractCommitSubmission,
  finalizeMemoryCommit,
  formatCommitterModelDiagnostics,
  resolveCommitterModel,
  resolveCommitterModelSelection,
} from "./memory-commit.js";
import { MemoryState } from "./state.js";

describe("resolveCommitterModel", () => {
  it("should prefer configured model over other sources", () => {
    const result = resolveCommitterModel(
      {
        summary: "Milestone",
        model: "openai/gpt-5",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      },
      "google-antigravity/gemini-3-flash"
    );

    expect(result).toBe("google-antigravity/gemini-3-flash");
  });

  it("should inherit the current session model when no configured model is provided", () => {
    const result = resolveCommitterModel(
      {
        summary: "Milestone",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      }
    );

    expect(result).toBe("anthropic/claude-sonnet-4-5");
  });

  it("should fall back to undefined when no model information is available", () => {
    const result = resolveCommitterModel(
      {
        summary: "Milestone",
      },
      null
    );

    expect(result).toBeUndefined();
  });
});

describe("buildCommitFailureMessage", () => {
  it("should explain timeout failures with next-step guidance", () => {
    const message = buildCommitFailureMessage("Subagent timed out after 60s");

    expect(message).toContain("Commit failed: Subagent timed out after 60s");
    expect(message).toContain("terminated before it finished");
    expect(message).toContain("try a faster or smaller model");
    expect(message).toContain("log.jsonl");
  });

  it("should explain generic failures with sdk-session context", () => {
    const message = buildCommitFailureMessage(
      "SDK committer completed without emitting agent_end"
    );

    expect(message).toContain(
      "Commit failed: SDK committer completed without emitting agent_end"
    );
    expect(message).toContain("fresh in-memory SDK session");
    expect(message).toContain("profile timeline");
  });

  it("should explain structured tool-call compliance failures and suggest switching models", () => {
    const message = buildCommitFailureMessage(
      [
        "SDK committer did not submit structured commit blocks",
        "",
        "Resolved committer model: github-copilot/gpt-5.4-mini",
        "Model source: environment variable (PI_BRAIN_COMMIT_MODEL)",
        "Committer runner: sdk",
      ].join("\n")
    );

    expect(message).toContain(
      "selected committer model appears unable to call the required structured tools"
    );
    expect(message).toContain("github-copilot/gpt-5.4-mini");
    expect(message).toContain("consider switching to a different model");
  });
});

describe("resolveCommitterModelSelection", () => {
  it("should report model source from global config", () => {
    const result = resolveCommitterModelSelection(
      { summary: "Milestone", model: "openai/gpt-5" },
      {
        provider: "github-copilot",
        id: "gpt-5.4",
      },
      {
        model: "github-copilot/gpt-5.4-mini",
        source: "global config (~/.pi/agent/extensions/pi-brain.json)",
      }
    );

    expect(result).toStrictEqual({
      model: "github-copilot/gpt-5.4-mini",
      source: "global config (~/.pi/agent/extensions/pi-brain.json)",
    });
  });

  it("should format committer model diagnostics", () => {
    const diagnostics = formatCommitterModelDiagnostics({
      model: "github-copilot/gpt-5.4-mini",
      source: "global config (~/.pi/agent/extensions/pi-brain.json)",
    });

    expect(diagnostics).toContain(
      "Resolved committer model: github-copilot/gpt-5.4-mini"
    );
    expect(diagnostics).toContain(
      "Model source: global config (~/.pi/agent/extensions/pi-brain.json)"
    );
  });
});

describe("extractCommitSubmission", () => {
  it("should parse a structured commit submission", () => {
    expect(
      extractCommitSubmission(
        JSON.stringify({
          branchPurpose: "Main branch",
          previousProgressSummary: "Initial commit.",
          thisCommitContributionBullets: ["Added the first milestone."],
        })
      )
    ).toStrictEqual({
      branchPurpose: "Main branch",
      previousProgressSummary: "Initial commit.",
      thisCommitContributionBullets: ["Added the first milestone."],
    });
  });
});

describe("executeMemoryCommit", () => {
  let tmpDir: string;
  let state: MemoryState;
  let branches: BranchManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-commit-test-"));
    const memoryDir = path.join(tmpDir, ".memory");
    fs.mkdirSync(path.join(memoryDir, "branches"), { recursive: true });

    fs.writeFileSync(
      path.join(memoryDir, "state.yaml"),
      'active_branch: main\ninitialized: "2026-02-22T14:00:00Z"'
    );

    state = new MemoryState(tmpDir);
    state.load();
    branches = {
      readLog: () => "",
      readCommits: () => "",
    } as unknown as BranchManager;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return task string with branch name and summary", () => {
    const result = executeMemoryCommit(
      { summary: "First milestone" },
      state,
      branches
    );

    expect(result.task).toContain('branch "main"');
    expect(result.task).toContain("First milestone");
    expect(result.task).toContain(".memory/branches/main/log.jsonl");
    expect(result.task).toContain(".memory/branches/main/commit-context.json");
    expect(result.task).toContain(".memory/AGENTS.md");
  });

  it("should return task even when log has no entries", () => {
    const result = executeMemoryCommit(
      { summary: "Empty commit" },
      state,
      branches
    );

    expect(result.task).toContain('branch "main"');
  });
});

describe("finalizeMemoryCommit", () => {
  let tmpDir: string;
  let state: MemoryState;
  let branches: BranchManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-finalize-test-"));
    const memoryDir = path.join(tmpDir, ".memory");
    fs.mkdirSync(path.join(memoryDir, "branches"), { recursive: true });

    fs.writeFileSync(
      path.join(memoryDir, "state.yaml"),
      'active_branch: main\ninitialized: "2026-02-22T14:00:00Z"'
    );
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# Project\n");

    const branchesModule = await import("./branches.js");
    state = new MemoryState(tmpDir);
    state.load();
    branches = new branchesModule.BranchManager(tmpDir);
    branches.createBranch("main", "Main branch");
    branches.appendLog(
      "main",
      '{"version":1,"turnNumber":1,"timestamp":"2026-02-22T00:00:00Z","model":"anthropic/claude","thought":"Some reasoning.","thinking":"","actions":[],"observations":[]}\n'
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should append a structured record to commits.jsonl", () => {
    finalizeMemoryCommit(
      "First milestone",
      {
        branchPurpose: "Main project memory branch.",
        previousProgressSummary: "No prior commits.",
        thisCommitContributionBullets: [
          "Established the project architecture.",
        ],
      },
      state,
      branches,
      tmpDir
    );

    const commits = branches.readCommits("main");
    expect(commits).toContain('"summary":"First milestone"');
    expect(commits).toContain('"branchPurpose":"Main project memory branch."');
    expect(commits).toContain("Established the project architecture.");
  });

  it("should update commit-context.json from the finalized submission", () => {
    finalizeMemoryCommit(
      "First milestone",
      {
        branchPurpose: "Main project memory branch.",
        previousProgressSummary: "Established the initial Brain architecture.",
        thisCommitContributionBullets: [
          "Added SDK committer scaffolding.",
          "Verified the extension wiring.",
        ],
      },
      state,
      branches,
      tmpDir
    );

    const commitContext = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".memory", "branches", "main", "commit-context.json"),
        "utf8"
      )
    ) as {
      branchPurpose?: string;
      previousProgressSummary?: string;
      latestContributionBullets?: string[];
    };

    expect(commitContext).toMatchObject({
      branchPurpose: "Main project memory branch.",
      previousProgressSummary: "Established the initial Brain architecture.",
      latestContributionBullets: [
        "Added SDK committer scaffolding.",
        "Verified the extension wiring.",
      ],
    });
  });

  it("should clear log.jsonl after commit", () => {
    finalizeMemoryCommit(
      "Done",
      {
        branchPurpose: "Main",
        previousProgressSummary: "None.",
        thisCommitContributionBullets: ["Done."],
      },
      state,
      branches,
      tmpDir
    );

    expect(branches.readLog("main")).toBe("");
  });

  it("should update state with last commit info", () => {
    vi.setSystemTime(new Date("2026-02-22T15:30:00.000Z"));

    finalizeMemoryCommit(
      "Architecture decided",
      {
        branchPurpose: "Main",
        previousProgressSummary: "None.",
        thisCommitContributionBullets: ["Architecture decided."],
      },
      state,
      branches,
      tmpDir
    );

    expect(state.lastCommit).not.toBeNull();
    expect(state.lastCommit?.branch).toBe("main");
    expect(state.lastCommit?.summary).toBe("Architecture decided");
    expect(state.lastCommit?.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(state.lastCommit?.timestamp).toBe("2026-02-22T15:30:00.000Z");
  });

  it("should not modify root AGENTS.md during commit finalization", () => {
    const before = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf8");

    finalizeMemoryCommit(
      "New milestone",
      {
        branchPurpose: "Main",
        previousProgressSummary: "None.",
        thisCommitContributionBullets: ["New milestone."],
      },
      state,
      branches,
      tmpDir
    );

    const after = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf8");
    expect(after).toBe(before);
  });

  it("should generate a valid 8-char hex hash in the commit entry", () => {
    finalizeMemoryCommit(
      "Test hash",
      {
        branchPurpose: "Main",
        previousProgressSummary: "None.",
        thisCommitContributionBullets: ["Test hash."],
      },
      state,
      branches,
      tmpDir
    );

    const commits = branches.readCommits("main");
    const hashMatch = /"hash":"([a-f0-9]{8})"/.exec(commits);
    expect(hashMatch).not.toBeNull();
  });

  it("should include status view in the result", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".memory/main.md"),
      "# Roadmap\n\nGoals here.\n"
    );

    const message = finalizeMemoryCommit(
      "First milestone",
      {
        branchPurpose: "Main",
        previousProgressSummary: "None.",
        thisCommitContributionBullets: ["First milestone."],
      },
      state,
      branches,
      tmpDir
    );

    expect(message).toContain("Commit ");
    expect(message).toContain("# Memory Status");
    expect(message).toContain("Active branch: main");
  });

  it("should keep auto-appended status compact when roadmap is large", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".memory/main.md"),
      `# Roadmap\n\n${"x".repeat(20_000)}`
    );

    const message = finalizeMemoryCommit(
      "First milestone",
      {
        branchPurpose: "Main",
        previousProgressSummary: "None.",
        thisCommitContributionBullets: ["First milestone."],
      },
      state,
      branches,
      tmpDir
    );

    expect(message).toContain("# Memory Status");
    expect(message).toContain("Roadmap truncated");
    expect(message.length).toBeLessThan(5000);
  });

  it("should include roadmap update reminder by default", () => {
    const message = finalizeMemoryCommit(
      "Milestone",
      {
        branchPurpose: "Main",
        previousProgressSummary: "None.",
        thisCommitContributionBullets: ["Milestone."],
      },
      state,
      branches,
      tmpDir
    );

    expect(message).toContain("**Action required:** Re-read `.memory/main.md`");
  });

  it("should suppress roadmap update reminder when update_roadmap is false", () => {
    const message = finalizeMemoryCommit(
      "Trivial fix",
      {
        branchPurpose: "Main",
        previousProgressSummary: "None.",
        thisCommitContributionBullets: ["Trivial fix."],
      },
      state,
      branches,
      tmpDir,
      false
    );

    expect(message).not.toContain("**Action required:**");
  });
});
