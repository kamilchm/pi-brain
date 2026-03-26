import {
  formatCommitRecordOrientation,
  formatCommitRecordSummary,
} from "./commit-presentation.js";

describe("formatCommitRecordSummary", () => {
  it("should prefer the first contribution bullet for normal commits", () => {
    expect(
      formatCommitRecordSummary({
        version: 1,
        kind: "commit",
        hash: "deadbeef",
        timestamp: "2026-03-25T00:00:00Z",
        summary: "Checkpoint summary",
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        contributionBullets: ["Added the new structured commit flow."],
      })
    ).toBe("Added the new structured commit flow.");
  });

  it("should include merge provenance for merge commits", () => {
    expect(
      formatCommitRecordSummary({
        version: 1,
        kind: "merge",
        hash: "cafebabe",
        timestamp: "2026-03-25T00:10:00Z",
        summary: "Merge from branch-x",
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        contributionBullets: ["Merged branch-x conclusions."],
        sourceBranch: "branch-x",
      })
    ).toBe("merge from branch-x: Merged branch-x conclusions.");
  });
});

describe("formatCommitRecordOrientation", () => {
  it("should render a compact orientation block for the latest commit", () => {
    const text = formatCommitRecordOrientation({
      version: 1,
      kind: "merge",
      hash: "cafebabe",
      timestamp: "2026-03-25T00:10:00Z",
      summary: "Merge from branch-x",
      branchPurpose: "Main branch",
      previousProgressSummary: "Initial commit.",
      contributionBullets: [
        "Merged branch-x conclusions.",
        "Recorded the surviving decision.",
      ],
      sourceBranch: "branch-x",
    });

    expect(text).toContain("Latest commit: Merge from branch-x (cafebabe)");
    expect(text).toContain("Kind: merge from branch-x");
    expect(text).toContain("- Merged branch-x conclusions.");
    expect(text).toContain("- Recorded the surviving decision.");
  });
});
