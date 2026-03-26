#!/usr/bin/env bash
# brain-init.sh — One-time Brain memory initialization
# Creates .memory/ directory structure and appends Brain section to root AGENTS.md
# Idempotent: safe to run multiple times without clobbering existing content.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$SCRIPT_DIR/../templates"

MEMORY_DIR=".memory"
BRANCHES_DIR="$MEMORY_DIR/branches/main"
STATE_FILE="$MEMORY_DIR/state.yaml"
MEMORY_AGENTS_FILE="$MEMORY_DIR/AGENTS.md"
MAIN_MD_FILE="$MEMORY_DIR/main.md"
ROOT_AGENTS_FILE="AGENTS.md"
GITIGNORE_FILE=".gitignore"
LOG_IGNORE_PATTERN=".memory/branches/*/log.jsonl"

# --- Create .memory directory structure (skip if already exists) ---

if [ ! -d "$BRANCHES_DIR" ]; then
  mkdir -p "$BRANCHES_DIR"
fi

if [ ! -f "$BRANCHES_DIR/log.jsonl" ]; then
  touch "$BRANCHES_DIR/log.jsonl"
fi

if [ ! -f "$BRANCHES_DIR/commits.jsonl" ]; then
  cat > "$BRANCHES_DIR/commits.jsonl" <<'EOF'
# main

**Purpose:** Main project memory branch
EOF
fi

if [ ! -f "$BRANCHES_DIR/metadata.json" ]; then
  cat > "$BRANCHES_DIR/metadata.json" <<'EOF'
{
  "version": 1,
  "fileStructure": {},
  "envConfig": {},
  "notes": []
}
EOF
fi

if [ ! -f "$BRANCHES_DIR/commit-context.json" ]; then
  cat > "$BRANCHES_DIR/commit-context.json" <<'EOF'
{
  "version": 1,
  "branchPurpose": "Main project memory branch",
  "previousProgressSummary": "Initial commit.",
  "latestContributionBullets": []
}
EOF
fi

if [ ! -f "$MAIN_MD_FILE" ]; then
  touch "$MAIN_MD_FILE"
fi

# --- Write state.yaml (skip if already exists) ---

if [ ! -f "$STATE_FILE" ]; then
  cat > "$STATE_FILE" <<EOF
active_branch: main
initialized: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EOF
fi

# --- Write .memory/AGENTS.md from template (always overwrite — it's a reference doc) ---

if [ -f "$TEMPLATES_DIR/agents-md.md" ]; then
  cp "$TEMPLATES_DIR/agents-md.md" "$MEMORY_AGENTS_FILE"
fi

# --- Append Brain section to root AGENTS.md (idempotent) ---

if [ ! -f "$ROOT_AGENTS_FILE" ]; then
  touch "$ROOT_AGENTS_FILE"
fi

if ! grep -q "## Brain" "$ROOT_AGENTS_FILE" 2>/dev/null; then
  if [ -s "$ROOT_AGENTS_FILE" ]; then
    echo "" >> "$ROOT_AGENTS_FILE"
  fi
  cat "$TEMPLATES_DIR/root-agents-section.md" >> "$ROOT_AGENTS_FILE"
fi

# --- Ignore transient branch logs in git (idempotent) ---

if [ ! -f "$GITIGNORE_FILE" ]; then
  touch "$GITIGNORE_FILE"
fi

if ! grep -Fxq "$LOG_IGNORE_PATTERN" "$GITIGNORE_FILE"; then
  if [ -s "$GITIGNORE_FILE" ]; then
    echo "" >> "$GITIGNORE_FILE"
  fi
  echo "$LOG_IGNORE_PATTERN" >> "$GITIGNORE_FILE"
fi

echo "Brain memory initialized successfully."
