import type { BranchManager } from "./branches.js";
import { buildPreviousProgressSummaryForNextCommit } from "./commit-context.js";
import { formatCommitRecordOrientation } from "./commit-presentation.js";
import { generateHash } from "./hash.js";
import { buildStatusView } from "./memory-context.js";
import type { MemoryState } from "./state.js";
import type { MemoryCommitRecord } from "./types.js";

interface MemoryBranchParams {
  action: string;
  name?: string;
  purpose?: string;
  branch?: string;
  synthesis?: string;
}

interface ActionResult {
  text: string;
  ok: boolean;
}

function executeCreate(
  params: MemoryBranchParams,
  state: MemoryState,
  branches: BranchManager
): ActionResult {
  const { name, purpose } = params;

  if (!name || !purpose) {
    return {
      text: '"name" and "purpose" are required for the create action.',
      ok: false,
    };
  }

  if (branches.branchExists(name)) {
    return {
      text: `Branch "${name}" already exists. Use action "switch" to switch to it.`,
      ok: false,
    };
  }

  branches.createBranch(name, purpose);
  state.setActiveBranch(name);
  state.save();

  return {
    text: `Created branch "${name}" and switched to it.\nPurpose: ${purpose}`,
    ok: true,
  };
}

function executeSwitch(
  params: MemoryBranchParams,
  state: MemoryState,
  branches: BranchManager
): ActionResult {
  const { branch } = params;

  if (!branch) {
    return { text: '"branch" is required for the switch action.', ok: false };
  }

  if (!branches.branchExists(branch)) {
    return {
      text: `Branch "${branch}" not found. Available branches: ${branches.listBranches().join(", ")}`,
      ok: false,
    };
  }

  state.setActiveBranch(branch);
  state.save();

  const latest = branches.getLatestCommit(branch);
  const summary = latest
    ? formatCommitRecordOrientation(latest)
    : "No commits yet.";

  return { text: `Switched to branch "${branch}".\n\n${summary}`, ok: true };
}

function executeMerge(
  params: MemoryBranchParams,
  state: MemoryState,
  branches: BranchManager
): ActionResult {
  const { branch: sourceBranch, synthesis } = params;

  if (!sourceBranch || !synthesis) {
    return {
      text: '"branch" and "synthesis" are required for the merge action.',
      ok: false,
    };
  }

  const targetBranch = state.activeBranch;

  if (sourceBranch === targetBranch) {
    return {
      text: `Cannot merge branch "${sourceBranch}" into itself.`,
      ok: false,
    };
  }

  if (!branches.branchExists(sourceBranch)) {
    return {
      text: `Branch "${sourceBranch}" not found. Available branches: ${branches.listBranches().join(", ")}`,
      ok: false,
    };
  }

  const hash = generateHash();
  const timestamp = new Date().toISOString();
  const summary = `Merge from ${sourceBranch}`;
  const targetContext = branches.readCommitContext(targetBranch);
  const contributionBullets = synthesis
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => (line.startsWith("- ") ? line.slice(2).trim() : line));

  const mergeRecord: MemoryCommitRecord = {
    version: 1,
    kind: "merge",
    hash,
    timestamp,
    summary,
    branchPurpose: targetContext?.branchPurpose ?? `Branch ${targetBranch}`,
    previousProgressSummary: targetContext
      ? buildPreviousProgressSummaryForNextCommit(targetContext)
      : "Initial commit.",
    contributionBullets,
    sourceBranch,
  };

  branches.appendCommit(targetBranch, mergeRecord);
  branches.writeCommitContext(targetBranch, {
    version: 1,
    branchPurpose: mergeRecord.branchPurpose,
    previousProgressSummary: mergeRecord.previousProgressSummary,
    latestContributionBullets: mergeRecord.contributionBullets,
  });

  state.setLastCommit(targetBranch, hash, timestamp, summary);
  state.save();

  return {
    text: `Merge commit ${hash} written to branch "${targetBranch}" (merged from "${sourceBranch}").`,
    ok: true,
  };
}

/**
 * Execute the unified memory_branch tool.
 * Actions: create, switch, merge.
 * On success, appends the current memory status view.
 */
export function executeMemoryBranch(
  params: MemoryBranchParams,
  state: MemoryState,
  branches: BranchManager,
  projectDir: string
): string {
  let result: ActionResult;

  switch (params.action) {
    case "create": {
      result = executeCreate(params, state, branches);
      break;
    }
    case "switch": {
      result = executeSwitch(params, state, branches);
      break;
    }
    case "merge": {
      result = executeMerge(params, state, branches);
      break;
    }
    default: {
      return `Unknown action "${params.action}". Valid actions: create, switch, merge.`;
    }
  }

  if (!result.ok) {
    return result.text;
  }

  const status = buildStatusView(state, branches, projectDir, {
    compact: true,
  });
  return `${result.text}\n\n${status}`;
}
