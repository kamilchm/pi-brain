import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

interface BrainConfig {
  committerModel?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readConfigFile(path: string): BrainConfig {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.committerModel !== "string") {
      return {};
    }

    return { committerModel: parsed.committerModel };
  } catch {
    return {};
  }
}

export function readConfiguredCommitterModel(
  cwd: string,
  agentDir: string = getAgentDir(),
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const globalConfig = readConfigFile(
    join(agentDir, "extensions", "pi-brain.json")
  );
  const projectConfig = readConfigFile(
    join(cwd, ".pi", "extensions", "pi-brain.json")
  );

  const envModel = env.PI_BRAIN_COMMIT_MODEL?.trim();
  if (envModel) {
    return envModel;
  }

  const configuredModel =
    projectConfig.committerModel ?? globalConfig.committerModel;
  const trimmedModel = configuredModel?.trim();
  if (!trimmedModel) {
    return undefined;
  }

  return trimmedModel;
}
