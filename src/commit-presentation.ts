import type { MemoryCommitRecord } from "./types.js";

function formatMergePrefix(record: MemoryCommitRecord): string {
  return record.sourceBranch ? `merge from ${record.sourceBranch}` : "merge";
}

export function formatCommitRecordSummary(record: MemoryCommitRecord): string {
  const [firstBullet] = record.contributionBullets;
  const detail = firstBullet ?? record.summary;

  if (record.kind === "merge") {
    return `${formatMergePrefix(record)}: ${detail}`;
  }

  return detail;
}

export function formatCommitRecordOrientation(
  record: MemoryCommitRecord,
  maxBullets = 5
): string {
  const kindLabel =
    record.kind === "merge" ? formatMergePrefix(record) : record.kind;
  const lines = [
    `Latest commit: ${record.summary} (${record.hash})`,
    `Kind: ${kindLabel}`,
  ];

  for (const bullet of record.contributionBullets.slice(0, maxBullets)) {
    lines.push(`- ${bullet}`);
  }

  return lines.join("\n");
}
