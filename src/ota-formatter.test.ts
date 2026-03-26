import fc from "fast-check";

import { formatOtaEntry } from "./ota-formatter.js";
import type { OtaEntryInput } from "./ota-formatter.js";
import { parsePersistedOtaEntry } from "./structured-memory.js";

const otaEntryArb = fc.record({
  turnNumber: fc.integer({ min: 1 }),
  timestamp: fc.string({ minLength: 1 }),
  model: fc.string({ minLength: 1 }),
  thought: fc.string(),
  thinking: fc.string(),
  actions: fc.array(
    fc.string({ minLength: 1 }).filter((value) => value.trim() !== "")
  ),
  observations: fc.array(
    fc.string({ minLength: 1 }).filter((value) => value.trim() !== "")
  ),
});

describe("formatOtaEntry", () => {
  it("should serialize a full turn as a JSONL record", () => {
    const input: OtaEntryInput = {
      turnNumber: 1,
      timestamp: "2026-02-22T14:00:00Z",
      model: "anthropic/claude-sonnet-4",
      thought: "I need to read the file first.",
      thinking: "Let me analyze the structure of this codebase.",
      actions: ["read(src/index.ts)", "bash(ls -la)"],
      observations: ["read: success, 45 lines", "bash: exit 0, 3 files listed"],
    };

    const result = formatOtaEntry(input);
    const parsed = parsePersistedOtaEntry(result.trim());

    expect(parsed).toStrictEqual({
      version: 1,
      ...input,
    });
  });

  it("should end with a trailing newline", () => {
    const input: OtaEntryInput = {
      turnNumber: 1,
      timestamp: "2026-02-22T14:00:00Z",
      model: "anthropic/claude-sonnet-4",
      thought: "Hello.",
      thinking: "",
      actions: [],
      observations: [],
    };

    const result = formatOtaEntry(input);
    expect(result.endsWith("\n")).toBeTruthy();
  });
});

describe("formatOtaEntry property-based tests", () => {
  it("should always produce parseable persisted OTA records", () => {
    fc.assert(
      fc.property(otaEntryArb, (input) => {
        const result = formatOtaEntry(input);
        expect(parsePersistedOtaEntry(result.trim())).toStrictEqual({
          version: 1,
          ...input,
          actions: input.actions.map((value) => value.trim()),
          observations: input.observations.map((value) => value.trim()),
        });
      })
    );
  });

  it("should always end with trailing newline", () => {
    fc.assert(
      fc.property(otaEntryArb, (input) => {
        const result = formatOtaEntry(input);
        expect(result.endsWith("\n")).toBeTruthy();
      })
    );
  });
});
