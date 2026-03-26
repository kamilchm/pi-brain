<p align="center">
  <img src="./banner.png" alt="pi-brain banner" width="720" />
</p>

# pi-brain

Versioned memory for the [pi coding agent](https://github.com/badlogic/pi-mono). Agents commit decisions and reasoning to a `.memory/` directory, preserving context across sessions, compactions, and model switches.

Credit: This project is my implementation for Pi of this paper [Git Context Controller: Manage the Context of LLM-based Agents like Git](https://arxiv.org/html/2508.00031v1)

## Getting Started

```bash
pi install npm:pi-brain
```

Open pi in any project and say "initialize Brain" (or run `/skill:brain`). The agent creates `.memory/` and starts remembering.

That's it. The agent decides when to commit, branch, and merge — you don't **need** to manage anything. However, you can always prompt the agent to remember something specific if you'd like.

## How It Works

Brain adds two tools and a few lifecycle hooks to pi. The design is simple: the agent works normally, and Brain records what happens in the background.

**Every turn**, Brain appends a structured log entry to `.memory/branches/<branch>/log.jsonl`. This happens automatically via the `turn_end` hook — the agent doesn't call anything.

**When the agent reaches a milestone**, it calls `memory_commit` with a short summary. Brain spawns a subagent in a fresh context window that reads the raw log plus the latest branch context, then emits a structured commit submission. The extension appends a structured record to `commits.jsonl`, updates `commit-context.json`, and clears the log.

**Each commit is self-contained.** The canonical continuation state lives in `commit-context.json`, and each structured commit record in `commits.jsonl` preserves the branch purpose, rolling summary, and latest contribution.

**Branching and merging** work like you'd expect. The agent branches to explore alternatives without contaminating the main line, then merges conclusions back with a synthesis.

### The Two Tools

| Tool            | What it does                                       |
| --------------- | -------------------------------------------------- |
| `memory_commit` | Checkpoint a milestone using structured commit I/O |
| `memory_branch` | Create, switch, or merge memory branches           |

For deep retrieval, the agent uses pi's built-in `read` tool on `.memory/` files directly. No special API needed.

## Prompt Cache Safety

LLM providers cache the prefix of each request. If the prefix changes between turns, the cache misses and you pay full latency and cost. Many memory systems break this by injecting dynamic state into the system prompt.

Brain avoids this entirely:

- **Static AGENTS.md** — Written once at init, never updated. No branch names, no commit counts, no dynamic state. The system prompt prefix stays identical across every turn and session.
- **No per-turn prompt mutation** — Brain does not rewrite `systemPrompt` between turns. Status context is appended as message content, keeping the cached prefix stable.
- **Fixed tool definitions** — Tool schemas are static at startup. No tools are added or removed mid-conversation.
- **Subagent isolation** — Commit distillation runs in a separate API call with its own cache. The main agent's cache is never touched.
- **Regression-tested safety** — Prompt-cache safety invariants are covered in `src/cache-safety.test.ts` (property tests for append-only prompt behavior, lifecycle-gated status injection, and deterministic status rendering).

The result: Brain adds zero overhead to your prompt cache hit rate.

## What Gets Created

```
.memory/
├── AGENTS.md                      # Protocol reference
├── main.md                        # Project roadmap (agent-authored)
├── state.yaml                     # Active branch, session tracking
└── branches/
    └── main/
        ├── commit-context.json     # Latest branch context for continuation
        ├── commits.jsonl           # Structured commit and merge records
        ├── log.jsonl               # Structured OTA log (gitignored)
        └── metadata.json           # Structured branch metadata
```

Everything in `.memory/` is tracked in git except `log.jsonl` (transient working state). This means memory is shared across machines and team members.

### Structured file formats

#### `commit-context.json`

```json
{
  "version": 1,
  "branchPurpose": "Main branch",
  "previousProgressSummary": "Initial commit.",
  "latestContributionBullets": []
}
```

This is the canonical continuation state used by `memory_commit`.

#### `commits.jsonl`

Each line is a structured record like:

```json
{
  "version": 1,
  "kind": "commit",
  "hash": "deadbeef",
  "timestamp": "2026-03-25T00:00:00Z",
  "summary": "Checkpoint summary",
  "branchPurpose": "Main branch",
  "previousProgressSummary": "Initial commit.",
  "contributionBullets": ["Added a milestone."]
}
```

#### `metadata.json`

```json
{
  "version": 1,
  "fileStructure": {},
  "envConfig": {},
  "notes": []
}
```

`fileStructure` stores path → responsibility summaries, `envConfig` stores environment/config descriptions, and `notes` stores branch-scoped metadata notes.

## Install Options

```bash
# From npm (recommended)
pi install npm:pi-brain

# From git (latest)
pi install git:github.com/Whamp/pi-brain

# Pinned version (npm)
pi install npm:pi-brain@0.1.0

# Pinned version (git)
pi install git:github.com/Whamp/pi-brain@v0.1.0

# Project-local (shared via .pi/settings.json)
pi install -l npm:pi-brain

# Try without installing
pi -e npm:pi-brain
```

## Configuring the `memory_commit` Model

`memory_commit` now always uses a fresh in-memory **SDK session**. The only runtime knob is the model (plus optional timeout), which keeps the implementation smaller and avoids dead runner code.

Config sources, highest priority first:

1. Environment variable: `PI_BRAIN_COMMIT_MODEL`
2. Project config: `.pi/extensions/pi-brain.json`
3. Global config: `~/.pi/agent/extensions/pi-brain.json`
4. Current session model
5. Fallback from `agents/memory-committer.md`

### Config file format

```json
{
  "committerModel": "google-antigravity/gemini-3-flash",
  "committerTimeoutMs": 60000
}
```

### Global default

```bash
mkdir -p ~/.pi/agent/extensions
cat > ~/.pi/agent/extensions/pi-brain.json <<'EOF'
{
  "committerModel": "google-antigravity/gemini-3-flash"
}
EOF
```

### Project override

```bash
mkdir -p .pi/extensions
cat > .pi/extensions/pi-brain.json <<'EOF'
{
  "committerModel": "anthropic/claude-sonnet-4-5"
}
EOF
```

### One-off override

```bash
PI_BRAIN_COMMIT_MODEL=openai/gpt-5-mini pi
```

This is useful when `memory_commit` should run on a faster or cheaper model than your main interactive session.

### Model compatibility notes

`memory_commit` depends on **reliable structured tool calls**. A model can be perfectly good at normal chat or coding and still be a poor fit for Brain commits if it refuses to call the required structured tools.

Based on real tests against the structured JSON-based memory pipeline:

| Model                                   | Status                              | Notes                                                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-copilot/gemini-3-flash-preview` | Recommended                         | Fast and reliable across repeated tiny → stress staircase reruns. Latest rerun: tiny 10.87s, small 7.90s, mainish 6.52s, large 12.27s, xlarge 15.95s, stress60 24.96s, stress80 31.94s, stress100 39.32s. |
| `github-copilot/grok-code-fast-1`       | Recommended                         | Reliable across tiny → stress runs, generally slower than Gemini Flash Preview.                                                                                                                           |
| `github-copilot/claude-haiku-4.5`       | Recommended                         | Reliable across tiny → stress runs, slower than Gemini Flash Preview and competitive with Grok.                                                                                                           |
| `openai-codex/gpt-5.3-codex-spark`      | Not recommended for `memory_commit` | Repeatedly failed to submit the required structured tool calls.                                                                                                                                           |
| `openai-codex/gpt-5.4-mini`             | Not recommended for `memory_commit` | Repeatedly failed to submit the required structured tool calls.                                                                                                                                           |
| `github-copilot/gpt-5.4-mini`           | Not recommended for `memory_commit` | Repeatedly failed to submit the required structured tool calls.                                                                                                                                           |

If Brain reports an error like:

- `did not submit structured commit blocks`
- `did not submit structured chunk summary`

then the problem is usually **model tool-use compliance**, not memory size. In that case, switch the committer model to a more reliable tool-calling model.

## Profiling `memory_commit`

Use the built-in TypeScript debug utility to capture precise `memory_commit` timing and stage breakdowns:

```bash
pnpm run memory-commit:debug -- run \
  --project /path/to/project \
  --summary "Profile main memory commit" \
  --update-roadmap false \
  --jsonl /tmp/memory-commit.jsonl

pnpm run memory-commit:debug -- summarize --jsonl /tmp/memory-commit.jsonl
```

To rerun the full synthetic staircase used for model comparisons:

```bash
pnpm run memory-commit:debug -- staircase \
  --project /path/to/project \
  --output-dir /tmp/pi-brain-staircase
```

This runs the default sequence `tiny → small → mainish → large → xlarge → stress60 → stress80 → stress100`, prepares deterministic structured OTA logs for each branch, executes `memory_commit`, and stores raw JSONL traces in the output directory.

The summary prints:

- total wall-clock time seen by the tool
- a full timeline of progress updates with deltas
- aggregated stage totals (for example: resource loading, session creation, prompting, chunk distillation, synthesis)

This makes it easy to compare how tiny → small → main scales and to see whether the time is dominated by setup overhead or model generation.

## Development

```bash
git clone https://github.com/Whamp/pi-brain.git
cd pi-brain
pnpm install --prod=false
pnpm run check               # lint + typecheck + format + tests + deadcode + secrets

pi -e ./src/index.ts          # run pi with extension loaded from source
```

| Command            | Purpose         |
| ------------------ | --------------- |
| `pnpm run check`   | Full validation |
| `pnpm run test`    | Tests only      |
| `pnpm run release` | Bump, tag, push |

## License

MIT
