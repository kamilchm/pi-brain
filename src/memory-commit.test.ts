import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BranchManager } from "./branches.js";
import {
  buildCommitFailureMessage,
  executeMemoryCommit,
  finalizeMemoryCommit,
  resolveCommitterModel,
} from "./memory-commit.js";
import { MemoryState } from "./state.js";

describe("resolveCommitterModel", () => {
  it("should prefer an explicit model override", () => {
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

    expect(result).toBe("openai/gpt-5");
  });

  it("should prefer configured model over the current session model", () => {
    const result = resolveCommitterModel(
      {
        summary: "Milestone",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      },
      "google-antigravity/gemini-3-flash"
    );

    expect(result).toBe("google-antigravity/gemini-3-flash");
  });

  it("should inherit the current session model when no override is provided", () => {
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
    expect(message).toContain("log.md");
  });

  it("should explain generic failures with recursion-isolation context", () => {
    const message = buildCommitFailureMessage(
      "Subagent exited with non-zero code"
    );

    expect(message).toContain(
      "Commit failed: Subagent exited with non-zero code"
    );
    expect(message).toContain("extension discovery disabled");
    expect(message).toContain("recursive memory_commit loops");
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
    branches = new BranchManager(tmpDir);
    branches.createBranch("main", "Main branch");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return task string with branch name and summary", () => {
    // Arrange
    branches.appendLog(
      "main",
      "## Turn 1 | 2026-02-22 | anthropic/claude\n\nDid some reasoning.\n"
    );

    // Act
    const result = executeMemoryCommit(
      { summary: "First milestone" },
      state,
      branches
    );

    // Assert
    expect(result.task).toContain('branch "main"');
    expect(result.task).toContain("First milestone");
    expect(result.task).toContain(".memory/branches/main/log.md");
    expect(result.task).toContain(".memory/branches/main/commits.md");
    expect(result.task).toContain(".memory/AGENTS.md");
  });

  it("should return task even when log has no entries", () => {
    // Act
    const result = executeMemoryCommit(
      { summary: "Empty commit" },
      state,
      branches
    );

    // Assert
    expect(result.task).toContain('branch "main"');
  });
});

describe("finalizeMemoryCommit", () => {
  let tmpDir: string;
  let state: MemoryState;
  let branches: BranchManager;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-finalize-test-"));
    const memoryDir = path.join(tmpDir, ".memory");
    fs.mkdirSync(path.join(memoryDir, "branches"), { recursive: true });

    fs.writeFileSync(
      path.join(memoryDir, "state.yaml"),
      'active_branch: main\ninitialized: "2026-02-22T14:00:00Z"'
    );
    // Create root AGENTS.md for updateRootAgentsMd
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# Project\n");

    state = new MemoryState(tmpDir);
    state.load();
    branches = new BranchManager(tmpDir);
    branches.createBranch("main", "Main branch");
    branches.appendLog(
      "main",
      "## Turn 1 | 2026-02-22 | anthropic/claude\n\nSome reasoning.\n"
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should append commit entry to commits.md", () => {
    // Arrange
    const commitContent = [
      "### Branch Purpose",
      "",
      "Main project memory branch.",
      "",
      "### Previous Progress Summary",
      "",
      "No prior commits.",
      "",
      "### This Commit's Contribution",
      "",
      "Established the project architecture.",
    ].join("\n");

    // Act
    finalizeMemoryCommit(
      "First milestone",
      commitContent,
      state,
      branches,
      tmpDir
    );

    // Assert
    const commits = branches.readCommits("main");
    expect(commits).toContain("## Commit");
    expect(commits).toContain("Established the project architecture.");
    expect(commits).toContain("### Branch Purpose");
  });

  it("should clear log.md after commit", () => {
    // Arrange
    const commitContent =
      "### Branch Purpose\n\nMain\n\n### Previous Progress Summary\n\nNone.\n\n### This Commit's Contribution\n\nDone.\n";

    // Act
    finalizeMemoryCommit("Done", commitContent, state, branches, tmpDir);

    // Assert
    expect(branches.readLog("main")).toBe("");
  });

  it("should update state with last commit info", () => {
    vi.setSystemTime(new Date("2026-02-22T15:30:00.000Z"));

    // Arrange
    const commitContent =
      "### Branch Purpose\n\nMain\n\n### Previous Progress Summary\n\nNone.\n\n### This Commit's Contribution\n\nArchitecture decided.\n";

    // Act
    finalizeMemoryCommit(
      "Architecture decided",
      commitContent,
      state,
      branches,
      tmpDir
    );

    // Assert
    expect(state.lastCommit).not.toBeNull();
    expect(state.lastCommit?.branch).toBe("main");
    expect(state.lastCommit?.summary).toBe("Architecture decided");
    expect(state.lastCommit?.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(state.lastCommit?.timestamp).toBe("2026-02-22T15:30:00.000Z");
  });

  it("should not modify root AGENTS.md during commit finalization", () => {
    // Arrange
    const commitContent =
      "### Branch Purpose\n\nMain\n\n### Previous Progress Summary\n\nNone.\n\n### This Commit's Contribution\n\nNew milestone.\n";

    const before = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf8");

    // Act
    finalizeMemoryCommit(
      "New milestone",
      commitContent,
      state,
      branches,
      tmpDir
    );

    // Assert
    const after = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf8");
    expect(after).toBe(before);
  });

  it("should generate a valid 8-char hex hash in the commit entry", () => {
    // Arrange
    const commitContent =
      "### Branch Purpose\n\nMain\n\n### Previous Progress Summary\n\nNone.\n\n### This Commit's Contribution\n\nTest hash.\n";

    // Act
    finalizeMemoryCommit("Test hash", commitContent, state, branches, tmpDir);

    // Assert
    const commits = branches.readCommits("main");
    const hashMatch = /## Commit ([a-f0-9]{8})/.exec(commits);
    expect(hashMatch).not.toBeNull();
  });

  it("should include status view in the result", () => {
    // Arrange
    fs.writeFileSync(
      path.join(tmpDir, ".memory/main.md"),
      "# Roadmap\n\nGoals here.\n"
    );
    const commitContent =
      "### Branch Purpose\n\nMain\n\n### Previous Progress Summary\n\nNone.\n\n### This Commit's Contribution\n\nFirst milestone.\n";

    // Act
    const message = finalizeMemoryCommit(
      "First milestone",
      commitContent,
      state,
      branches,
      tmpDir
    );

    // Assert
    expect(message).toContain("Commit ");
    expect(message).toContain("# Memory Status");
    expect(message).toContain("Active branch: main");
  });

  it("should keep auto-appended status compact when roadmap is large", () => {
    // Arrange
    fs.writeFileSync(
      path.join(tmpDir, ".memory/main.md"),
      `# Roadmap\n\n${"x".repeat(20_000)}`
    );
    const commitContent =
      "### Branch Purpose\n\nMain\n\n### Previous Progress Summary\n\nNone.\n\n### This Commit's Contribution\n\nFirst milestone.\n";

    // Act
    const message = finalizeMemoryCommit(
      "First milestone",
      commitContent,
      state,
      branches,
      tmpDir
    );

    // Assert
    expect(message).toContain("# Memory Status");
    expect(message).toContain("Roadmap truncated");
    expect(message.length).toBeLessThan(5000);
  });

  it("should include roadmap update reminder by default", () => {
    const commitContent =
      "### Branch Purpose\n\nMain\n\n### Previous Progress Summary\n\nNone.\n\n### This Commit's Contribution\n\nMilestone.\n";

    const message = finalizeMemoryCommit(
      "Milestone",
      commitContent,
      state,
      branches,
      tmpDir
    );

    expect(message).toContain("**Action required:** Re-read `.memory/main.md`");
  });

  it("should suppress roadmap update reminder when update_roadmap is false", () => {
    const commitContent =
      "### Branch Purpose\n\nMain\n\n### Previous Progress Summary\n\nNone.\n\n### This Commit's Contribution\n\nTrivial fix.\n";

    const message = finalizeMemoryCommit(
      "Trivial fix",
      commitContent,
      state,
      branches,
      tmpDir,
      false
    );

    expect(message).not.toContain("**Action required:**");
  });
});
