import * as fs from "node:fs";
import * as path from "node:path";

import {
  createInitialBranchCommitContext,
  deriveBranchCommitContextFromCommits,
} from "./commit-context.js";
import {
  createInitialBranchMetadata,
  parseBranchMetadata,
  serializeBranchMetadata,
} from "./metadata.js";
import {
  parseMemoryCommitHistory,
  serializeMemoryCommitRecord,
} from "./structured-memory.js";
import type {
  BranchCommitContext,
  BranchMetadata,
  MemoryCommitRecord,
} from "./types.js";

function sortBranchNames(names: readonly string[]): string[] {
  const sorted: string[] = [];

  for (const name of names) {
    const insertIndex = sorted.findIndex(
      (existing) => existing.localeCompare(name) > 0
    );

    if (insertIndex === -1) {
      sorted.push(name);
      continue;
    }

    sorted.splice(insertIndex, 0, name);
  }

  return sorted;
}

/**
 * Manages `.memory/branches/` directory operations.
 * Each branch has: log.jsonl, commits.jsonl, metadata.json, commit-context.json.
 */
export class BranchManager {
  private readonly branchesDir: string;

  constructor(projectDir: string) {
    this.branchesDir = path.join(projectDir, ".memory", "branches");
  }

  createBranch(name: string, purpose: string): void {
    const branchDir = path.join(this.branchesDir, name);
    fs.mkdirSync(branchDir, { recursive: true });
    fs.writeFileSync(path.join(branchDir, "log.jsonl"), "");
    fs.writeFileSync(path.join(branchDir, "commits.jsonl"), "");
    this.writeMetadata(name, createInitialBranchMetadata());
    this.writeCommitContext(name, createInitialBranchCommitContext(purpose));
  }

  appendLog(branch: string, content: string): void {
    fs.appendFileSync(this.logPath(branch), content);
  }

  readLog(branch: string): string {
    const logPath = this.logPath(branch);
    if (!fs.existsSync(logPath)) {
      return "";
    }
    return fs.readFileSync(logPath, "utf8");
  }

  clearLog(branch: string): void {
    const logPath = this.logPath(branch);
    if (fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, "");
    }
  }

  appendCommit(branch: string, record: MemoryCommitRecord): void {
    fs.appendFileSync(
      this.commitsPath(branch),
      serializeMemoryCommitRecord(record)
    );
  }

  readCommits(branch: string): string {
    const commitsPath = this.commitsPath(branch);
    if (!fs.existsSync(commitsPath)) {
      return "";
    }
    return fs.readFileSync(commitsPath, "utf8");
  }

  readCommitRecords(branch: string): MemoryCommitRecord[] {
    return parseMemoryCommitHistory(this.readCommits(branch));
  }

  getLatestCommit(branch: string): MemoryCommitRecord | null {
    return this.readCommitRecords(branch).at(-1) ?? null;
  }

  readMetadata(branch: string): BranchMetadata | null {
    const metaPath = path.join(this.branchesDir, branch, "metadata.json");
    if (!fs.existsSync(metaPath)) {
      return this.branchExists(branch) ? createInitialBranchMetadata() : null;
    }

    const parsed = parseBranchMetadata(fs.readFileSync(metaPath, "utf8"));
    return parsed ?? createInitialBranchMetadata();
  }

  writeMetadata(branch: string, metadata: BranchMetadata): void {
    fs.writeFileSync(
      path.join(this.branchesDir, branch, "metadata.json"),
      serializeBranchMetadata(metadata)
    );
  }

  readCommitContext(branch: string): BranchCommitContext | null {
    const commitContextPath = path.join(
      this.branchesDir,
      branch,
      "commit-context.json"
    );
    if (fs.existsSync(commitContextPath)) {
      try {
        return JSON.parse(
          fs.readFileSync(commitContextPath, "utf8")
        ) as BranchCommitContext;
      } catch {
        // Fall back to deriving from commits.jsonl.
      }
    }

    if (!this.branchExists(branch)) {
      return null;
    }

    return deriveBranchCommitContextFromCommits(
      branch,
      this.readCommits(branch)
    );
  }

  writeCommitContext(branch: string, context: BranchCommitContext): void {
    fs.writeFileSync(
      path.join(this.branchesDir, branch, "commit-context.json"),
      `${JSON.stringify(context, null, 2)}\n`
    );
  }

  protected readBranchEntries(): string[] {
    return fs.readdirSync(this.branchesDir);
  }

  listBranches(): string[] {
    if (!fs.existsSync(this.branchesDir)) {
      return [];
    }

    const branchNames = this.readBranchEntries().filter((entry) => {
      const fullPath = path.join(this.branchesDir, entry);
      return fs.statSync(fullPath).isDirectory();
    });

    return sortBranchNames(branchNames);
  }

  branchExists(name: string): boolean {
    const branchDir = path.join(this.branchesDir, name);
    return fs.existsSync(branchDir) && fs.statSync(branchDir).isDirectory();
  }

  getLogSizeBytes(branch: string): number {
    const logPath = this.logPath(branch);
    return fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  }

  getCommitsSizeBytes(branch: string): number {
    const commitsPath = this.commitsPath(branch);
    return fs.existsSync(commitsPath) ? fs.statSync(commitsPath).size : 0;
  }

  getLogTurnCount(branch: string): number {
    const log = this.readLog(branch);
    if (log.trim() === "") {
      return 0;
    }

    return log
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "").length;
  }

  private logPath(branch: string): string {
    return path.join(this.branchesDir, branch, "log.jsonl");
  }

  private commitsPath(branch: string): string {
    return path.join(this.branchesDir, branch, "commits.jsonl");
  }
}
