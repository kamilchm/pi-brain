import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

import type { CommitterModelConfig } from "./types.js";

interface BrainConfig {
  committerModel?: string;
  committerTimeoutMs?: number;
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
    if (!isRecord(parsed)) {
      return {};
    }

    const config: BrainConfig = {};
    if (typeof parsed.committerModel === "string") {
      config.committerModel = parsed.committerModel;
    }
    if (
      typeof parsed.committerTimeoutMs === "number" &&
      Number.isFinite(parsed.committerTimeoutMs) &&
      parsed.committerTimeoutMs > 0
    ) {
      config.committerTimeoutMs = parsed.committerTimeoutMs;
    }

    return config;
  } catch {
    return {};
  }
}

function formatConfigSource(path: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim();
  if (home && path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }

  return path;
}

export function readConfiguredCommitterModelConfig(
  cwd: string,
  agentDir: string = getAgentDir(),
  env: NodeJS.ProcessEnv = process.env
): CommitterModelConfig | undefined {
  const globalConfigPath = join(agentDir, "extensions", "pi-brain.json");
  const projectConfigPath = join(cwd, ".pi", "extensions", "pi-brain.json");
  const globalConfig = readConfigFile(globalConfigPath);
  const projectConfig = readConfigFile(projectConfigPath);

  const envModel = env.PI_BRAIN_COMMIT_MODEL?.trim();
  if (envModel) {
    return {
      model: envModel,
      source: "environment variable (PI_BRAIN_COMMIT_MODEL)",
    };
  }

  const projectModel = projectConfig.committerModel?.trim();
  if (projectModel) {
    return {
      model: projectModel,
      source: `project config (${formatConfigSource(projectConfigPath, env)})`,
    };
  }

  const globalModel = globalConfig.committerModel?.trim();
  if (globalModel) {
    return {
      model: globalModel,
      source: `global config (${formatConfigSource(globalConfigPath, env)})`,
    };
  }

  return undefined;
}

export function readConfiguredCommitterModel(
  cwd: string,
  agentDir: string = getAgentDir(),
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return readConfiguredCommitterModelConfig(cwd, agentDir, env)?.model;
}

export function readConfiguredCommitterTimeoutMs(
  cwd: string,
  agentDir: string = getAgentDir(),
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const globalConfigPath = join(agentDir, "extensions", "pi-brain.json");
  const projectConfigPath = join(cwd, ".pi", "extensions", "pi-brain.json");
  const globalConfig = readConfigFile(globalConfigPath);
  const projectConfig = readConfigFile(projectConfigPath);

  const envTimeoutMs = Number.parseInt(
    env.PI_BRAIN_COMMIT_TIMEOUT_MS ?? "",
    10
  );
  if (Number.isFinite(envTimeoutMs) && envTimeoutMs > 0) {
    return envTimeoutMs;
  }

  return projectConfig.committerTimeoutMs ?? globalConfig.committerTimeoutMs;
}
