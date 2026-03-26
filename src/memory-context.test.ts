import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import fc from "fast-check";

import { BranchManager } from "./branches.js";
import { LOG_SIZE_WARNING_BYTES } from "./constants.js";
import { buildStatusView } from "./memory-context.js";
import { MemoryState } from "./state.js";
import { serializeOtaEntry } from "./structured-memory.js";

function setupMemoryProject(): {
  tmpDir: string;
  state: MemoryState;
  branches: BranchManager;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-context-test-"));
  const memoryDir = path.join(tmpDir, ".memory");
  fs.mkdirSync(path.join(memoryDir, "branches"), { recursive: true });

  const state = new MemoryState(tmpDir);
  const branches = new BranchManager(tmpDir);

  fs.writeFileSync(
    path.join(memoryDir, "state.yaml"),
    'active_branch: main\ninitialized: "2026-02-22T14:00:00Z"'
  );
  state.load();

  branches.createBranch("main", "Main project memory");

  return { tmpDir, state, branches };
}

describe("buildStatusView", () => {
  let tmpDir: string;
  let state: MemoryState;
  let branches: BranchManager;

  beforeEach(() => {
    const setup = setupMemoryProject();
    ({ tmpDir } = setup);
    ({ state } = setup);
    ({ branches } = setup);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return status overview with roadmap and branches", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".memory/main.md"),
      "# Roadmap\n\nGoals here.\n"
    );
    branches.appendCommit("main", {
      version: 1,
      kind: "commit",
      hash: "deadbeef",
      timestamp: "2026-02-22T00:00:00Z",
      summary: "Shipped milestone",
      branchPurpose: "Main project memory",
      previousProgressSummary: "Initial commit.",
      contributionBullets: ["Shipped milestone."],
    });

    const result = buildStatusView(state, branches, tmpDir);

    expect(result).toContain("# Memory Status");
    expect(result).toContain("Roadmap");
    expect(result).toContain("Active branch: main");
    expect(result).toContain("Shipped milestone.");
    expect(result).toContain(
      "Use `read .memory/branches/<name>/commits.jsonl` for full history."
    );
    expect(result).toContain(
      "Use `read .memory/branches/<name>/commit-context.json` for latest branch context."
    );
  });

  it("should handle missing main.md gracefully", () => {
    const result = buildStatusView(state, branches, tmpDir);

    expect(result).toContain("No roadmap found");
    expect(result).toContain("Active branch: main");
  });

  it("should show guidance when main.md exists but is empty", () => {
    fs.writeFileSync(path.join(tmpDir, ".memory/main.md"), "\n\n");

    const result = buildStatusView(state, branches, tmpDir);

    expect(result).toContain("Roadmap is empty");
    expect(result).toContain("Update `.memory/main.md` with project goals");
  });

  it("should warn when log.jsonl exceeds size threshold", () => {
    fs.writeFileSync(path.join(tmpDir, ".memory/main.md"), "# Roadmap\n");
    branches.appendLog("main", "x".repeat(LOG_SIZE_WARNING_BYTES + 1));

    const result = buildStatusView(state, branches, tmpDir);

    expect(result).toContain("**Warning:**");
    expect(result).toContain("log.jsonl is large");
    expect(result).toContain("You should commit");
  });

  it("should not warn when log.jsonl is below threshold", () => {
    fs.writeFileSync(path.join(tmpDir, ".memory/main.md"), "# Roadmap\n");
    branches.appendLog(
      "main",
      serializeOtaEntry({
        turnNumber: 1,
        timestamp: "2026-02-22T00:00:00Z",
        model: "model/test",
        thought: "Small log",
        thinking: "",
        actions: [],
        observations: [],
      })
    );

    const result = buildStatusView(state, branches, tmpDir);

    expect(result).not.toContain("**Warning:**");
  });

  it("should list multiple branches with their latest commit summaries", () => {
    branches.createBranch("feature-a", "Feature A");
    branches.appendCommit("feature-a", {
      version: 1,
      kind: "commit",
      hash: "ff001122",
      timestamp: "2026-02-22T00:00:00Z",
      summary: "Caching milestone",
      branchPurpose: "Feature A",
      previousProgressSummary: "Initial commit.",
      contributionBullets: ["Added caching layer."],
    });

    const result = buildStatusView(state, branches, tmpDir);

    expect(result).toContain("feature-a");
    expect(result).toContain("Added caching layer");
    expect(result).toContain("main");
  });

  it("should show merge provenance in branch summaries", () => {
    branches.createBranch("feature-a", "Feature A");
    branches.appendCommit("feature-a", {
      version: 1,
      kind: "merge",
      hash: "ff001122",
      timestamp: "2026-02-22T00:00:00Z",
      summary: "Merge from branch-b",
      branchPurpose: "Feature A",
      previousProgressSummary: "Initial commit.",
      contributionBullets: ["Merged branch-b conclusions."],
      sourceBranch: "branch-b",
    });

    const result = buildStatusView(state, branches, tmpDir);

    expect(result).toContain(
      "merge from branch-b: Merged branch-b conclusions."
    );
  });

  it("compact mode should truncate roadmap iff it exceeds roadmapCharLimit", () => {
    const roadmapCharLimit = 160;
    const roadmapChunkArb = fc
      .array(fc.constantFrom("a", "b", "c", "d", "e", " ", "\n", "#"), {
        minLength: 1,
        maxLength: 400,
      })
      .map((chars) => chars.join(""));

    fc.assert(
      fc.property(roadmapChunkArb, (roadmapChunk) => {
        const roadmap = `# Roadmap\n\n${roadmapChunk}`;
        fs.writeFileSync(path.join(tmpDir, ".memory/main.md"), roadmap);

        const result = buildStatusView(state, branches, tmpDir, {
          compact: true,
          roadmapCharLimit,
          branchLimit: 8,
        });

        const shouldTruncate = roadmap.trim().length > roadmapCharLimit;
        expect(result.includes("Roadmap truncated")).toBe(shouldTruncate);
      }),
      { numRuns: 60 }
    );
  });

  it("compact mode should cap visible branch rows and report hidden count", () => {
    const branchLimit = 4;
    const branchNameArb = fc
      .array(
        fc.constantFrom(
          "a",
          "b",
          "c",
          "d",
          "e",
          "f",
          "g",
          "h",
          "i",
          "j",
          "k",
          "l",
          "m",
          "n",
          "o",
          "p",
          "q",
          "r",
          "s",
          "t",
          "u",
          "v",
          "w",
          "x",
          "y",
          "z",
          "0",
          "1",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
          "-"
        ),
        { minLength: 1, maxLength: 10 }
      )
      .map((chars) => chars.join(""))
      .filter((name) => name !== "main");

    const extraBranchesArb = fc.uniqueArray(branchNameArb, {
      maxLength: 12,
      selector: (name) => name,
    });

    fc.assert(
      fc.property(extraBranchesArb, (extraBranches) => {
        const setup = setupMemoryProject();
        try {
          fs.writeFileSync(
            path.join(setup.tmpDir, ".memory/main.md"),
            "# Roadmap\n\nCompact branch list validation.\n"
          );

          for (const branch of extraBranches) {
            setup.branches.createBranch(branch, `Purpose ${branch}`);
          }

          const result = buildStatusView(
            setup.state,
            setup.branches,
            setup.tmpDir,
            {
              compact: true,
              branchLimit,
            }
          );

          const renderedBranchLines = result
            .split("\n")
            .filter((line) => line.startsWith("- **"));
          expect(renderedBranchLines.length).toBeLessThanOrEqual(
            branchLimit + 1
          );
        } finally {
          fs.rmSync(setup.tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 40 }
    );
  });
});
