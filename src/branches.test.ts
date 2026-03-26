import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BranchManager } from "./branches.js";
import {
  serializeMemoryCommitRecord,
  serializeOtaEntry,
} from "./structured-memory.js";

describe("branchManager", () => {
  let tmpDir: string;
  let memoryDir: string;
  let manager: BranchManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-branch-test-"));
    memoryDir = path.join(tmpDir, ".memory");
    fs.mkdirSync(path.join(memoryDir, "branches"), { recursive: true });
    manager = new BranchManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createBranch", () => {
    it("should create log.jsonl, commits.jsonl, metadata.json, and commit-context.json", () => {
      manager.createBranch("feature-x", "Explore feature X");

      const branchDir = path.join(memoryDir, "branches/feature-x");
      expect(fs.existsSync(path.join(branchDir, "log.jsonl"))).toBeTruthy();
      expect(fs.existsSync(path.join(branchDir, "commits.jsonl"))).toBeTruthy();
      expect(fs.existsSync(path.join(branchDir, "metadata.json"))).toBeTruthy();
      expect(
        fs.existsSync(path.join(branchDir, "commit-context.json"))
      ).toBeTruthy();
    });

    it("should initialize commit-context.json with structured branch context", () => {
      manager.createBranch("feature-x", "Explore feature X");

      const context = JSON.parse(
        fs.readFileSync(
          path.join(memoryDir, "branches/feature-x/commit-context.json"),
          "utf8"
        )
      ) as {
        branchPurpose?: string;
        previousProgressSummary?: string;
        latestContributionBullets?: string[];
      };

      expect(context.branchPurpose).toBe("Explore feature X");
      expect(context.previousProgressSummary).toBe("Initial commit.");
      expect(context.latestContributionBullets).toStrictEqual([]);
    });

    it("should initialize metadata.json with structured metadata", () => {
      manager.createBranch("feature-x", "Explore feature X");

      expect(
        fs.readFileSync(
          path.join(memoryDir, "branches/feature-x/metadata.json"),
          "utf8"
        )
      ).toContain('"version": 1');
    });

    it("should handle branch names with slashes", () => {
      manager.createBranch("feature/auth", "Auth work");

      const branchDir = path.join(memoryDir, "branches/feature/auth");
      expect(fs.existsSync(branchDir)).toBeTruthy();
      expect(manager.branchExists("feature/auth")).toBeTruthy();
    });
  });

  describe("appendLog", () => {
    it("should append structured jsonl content to the branch log", () => {
      manager.createBranch("main", "Main branch");

      manager.appendLog(
        "main",
        serializeOtaEntry({
          turnNumber: 1,
          timestamp: "2026-02-22T00:00:00Z",
          model: "anthropic/claude",
          thought: "Some content",
          thinking: "",
          actions: [],
          observations: [],
        })
      );
      manager.appendLog(
        "main",
        serializeOtaEntry({
          turnNumber: 2,
          timestamp: "2026-02-22T00:01:00Z",
          model: "anthropic/claude",
          thought: "More content",
          thinking: "",
          actions: [],
          observations: [],
        })
      );

      const log = manager.readLog("main");
      expect(log).toContain('"turnNumber":1');
      expect(log).toContain('"turnNumber":2');
    });
  });

  describe("appendCommit", () => {
    it("should append a structured commit entry to commits.jsonl", () => {
      manager.createBranch("main", "Main branch");

      manager.appendCommit("main", {
        version: 1,
        kind: "commit",
        hash: "a1b2c3d4",
        timestamp: "2026-02-22T00:00:00Z",
        summary: "Initial milestone",
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        contributionBullets: ["Added the first milestone."],
      });

      const commits = manager.readCommits("main");
      expect(commits).toContain('"hash":"a1b2c3d4"');
      expect(commits).toContain('"summary":"Initial milestone"');
    });
  });

  describe("readLog / readCommits", () => {
    it("should return empty string if files are missing", () => {
      expect(manager.readLog("nonexistent")).toBe("");
      expect(manager.readCommits("nonexistent")).toBe("");
    });
  });

  describe("clearLog", () => {
    it("should clear the log file", () => {
      manager.createBranch("main", "Main branch");
      manager.appendLog(
        "main",
        serializeOtaEntry({
          turnNumber: 1,
          timestamp: "2026-02-22T00:00:00Z",
          model: "anthropic/claude",
          thought: "Some content",
          thinking: "",
          actions: [],
          observations: [],
        })
      );

      manager.clearLog("main");

      expect(manager.readLog("main")).toBe("");
    });
  });

  describe("listBranches", () => {
    it("should list only directories in .memory/branches/", () => {
      manager.createBranch("main", "Main branch");
      manager.createBranch("feature-a", "Feature A");
      fs.writeFileSync(path.join(memoryDir, "branches/.gitkeep"), "");

      const branches = manager.listBranches();

      expect(branches).toContain("main");
      expect(branches).toContain("feature-a");
      expect(branches).not.toContain(".gitkeep");
    });

    it("should return empty array if branches dir is missing", () => {
      fs.rmSync(path.join(memoryDir, "branches"), { recursive: true });

      expect(manager.listBranches()).toStrictEqual([]);
    });

    it("should return branches in sorted order for deterministic status output", () => {
      class BranchManagerWithCustomEntries extends BranchManager {
        private readonly entries: readonly string[];

        constructor(projectDir: string, entries: readonly string[]) {
          super(projectDir);
          this.entries = entries;
        }

        protected override readBranchEntries(): string[] {
          return [...this.entries];
        }
      }

      manager.createBranch("zeta", "Zeta");
      manager.createBranch("alpha", "Alpha");
      manager.createBranch("main", "Main");
      manager.createBranch("beta", "Beta");

      const customOrderManager = new BranchManagerWithCustomEntries(tmpDir, [
        "zeta",
        "main",
        "beta",
        "alpha",
      ]);

      expect(customOrderManager.listBranches()).toStrictEqual([
        "alpha",
        "beta",
        "main",
        "zeta",
      ]);
    });
  });

  describe("getLogTurnCount", () => {
    it("should count jsonl log entries", () => {
      manager.createBranch("main", "Main branch");
      for (let turnNumber = 1; turnNumber <= 3; turnNumber += 1) {
        manager.appendLog(
          "main",
          serializeOtaEntry({
            turnNumber,
            timestamp: `2026-02-22T00:0${turnNumber}:00Z`,
            model: "model/test",
            thought: `Turn ${turnNumber}`,
            thinking: "",
            actions: [],
            observations: [],
          })
        );
      }

      expect(manager.getLogTurnCount("main")).toBe(3);
    });

    it("should return 0 for empty or missing log", () => {
      expect(manager.getLogTurnCount("nonexistent")).toBe(0);
      manager.createBranch("main", "Main branch");
      expect(manager.getLogTurnCount("main")).toBe(0);
    });
  });

  describe("getLogSizeBytes", () => {
    it("should return file size in bytes", () => {
      manager.createBranch("main", "Main branch");
      manager.appendLog("main", "x".repeat(1000));

      expect(manager.getLogSizeBytes("main")).toBe(1000);
    });

    it("should return 0 for missing branch", () => {
      expect(manager.getLogSizeBytes("nonexistent")).toBe(0);
    });

    it("should return 0 for empty log", () => {
      manager.createBranch("main", "Main branch");
      expect(manager.getLogSizeBytes("main")).toBe(0);
    });
  });

  describe("getLatestCommit", () => {
    it("should return null for empty commits.jsonl", () => {
      manager.createBranch("main", "Main branch");
      expect(manager.getLatestCommit("main")).toBeNull();
    });

    it("should return null for missing branch", () => {
      expect(manager.getLatestCommit("nonexistent")).toBeNull();
    });

    it("should return the last structured commit record", () => {
      manager.createBranch("main", "Main branch");
      manager.appendCommit("main", {
        version: 1,
        kind: "commit",
        hash: "aaaa1111",
        timestamp: "2026-02-22T00:00:00Z",
        summary: "First commit",
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        contributionBullets: ["First commit"],
      });
      manager.appendCommit("main", {
        version: 1,
        kind: "commit",
        hash: "bbbb2222",
        timestamp: "2026-02-23T00:00:00Z",
        summary: "Second commit",
        branchPurpose: "Main branch",
        previousProgressSummary: "First commit",
        contributionBullets: ["Second commit"],
      });

      expect(manager.getLatestCommit("main")).toStrictEqual({
        version: 1,
        kind: "commit",
        hash: "bbbb2222",
        timestamp: "2026-02-23T00:00:00Z",
        summary: "Second commit",
        branchPurpose: "Main branch",
        previousProgressSummary: "First commit",
        contributionBullets: ["Second commit"],
      });
    });
  });

  describe("readCommitContext", () => {
    it("should return structured context from commit-context.json", () => {
      manager.createBranch("main", "Main branch");

      expect(manager.readCommitContext("main")).toStrictEqual({
        version: 1,
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        latestContributionBullets: [],
      });
    });

    it("should derive structured context from commits.jsonl when the json file is missing", () => {
      manager.createBranch("main", "Main branch");
      fs.rmSync(path.join(memoryDir, "branches/main/commit-context.json"));
      manager.appendCommit("main", {
        version: 1,
        kind: "commit",
        hash: "aaaa1111",
        timestamp: "2026-02-22T00:00:00Z",
        summary: "First milestone",
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        contributionBullets: ["Added the first milestone."],
      });

      expect(manager.readCommitContext("main")).toStrictEqual({
        version: 1,
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        latestContributionBullets: ["Added the first milestone."],
      });
    });
  });

  describe("branchExists", () => {
    it("should return true for existing branches", () => {
      manager.createBranch("main", "Main branch");
      expect(manager.branchExists("main")).toBeTruthy();
    });

    it("should return false for non-existing branches", () => {
      expect(manager.branchExists("nope")).toBeFalsy();
    });
  });

  describe("readMetadata", () => {
    it("should return default structured metadata for new branch", () => {
      manager.createBranch("main", "Main branch");
      expect(manager.readMetadata("main")).toStrictEqual({
        version: 1,
        fileStructure: {},
        envConfig: {},
        notes: [],
      });
    });

    it("should return parsed structured metadata", () => {
      manager.createBranch("main", "Main branch");
      const metadataPath = path.join(memoryDir, "branches/main/metadata.json");
      fs.writeFileSync(
        metadataPath,
        `${JSON.stringify(
          {
            version: 1,
            fileStructure: { src: "source code" },
            envConfig: { NODE_ENV: "test" },
            notes: ["Example metadata."],
          },
          null,
          2
        )}\n`
      );

      expect(manager.readMetadata("main")).toStrictEqual({
        version: 1,
        fileStructure: { src: "source code" },
        envConfig: { NODE_ENV: "test" },
        notes: ["Example metadata."],
      });
    });
  });

  describe("readCommitRecords", () => {
    it("should parse structured commit history from commits.jsonl", () => {
      manager.createBranch("main", "Main branch");
      const record = {
        version: 1 as const,
        kind: "commit" as const,
        hash: "abcd1234",
        timestamp: "2026-02-22T00:00:00Z",
        summary: "Milestone",
        branchPurpose: "Main branch",
        previousProgressSummary: "Initial commit.",
        contributionBullets: ["Did a thing."],
      };
      fs.writeFileSync(
        path.join(memoryDir, "branches/main/commits.jsonl"),
        serializeMemoryCommitRecord(record)
      );

      expect(manager.readCommitRecords("main")).toStrictEqual([record]);
    });
  });
});
