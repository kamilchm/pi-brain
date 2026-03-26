import {
  buildCommitContextFromSubmission,
  buildPreviousProgressSummaryForNextCommit,
  createInitialBranchCommitContext,
  deriveBranchCommitContextFromCommits,
} from "./commit-context.js";
import { serializeMemoryCommitRecord } from "./structured-memory.js";

describe("createInitialBranchCommitContext", () => {
  it("should initialize structured branch context from branch purpose", () => {
    expect(createInitialBranchCommitContext("Explore auth flow")).toStrictEqual(
      {
        version: 1,
        branchPurpose: "Explore auth flow",
        previousProgressSummary: "Initial commit.",
        latestContributionBullets: [],
      }
    );
  });
});

describe("buildCommitContextFromSubmission", () => {
  it("should convert a structured submission into branch context", () => {
    expect(
      buildCommitContextFromSubmission({
        branchPurpose: "Keep branch memory aligned with GCC.",
        previousProgressSummary:
          "Established the initial Brain extension architecture.",
        thisCommitContributionBullets: [
          "Added SDK committer scaffolding.",
          "Verified the extension wiring.",
        ],
      })
    ).toStrictEqual({
      version: 1,
      branchPurpose: "Keep branch memory aligned with GCC.",
      previousProgressSummary:
        "Established the initial Brain extension architecture.",
      latestContributionBullets: [
        "Added SDK committer scaffolding.",
        "Verified the extension wiring.",
      ],
    });
  });
});

describe("deriveBranchCommitContextFromCommits", () => {
  it("should derive the latest structured branch context from commits.jsonl", () => {
    const context = deriveBranchCommitContextFromCommits(
      "main",
      [
        serializeMemoryCommitRecord({
          version: 1,
          kind: "commit",
          hash: "aaaabbbb",
          timestamp: "2026-03-25T18:00:00.000Z",
          summary: "First milestone",
          branchPurpose: "Main branch",
          previousProgressSummary: "Initial commit.",
          contributionBullets: ["Added the first milestone."],
        }).trim(),
        serializeMemoryCommitRecord({
          version: 1,
          kind: "commit",
          hash: "ccccdddd",
          timestamp: "2026-03-25T18:30:00.000Z",
          summary: "Second milestone",
          branchPurpose: "Main branch",
          previousProgressSummary: "Added the first milestone.",
          contributionBullets: [
            "Added the second milestone.",
            "Documented the new flow.",
          ],
        }).trim(),
      ].join("\n")
    );

    expect(context).toStrictEqual({
      version: 1,
      branchPurpose: "Main branch",
      previousProgressSummary: "Added the first milestone.",
      latestContributionBullets: [
        "Added the second milestone.",
        "Documented the new flow.",
      ],
    });
  });

  it("should fall back to an initial branch context when there are no commit records", () => {
    const context = deriveBranchCommitContextFromCommits("main", "");

    expect(context).toStrictEqual({
      version: 1,
      branchPurpose: "Branch main",
      previousProgressSummary: "Initial commit.",
      latestContributionBullets: [],
    });
  });
});

describe("buildPreviousProgressSummaryForNextCommit", () => {
  it("should fold the latest contribution into the next commit input summary", () => {
    expect(
      buildPreviousProgressSummaryForNextCommit({
        version: 1,
        branchPurpose: "Main branch",
        previousProgressSummary: "Established the initial architecture.",
        latestContributionBullets: [
          "Added structured commit context.",
          "Switched to SDK-only committer flow.",
        ],
      })
    ).toBe(
      [
        "Established the initial architecture.",
        "",
        "Latest prior milestone:",
        "- Added structured commit context.",
        "- Switched to SDK-only committer flow.",
      ].join("\n")
    );
  });

  it("should collapse to initial commit when nothing has been committed yet", () => {
    expect(
      buildPreviousProgressSummaryForNextCommit({
        version: 1,
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        latestContributionBullets: [],
      })
    ).toBe("Initial commit.");
  });
});
