/**
 * Formats OTA (Observation-Thought-Action) log entries for log.jsonl.
 */

import { serializeOtaEntry } from "./structured-memory.js";
import type { OtaEntryInput } from "./types.js";

export type { OtaEntryInput } from "./types.js";

export function formatOtaEntry(input: OtaEntryInput): string {
  return serializeOtaEntry(input);
}
