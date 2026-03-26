import * as fs from "node:fs";
import * as path from "node:path";

import type { BranchManager } from "./branches.js";
import { formatCommitRecordSummary } from "./commit-presentation.js";
import { LOG_SIZE_WARNING_BYTES } from "./constants.js";
import type { MemoryState } from "./state.js";

interface StatusViewOptions {
  compact?: boolean;
  roadmapCharLimit?: number;
  branchLimit?: number;
}

const DEFAULT_COMPACT_ROADMAP_CHAR_LIMIT = 1200;
const DEFAULT_COMPACT_BRANCH_LIMIT = 8;

function buildRoadmapSection(
  lines: string[],
  projectDir: string,
  compact: boolean,
  roadmapCharLimit: number
): void {
  const mainMdPath = path.join(projectDir, ".memory", "main.md");
  if (!fs.existsSync(mainMdPath)) {
    lines.push(
      "No roadmap found. Create `.memory/main.md` to set project goals.",
      ""
    );
    return;
  }

  const roadmap = fs.readFileSync(mainMdPath, "utf8").trim();
  if (!roadmap) {
    lines.push(
      "Roadmap is empty. Update `.memory/main.md` with project goals and current state.",
      ""
    );
    return;
  }

  if (!compact || roadmap.length <= roadmapCharLimit) {
    lines.push(roadmap, "");
    return;
  }

  const excerpt = roadmap.slice(0, roadmapCharLimit).trimEnd();
  lines.push(excerpt, "");
  lines.push(
    `_Roadmap truncated for automatic status output. Use \`read .memory/main.md\` for full roadmap._`,
    ""
  );
}

function buildBranchesSection(
  lines: string[],
  state: MemoryState,
  branches: BranchManager,
  compact: boolean,
  branchLimit: number
): void {
  const branchList = branches.listBranches();
  if (branchList.length === 0) {
    return;
  }

  lines.push("## Branches", "");

  const visibleBranches = compact
    ? branchList.slice(0, branchLimit)
    : branchList;
  for (const name of visibleBranches) {
    const latest = branches.getLatestCommit(name);
    const summary = latest ? formatCommitRecordSummary(latest) : "(no commits)";
    const marker = name === state.activeBranch ? " (active)" : "";
    lines.push(`- **${name}**${marker}: ${summary}`);
  }

  if (compact && branchList.length > visibleBranches.length) {
    const remaining = branchList.length - visibleBranches.length;
    const branchLabel = remaining === 1 ? "branch" : "branches";
    lines.push(`- ... ${remaining} more ${branchLabel} not shown.`);
  }

  lines.push("");
}

export function buildStatusView(
  state: MemoryState,
  branches: BranchManager,
  projectDir: string,
  options: StatusViewOptions = {}
): string {
  const compact = options.compact ?? false;
  const roadmapCharLimit =
    options.roadmapCharLimit ?? DEFAULT_COMPACT_ROADMAP_CHAR_LIMIT;
  const branchLimit = options.branchLimit ?? DEFAULT_COMPACT_BRANCH_LIMIT;

  const lines = ["# Memory Status", ""];

  buildRoadmapSection(lines, projectDir, compact, roadmapCharLimit);

  lines.push(`Active branch: ${state.activeBranch}`, "");

  const logSizeBytes = branches.getLogSizeBytes(state.activeBranch);
  if (logSizeBytes >= LOG_SIZE_WARNING_BYTES) {
    const sizeKB = Math.round(logSizeBytes / 1024);
    lines.push(
      `**Warning:** log.jsonl is large (${sizeKB} KB). ` +
        "You should commit to distill this into structured memory.",
      ""
    );
  }

  buildBranchesSection(lines, state, branches, compact, branchLimit);

  lines.push("## Deep Retrieval", "");
  lines.push(
    "Use `read .memory/branches/<name>/commits.jsonl` for full history."
  );
  lines.push("Use `read .memory/branches/<name>/log.jsonl` for OTA trace.");
  lines.push(
    "Use `read .memory/branches/<name>/commit-context.json` for latest branch context."
  );
  lines.push("Use `read .memory/branches/<name>/metadata.json` for metadata.");
  lines.push("Use `read .memory/main.md` for roadmap.");
  lines.push("Use `read .memory/AGENTS.md` for protocol details.");

  return lines.join("\n");
}
