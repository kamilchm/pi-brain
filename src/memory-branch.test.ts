import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BranchManager } from "./branches.js";
import { executeMemoryBranch } from "./memory-branch.js";
import { MemoryState } from "./state.js";

describe("executeMemoryBranch", () => {
  let tmpDir: string;
  let state: MemoryState;
  let branches: BranchManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-branch-tool-test-"));
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

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create a new branch and switch to it", () => {
    const result = executeMemoryBranch(
      { action: "create", name: "explore-redis", purpose: "Evaluate Redis" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("explore-redis");
    expect(branches.branchExists("explore-redis")).toBeTruthy();
    expect(state.activeBranch).toBe("explore-redis");
  });

  it("should initialize commit-context.json with branch purpose", () => {
    executeMemoryBranch(
      { action: "create", name: "explore-redis", purpose: "Evaluate Redis" },
      state,
      branches,
      tmpDir
    );

    expect(branches.readCommitContext("explore-redis")).toMatchObject({
      branchPurpose: "Evaluate Redis",
    });
  });

  it("should reject duplicate branch names on create", () => {
    const result = executeMemoryBranch(
      { action: "create", name: "main", purpose: "Duplicate" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("already exists");
  });

  it("should require name and purpose for create", () => {
    const result = executeMemoryBranch(
      { action: "create" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("required");
  });

  it("should switch to an existing branch", () => {
    branches.createBranch("feature-x", "Feature X");

    const result = executeMemoryBranch(
      { action: "switch", branch: "feature-x" },
      state,
      branches,
      tmpDir
    );

    expect(state.activeBranch).toBe("feature-x");
    expect(result).toContain("feature-x");
  });

  it("should return latest commit on switch for orientation", () => {
    branches.createBranch("feature-x", "Feature X");
    branches.appendCommit("feature-x", {
      version: 1,
      kind: "commit",
      hash: "a1b2c3d4",
      timestamp: "2026-02-22T00:00:00Z",
      summary: "Redis viability",
      branchPurpose: "Feature X",
      previousProgressSummary: "Initial commit.",
      contributionBullets: ["Redis is viable."],
    });

    const result = executeMemoryBranch(
      { action: "switch", branch: "feature-x" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("Latest commit: Redis viability");
    expect(result).toContain("(a1b2c3d4)");
    expect(result).toContain("Kind: commit");
    expect(result).toContain("Redis is viable.");
  });

  it("should include merge provenance in switch orientation", () => {
    branches.createBranch("feature-x", "Feature X");
    branches.appendCommit("feature-x", {
      version: 1,
      kind: "merge",
      hash: "feedface",
      timestamp: "2026-02-22T00:00:00Z",
      summary: "Merge from branch-y",
      branchPurpose: "Feature X",
      previousProgressSummary: "Initial commit.",
      contributionBullets: ["Merged branch-y conclusions."],
      sourceBranch: "branch-y",
    });

    const result = executeMemoryBranch(
      { action: "switch", branch: "feature-x" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("Kind: merge from branch-y");
    expect(result).toContain("Merged branch-y conclusions.");
  });

  it("should reject switching to nonexistent branch", () => {
    const result = executeMemoryBranch(
      { action: "switch", branch: "nope" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("not found");
    expect(state.activeBranch).toBe("main");
  });

  it("should require branch for switch", () => {
    const result = executeMemoryBranch(
      { action: "switch" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("required");
  });

  it("should append a structured merge commit to the current branch", () => {
    branches.createBranch("explore-redis", "Evaluate Redis");
    branches.appendCommit("explore-redis", {
      version: 1,
      kind: "commit",
      hash: "a1b2c3d4",
      timestamp: "2026-02-22T00:00:00Z",
      summary: "Redis viability",
      branchPurpose: "Evaluate Redis",
      previousProgressSummary: "Initial commit.",
      contributionBullets: ["Redis is viable."],
    });

    const result = executeMemoryBranch(
      {
        action: "merge",
        branch: "explore-redis",
        synthesis: "Redis confirmed as caching layer.",
      },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("Merge commit");
    const latest = branches.getLatestCommit("main");
    expect(latest).toMatchObject({
      kind: "merge",
      sourceBranch: "explore-redis",
    });
    expect(latest?.contributionBullets).toContain(
      "Redis confirmed as caching layer."
    );
  });

  it("should reject merging a branch into itself", () => {
    const result = executeMemoryBranch(
      { action: "merge", branch: "main", synthesis: "Self merge." },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("Cannot merge");
  });

  it("should reject merging a nonexistent branch", () => {
    const result = executeMemoryBranch(
      { action: "merge", branch: "nonexistent", synthesis: "Missing." },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("not found");
  });

  it("should require branch and synthesis for merge", () => {
    const result = executeMemoryBranch(
      { action: "merge" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("required");
  });

  it("should update state with last commit info on merge", () => {
    vi.setSystemTime(new Date("2026-02-22T16:00:00.000Z"));
    branches.createBranch("explore-redis", "Evaluate Redis");

    executeMemoryBranch(
      {
        action: "merge",
        branch: "explore-redis",
        synthesis: "Merged Redis findings.",
      },
      state,
      branches,
      tmpDir
    );

    expect(state.lastCommit).not.toBeNull();
    expect(state.lastCommit?.branch).toBe("main");
    expect(state.lastCommit?.summary).toContain("Merge from explore-redis");
  });

  it("should reject invalid action values", () => {
    const result = executeMemoryBranch(
      { action: "delete" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("Unknown action");
  });

  it("should include status view in create result", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".memory/main.md"),
      "# Roadmap\n\nGoals.\n"
    );

    const result = executeMemoryBranch(
      { action: "create", name: "test-branch", purpose: "Testing" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("Created branch");
    expect(result).toContain("# Memory Status");
    expect(result).toContain("Active branch: test-branch");
  });

  it("should include status view in switch result", () => {
    branches.createBranch("feature-x", "Feature X");
    fs.writeFileSync(
      path.join(tmpDir, ".memory/main.md"),
      "# Roadmap\n\nGoals.\n"
    );

    const result = executeMemoryBranch(
      { action: "switch", branch: "feature-x" },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("Switched to branch");
    expect(result).toContain("# Memory Status");
    expect(result).toContain("Active branch: feature-x");
  });

  it("should include status view in merge result", () => {
    branches.createBranch("feature-x", "Feature X");
    fs.writeFileSync(
      path.join(tmpDir, ".memory/main.md"),
      "# Roadmap\n\nGoals.\n"
    );

    const result = executeMemoryBranch(
      { action: "merge", branch: "feature-x", synthesis: "Merged." },
      state,
      branches,
      tmpDir
    );

    expect(result).toContain("Merge commit");
    expect(result).toContain("# Memory Status");
    expect(result).toContain("Active branch: main");
  });
});
