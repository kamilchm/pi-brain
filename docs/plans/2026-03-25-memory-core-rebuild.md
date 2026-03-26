# Memory Core Rebuild Plan

**Date:** 2026-03-25  
**Status:** In progress

## Why we are rebuilding the core

The current `memory_commit` implementation has accumulated several generations of ideas:

- markdown-oriented commit parsing
- chunked distillation added later
- SDK runner replacing subprocess/RPC runners
- structured tool submissions added on top of markdown compatibility
- ad hoc fixes for large-run synthesis failures

That stack works for some cases, but it mixes:

- **legacy compatibility concerns** (`commits.md` as both history and active input)
- **new structured control flow** (tool-only submissions, JSON chunk summaries)
- **performance concerns** (timeouts on large runs)

This leads to circular fixes instead of a clean model.

The goal now is to **rebuild the memory core from first principles** while keeping the outer extension surface stable:

- keep `memory_commit`
- keep `memory_branch`
- keep lifecycle hooks
- keep `.memory/` compatibility for users and existing projects

## Source principles

### GCC paper

From the paper, the key implementation points are:

1. **The latest branch memory should be enough for continuation.**  
   The paper explicitly uses the last commit's:
   - branch intent / purpose
   - previous progress summary
   - latest contribution

2. **Commit retrieval uses a bounded window (`K = 1`).**  
   The agent should not need to reread the entire branch history for normal continuation.

3. **Detailed logs + explicit retrieval matter.**  
   `log.md` is the fine-grained source, but it should be transformed into a durable, structured branch memory artifact.

4. **Branch memory is layered.**  
   Global roadmap, branch summary state, fine-grained logs, and structured metadata are different layers with different roles.

### pi-episodic-memory inspiration

We should borrow its **architecture style**, not its retrieval semantics:

- parser / derived-state / tool surface separation
- structured internal artifacts
- incremental processing mindset
- render text only at the boundary

## New core design

## 1. Canonical branch state becomes structured

Each branch gets a structured sidecar file:

- `.memory/branches/<branch>/commit-context.json`

Initial shape:

```json
{
  "version": 1,
  "branchPurpose": "...",
  "previousProgressSummary": "Initial commit.",
  "latestContributionBullets": []
}
```

This file is the **canonical continuation input** for future commits.

`commits.md` remains:

- human-readable history
- compatibility artifact
- audit trail

But it is no longer the primary input for normal commit generation.

## 2. Commit inputs become structured and bounded

### Single-pass commit

The committer reads:

- `.memory/AGENTS.md`
- `.memory/branches/<branch>/log.md`
- `.memory/branches/<branch>/commit-context.json`

It then emits structured commit blocks through `submit_memory_commit_blocks`.

### Chunked commit

The chunked path becomes:

1. split `log.md` into bounded chunks
2. distill each chunk into structured bullets
3. write `chunk-summaries.json`
4. reducer reads:
   - `commit-context.json`
   - `chunk-summaries.json`
5. reducer emits only the new contribution bullets
6. extension composes final commit blocks locally

This keeps the final model burden small and paper-aligned:

- branch purpose comes from structured branch context
- previous progress summary comes from structured branch context
- only the **new contribution** is synthesized from the raw log

## 3. Render markdown only at the compatibility boundary

Internally:

- structured JSON state
- structured tool output
- typed submissions

Externally:

- append canonical markdown to `commits.md`
- continue showing the same user-facing memory results

## 4. Migration must be lazy and safe

Existing projects already have `commits.md` but may not have `commit-context.json`.

So the rebuild uses lazy migration:

- if `commit-context.json` exists, use it
- otherwise derive it from the latest `commits.md` entry
- then write it back so future commits use the structured file directly

This preserves compatibility without forcing a one-time migration step.

## Implementation slices

## Slice 1 — Structured branch context (current)

- add `commit-context.json`
- lazily derive it from `commits.md`
- update `memory_commit` to use `commit-context.json` as primary continuation input
- keep `commits.md` as compatibility output

## Slice 2 — Structured commit pipeline

- remove remaining markdown-as-control-path assumptions inside commit generation
- ensure single-pass and chunked flows both use only structured inputs/outputs
- reduce parsing to compatibility rendering only

## Slice 3 — Reducer-first large-log strategy

- make chunk summaries richer and more regular
- add hierarchical reduction when chunk count is high
- avoid a single heavy final synthesis over too many chunk summaries
- retest on real tiny → small → main → large staircase

## Immediate success criteria

1. `memory_commit` reads `commit-context.json` instead of full `commits.md` for normal continuation.
2. Existing branches lazily backfill `commit-context.json` without user intervention.
3. `commits.md` remains canonical human-readable history.
4. Large-run work shifts from full-history synthesis toward reducer-style contribution synthesis.

## Risks to avoid

- making the extension depend on markdown parsing for correctness
- introducing a second incompatible memory format at the user boundary
- rebuilding everything at once instead of slicing the core cleanly
- regressing cache-safe behavior or lifecycle stability already validated elsewhere

## Current progress

### Done in this slice

- introduced `commit-context.json` as structured latest-branch state
- added lazy derivation from `commits.md`
- updated `memory_commit` task shaping to read `commit-context.json`
- updated chunked synthesis workspace to use structured branch context
- updated init flow to create `commit-context.json`

### Next

1. rerun real staircase tests on the chat project with the new branch-context input
2. measure whether large-log behavior improved
3. if still needed, reduce chunk size and/or add hierarchical reduction for chunk summaries
