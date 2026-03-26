import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { MemoryCommitOperation } from "./enums.js";
import type {
  MemoryCommitProgress,
  MemoryCommitStaircaseCase,
} from "./types.js";

interface PrepareMemoryCommitBranchOptions {
  projectDir: string;
  branch: string;
  purpose: string;
  logContent: string;
}

interface RunMemoryCommitCommandOptions {
  projectDir: string;
  summary: string;
  updateRoadmap: boolean;
  jsonlPath?: string;
  extensionPath?: string;
  timeoutMs?: number;
}

interface MemoryCommitTimelineEntry extends MemoryCommitProgress {
  deltaMs: number;
}

interface MemoryCommitStageTotal {
  stage: string;
  durationMs: number;
}

interface MemoryCommitProfileSummary {
  totalElapsedMs: number;
  timeline: MemoryCommitTimelineEntry[];
  stageTotals: MemoryCommitStageTotal[];
}

interface MemoryCommitInvocationSummary {
  args?: Record<string, unknown>;
  updates: string[];
  progress: MemoryCommitProgress[];
  profile?: MemoryCommitProfileSummary;
  finalText?: string;
  isError?: boolean;
}

interface MemoryCommitJsonlSummary {
  invocations: MemoryCommitInvocationSummary[];
}

interface ParsedCliCommand {
  command:
    | "prepare-tiny"
    | "run"
    | "staircase"
    | "summarize"
    | "smoke"
    | "switch";
  options: Record<string, string>;
}

interface BuildSyntheticOtaLogOptions {
  turns: number;
  label: string;
  model: string;
  hour: number;
}

interface MemoryCommitStaircaseOptions {
  projectDir: string;
  model?: string;
  branchPrefix?: string;
  summaryPrefix?: string;
  purposePrefix?: string;
  updateRoadmap?: boolean;
  outputDir?: string;
  timeoutMs?: number;
  extensionPath?: string;
  cases?: MemoryCommitStaircaseCase[];
  onProgress?: (progress: MemoryCommitStaircaseProgress) => void;
}

interface MemoryCommitStaircaseCaseResult {
  key: string;
  turns: number;
  branch: string;
  jsonlPath?: string;
  totalElapsedMs?: number;
  finalText?: string;
  isError?: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface MemoryCommitStaircaseResult {
  model?: string;
  cases: MemoryCommitStaircaseCaseResult[];
}

interface MemoryCommitStaircaseProgress {
  stage: "case_start" | "case_finish";
  caseIndex: number;
  caseCount: number;
  key: string;
  turns: number;
  branch: string;
  totalElapsedMs?: number;
  exitCode?: number | null;
  isError?: boolean;
}

type RunMemoryCommitCommand = (options: RunMemoryCommitCommandOptions) => {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

const DEFAULT_MEMORY_COMMIT_STAIRCASE_CASES: MemoryCommitStaircaseCase[] = [
  { key: "tiny", turns: 1, hour: 1 },
  { key: "small", turns: 3, hour: 2 },
  { key: "mainish", turns: 10, hour: 3 },
  { key: "large", turns: 20, hour: 4 },
  { key: "xlarge", turns: 40, hour: 5 },
  { key: "stress60", turns: 60, hour: 6 },
  { key: "stress80", turns: 80, hour: 7 },
  { key: "stress100", turns: 100, hour: 8 },
];

interface DebugBrainConfig {
  committerModel?: string;
}

function readDebugBrainConfig(path: string): DebugBrainConfig {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as { committerModel?: unknown }).committerModel !==
        "string"
    ) {
      return {};
    }

    return {
      committerModel: (parsed as { committerModel: string }).committerModel,
    };
  } catch {
    return {};
  }
}

function readConfiguredCommitterModelForDebug(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const envModel = env.PI_BRAIN_COMMIT_MODEL?.trim();
  if (envModel) {
    return envModel;
  }

  const projectModel = readDebugBrainConfig(
    resolve(projectDir, ".pi", "extensions", "pi-brain.json")
  ).committerModel?.trim();
  if (projectModel) {
    return projectModel;
  }

  const globalModel = readDebugBrainConfig(
    resolve(
      process.env.HOME ?? "",
      ".pi",
      "agent",
      "extensions",
      "pi-brain.json"
    )
  ).committerModel?.trim();
  if (globalModel) {
    return globalModel;
  }

  return undefined;
}

function roundMs(value: number): number {
  return Number(value.toFixed(1));
}

function getFirstText(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const { content } = value as { content?: unknown };
  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const item of content) {
    if (
      item !== null &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return (item as { text: string }).text;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseProgress(value: unknown): MemoryCommitProgress | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.stage !== "string" ||
    typeof value.message !== "string" ||
    typeof value.elapsedMs !== "number"
  ) {
    return undefined;
  }

  const progress: MemoryCommitProgress = {
    stage: value.stage as MemoryCommitProgress["stage"],
    message: value.message,
    elapsedMs: roundMs(value.elapsedMs),
  };

  if (typeof value.branch === "string") {
    progress.branch = value.branch;
  }
  if (typeof value.model === "string") {
    progress.model = value.model;
  }
  if (typeof value.logSizeBytes === "number") {
    progress.logSizeBytes = value.logSizeBytes;
  }
  if (typeof value.commitsSizeBytes === "number") {
    progress.commitsSizeBytes = value.commitsSizeBytes;
  }
  if (typeof value.exitCode === "number") {
    progress.exitCode = value.exitCode;
  }
  if (typeof value.stderrPreview === "string") {
    progress.stderrPreview = value.stderrPreview;
  }
  if (typeof value.operation === "string") {
    progress.operation = value.operation as MemoryCommitOperation;
  }
  if (typeof value.chunkIndex === "number") {
    progress.chunkIndex = value.chunkIndex;
  }
  if (typeof value.chunkCount === "number") {
    progress.chunkCount = value.chunkCount;
  }

  return progress;
}

function updateActiveBranch(stateYaml: string, branch: string): string {
  if (stateYaml.includes("active_branch:")) {
    return stateYaml.replace(
      /^active_branch:.*$/m,
      `active_branch: "${branch}"`
    );
  }

  return `active_branch: "${branch}"\n${stateYaml}`;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }

  return `${roundMs(ms).toFixed(1)}ms`;
}

function formatTimelineLabel(entry: MemoryCommitTimelineEntry): string {
  if (
    entry.operation === ("chunk_distill" as MemoryCommitOperation) &&
    typeof entry.chunkIndex === "number" &&
    typeof entry.chunkCount === "number"
  ) {
    return `${entry.operation} ${entry.chunkIndex}/${entry.chunkCount}`;
  }

  if (entry.operation) {
    return entry.operation;
  }

  return "memory_commit";
}

export function buildMemoryCommitProfile(
  progress: MemoryCommitProgress[]
): MemoryCommitProfileSummary {
  const timeline = progress.map((entry, index) => {
    const previous = index > 0 ? progress[index - 1] : undefined;
    return {
      ...entry,
      deltaMs: roundMs(
        previous ? entry.elapsedMs - previous.elapsedMs : entry.elapsedMs
      ),
    };
  });
  const stageTotals = new Map<string, number>();

  for (let i = 0; i < timeline.length - 1; i += 1) {
    const current = timeline[i];
    const next = timeline[i + 1];
    if (!current || !next) {
      continue;
    }

    const durationMs = roundMs(next.elapsedMs - current.elapsedMs);
    stageTotals.set(
      current.stage,
      roundMs((stageTotals.get(current.stage) ?? 0) + durationMs)
    );
  }

  const orderedStageTotals: MemoryCommitStageTotal[] = [];
  for (const [stage, durationMs] of stageTotals.entries()) {
    const entry = { stage, durationMs };
    const insertAt = orderedStageTotals.findIndex(
      (candidate) => candidate.durationMs < durationMs
    );
    if (insertAt === -1) {
      orderedStageTotals.push(entry);
    } else {
      orderedStageTotals.splice(insertAt, 0, entry);
    }
  }

  return {
    totalElapsedMs: roundMs(timeline.at(-1)?.elapsedMs ?? 0),
    timeline,
    stageTotals: orderedStageTotals,
  };
}

export function getDefaultMemoryCommitStaircaseCases(): MemoryCommitStaircaseCase[] {
  return DEFAULT_MEMORY_COMMIT_STAIRCASE_CASES.map((entry) => ({ ...entry }));
}

export function buildSyntheticOtaLog(
  options: BuildSyntheticOtaLogOptions
): string {
  const lines: string[] = [];

  for (let index = 1; index <= options.turns; index += 1) {
    const minute = index % 60;
    lines.push(
      JSON.stringify({
        version: 1,
        turnNumber: index,
        timestamp: `2026-03-26T${String(options.hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
        model: options.model,
        thought: `Turn ${index} for ${options.label} test.`,
        thinking: "",
        actions: [`read(file${index})`],
        observations: ["read: success"],
      })
    );
  }

  return `${lines.join("\n")}\n`;
}

export function setActiveMemoryBranch(
  projectDir: string,
  branch: string
): void {
  const statePath = resolve(projectDir, ".memory", "state.yaml");
  const stateYaml = existsSync(statePath)
    ? readFileSync(statePath, "utf8")
    : "";
  writeFileSync(statePath, updateActiveBranch(stateYaml, branch));
}

export function prepareMemoryCommitBranch(
  options: PrepareMemoryCommitBranchOptions
): void {
  const memoryDir = resolve(options.projectDir, ".memory");
  const branchDir = resolve(memoryDir, "branches", options.branch);

  mkdirSync(branchDir, { recursive: true });
  writeFileSync(resolve(branchDir, "commits.jsonl"), "");
  writeFileSync(resolve(branchDir, "log.jsonl"), options.logContent);
  writeFileSync(
    resolve(branchDir, "metadata.json"),
    `${JSON.stringify(
      {
        version: 1,
        fileStructure: {},
        envConfig: {},
        notes: [],
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    resolve(branchDir, "commit-context.json"),
    `${JSON.stringify(
      {
        version: 1,
        branchPurpose: options.purpose,
        previousProgressSummary: "Initial commit.",
        latestContributionBullets: [],
      },
      null,
      2
    )}\n`
  );

  setActiveMemoryBranch(options.projectDir, options.branch);
}

export function buildMemoryCommitPrompt(
  summary: string,
  updateRoadmap: boolean
): string {
  return [
    `Use the memory_commit tool now with summary "${summary}" and update_roadmap ${updateRoadmap ? "true" : "false"}.`,
    "Report the exact tool result only.",
  ].join(" ");
}

function getDefaultExtensionPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), "./index.ts");
}

export function summarizeMemoryCommitJsonl(
  jsonl: string
): MemoryCommitJsonlSummary {
  const invocations: MemoryCommitInvocationSummary[] = [];
  let current: MemoryCommitInvocationSummary | null = null;

  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.toolName !== "memory_commit") {
        continue;
      }

      if (parsed.type === "tool_execution_start") {
        current = {
          args:
            parsed.args !== null && typeof parsed.args === "object"
              ? (parsed.args as Record<string, unknown>)
              : undefined,
          updates: [],
          progress: [],
        };
        invocations.push(current);
        continue;
      }

      if (!current) {
        continue;
      }

      if (parsed.type === "tool_execution_update") {
        const text = getFirstText(parsed.partialResult);
        if (text) {
          current.updates.push(text);
        }

        const details = parseProgress(
          isRecord(parsed.partialResult)
            ? parsed.partialResult.details
            : undefined
        );
        if (details) {
          current.progress.push(details);
          current.profile = buildMemoryCommitProfile(current.progress);
        }
        continue;
      }

      if (parsed.type === "tool_execution_end") {
        current.finalText = getFirstText(parsed.result);
        current.isError =
          typeof parsed.isError === "boolean" ? parsed.isError : undefined;
      }
    } catch {
      // Ignore malformed lines in debug summaries.
    }
  }

  return { invocations };
}

function runMemoryCommitCommand(options: RunMemoryCommitCommandOptions): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  const extensionPath = options.extensionPath ?? getDefaultExtensionPath();
  const prompt = buildMemoryCommitPrompt(
    options.summary,
    options.updateRoadmap
  );

  const result = spawnSync(
    "pi",
    [
      "--no-session",
      "--no-extensions",
      "-e",
      extensionPath,
      "--mode",
      "json",
      "-p",
      prompt,
    ],
    {
      cwd: options.projectDir,
      encoding: "utf8",
      timeout: options.timeoutMs,
    }
  );

  if (options.jsonlPath) {
    writeFileSync(options.jsonlPath, result.stdout ?? "");
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
  };
}

export function runMemoryCommitStaircase(
  options: MemoryCommitStaircaseOptions,
  runCommand: RunMemoryCommitCommand = runMemoryCommitCommand
): MemoryCommitStaircaseResult {
  const staircaseCases =
    options.cases ?? getDefaultMemoryCommitStaircaseCases();
  const model =
    options.model ??
    readConfiguredCommitterModelForDebug(options.projectDir) ??
    "unknown/model";
  const branchPrefix = options.branchPrefix ?? "staircase";
  const summaryPrefix = options.summaryPrefix ?? "Memory commit staircase";
  const purposePrefix =
    options.purposePrefix ?? "Memory commit staircase branch";
  const updateRoadmap = options.updateRoadmap ?? false;
  const results: MemoryCommitStaircaseCaseResult[] = [];

  for (const [index, staircaseCase] of staircaseCases.entries()) {
    const branch = `${branchPrefix}-${staircaseCase.key}`;
    const jsonlPath = options.outputDir
      ? resolve(options.outputDir, `${branch}.jsonl`)
      : undefined;

    options.onProgress?.({
      stage: "case_start",
      caseIndex: index + 1,
      caseCount: staircaseCases.length,
      key: staircaseCase.key,
      turns: staircaseCase.turns,
      branch,
    });

    prepareMemoryCommitBranch({
      projectDir: options.projectDir,
      branch,
      purpose: `${purposePrefix} (${staircaseCase.key}).`,
      logContent: buildSyntheticOtaLog({
        turns: staircaseCase.turns,
        label: staircaseCase.key,
        model,
        hour: staircaseCase.hour,
      }),
    });

    const commandResult = runCommand({
      projectDir: options.projectDir,
      summary: `${summaryPrefix} ${staircaseCase.key}`,
      updateRoadmap,
      jsonlPath,
      extensionPath: options.extensionPath,
      timeoutMs: options.timeoutMs,
    });
    if (jsonlPath) {
      mkdirSync(dirname(jsonlPath), { recursive: true });
      writeFileSync(jsonlPath, commandResult.stdout);
    }
    const summary = summarizeMemoryCommitJsonl(commandResult.stdout);
    const invocation = summary.invocations.at(-1);

    const caseResult: MemoryCommitStaircaseCaseResult = {
      key: staircaseCase.key,
      turns: staircaseCase.turns,
      branch,
      jsonlPath,
      totalElapsedMs: invocation?.profile?.totalElapsedMs,
      finalText: invocation?.finalText,
      isError: invocation?.isError,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      exitCode: commandResult.exitCode,
    };
    results.push(caseResult);

    options.onProgress?.({
      stage: "case_finish",
      caseIndex: index + 1,
      caseCount: staircaseCases.length,
      key: staircaseCase.key,
      turns: staircaseCase.turns,
      branch,
      totalElapsedMs: caseResult.totalElapsedMs,
      exitCode: caseResult.exitCode,
      isError: caseResult.isError,
    });
  }

  return { model, cases: results };
}

function requireOption(
  options: Record<string, string>,
  key: string,
  command: string
): string {
  const value = options[key];
  if (!value) {
    throw new Error(`Missing --${key} for ${command}`);
  }

  return value;
}

function parseCliCommand(argv: string[]): ParsedCliCommand {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = normalizedArgv;
  if (
    command !== "prepare-tiny" &&
    command !== "run" &&
    command !== "staircase" &&
    command !== "summarize" &&
    command !== "smoke" &&
    command !== "switch"
  ) {
    throw new Error(
      'Expected command: "prepare-tiny", "run", "staircase", "summarize", "smoke", or "switch"'
    );
  }

  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag?.startsWith("--") || !value) {
      throw new Error(`Invalid arguments for ${command}`);
    }
    options[flag.slice(2)] = value;
  }

  return { command, options };
}

function printInvocationSummary(summary: MemoryCommitJsonlSummary): void {
  for (const [index, invocation] of summary.invocations.entries()) {
    console.log(`Invocation ${index + 1}`);
    if (invocation.args) {
      console.log(`ARGS ${JSON.stringify(invocation.args)}`);
    }
    for (const update of invocation.updates) {
      console.log(`UPD ${update}`);
    }
    if (invocation.profile) {
      console.log(
        `PROFILE total=${formatDuration(invocation.profile.totalElapsedMs)}`
      );
      for (const entry of invocation.profile.timeline) {
        console.log(
          `STEP ${formatDuration(entry.elapsedMs)} (+${formatDuration(entry.deltaMs)}) [${formatTimelineLabel(entry)}] ${entry.stage} :: ${entry.message}`
        );
      }
      for (const stageTotal of invocation.profile.stageTotals) {
        console.log(
          `STAGE_TOTAL ${stageTotal.stage} ${formatDuration(stageTotal.durationMs)}`
        );
      }
    }
    if (invocation.finalText) {
      console.log(`FINAL ${invocation.finalText}`);
    }
  }
}

function printMemoryCommitStaircaseSummary(
  result: MemoryCommitStaircaseResult
): void {
  if (result.model) {
    console.log(`MODEL ${result.model}`);
  }

  for (const staircaseCase of result.cases) {
    const total =
      staircaseCase.totalElapsedMs === undefined
        ? "n/a"
        : formatDuration(staircaseCase.totalElapsedMs);
    console.log(
      `CASE ${staircaseCase.key} turns=${staircaseCase.turns} total=${total} exit=${staircaseCase.exitCode ?? "null"} error=${staircaseCase.isError === true ? "true" : "false"}`
    );
    if (staircaseCase.finalText) {
      console.log(`FINAL ${staircaseCase.finalText.split("\n", 1)[0]}`);
    }
    if (staircaseCase.jsonlPath) {
      console.log(`JSONL ${staircaseCase.jsonlPath}`);
    }
  }
}

function printMemoryCommitStaircaseProgress(
  progress: MemoryCommitStaircaseProgress
): void {
  const prefix = `${progress.caseIndex}/${progress.caseCount} ${progress.key}`;

  if (progress.stage === "case_start") {
    console.log(
      `RUN ${prefix} turns=${progress.turns} branch=${progress.branch}`
    );
    return;
  }

  const total =
    progress.totalElapsedMs === undefined
      ? "n/a"
      : formatDuration(progress.totalElapsedMs);
  console.log(
    `DONE ${prefix} total=${total} exit=${progress.exitCode ?? "null"} error=${progress.isError === true ? "true" : "false"}`
  );
}

export function runMemoryCommitDebugCli(): void {
  const parsed = parseCliCommand(process.argv.slice(2));

  if (parsed.command === "prepare-tiny") {
    prepareMemoryCommitBranch({
      projectDir: requireOption(parsed.options, "project", parsed.command),
      branch: requireOption(parsed.options, "branch", parsed.command),
      purpose: requireOption(parsed.options, "purpose", parsed.command),
      logContent: requireOption(parsed.options, "log-text", parsed.command),
    });
    return;
  }

  if (parsed.command === "summarize") {
    const jsonlPath = requireOption(parsed.options, "jsonl", parsed.command);
    const jsonl = readFileSync(jsonlPath, "utf8");
    printInvocationSummary(summarizeMemoryCommitJsonl(jsonl));
    return;
  }

  if (parsed.command === "switch") {
    setActiveMemoryBranch(
      requireOption(parsed.options, "project", parsed.command),
      requireOption(parsed.options, "branch", parsed.command)
    );
    return;
  }

  if (parsed.command === "smoke") {
    const projectDir = requireOption(parsed.options, "project", parsed.command);
    const branch = requireOption(parsed.options, "branch", parsed.command);
    const purpose = parsed.options.purpose ?? `Smoke test branch ${branch}`;
    const logText = requireOption(parsed.options, "log-text", parsed.command);
    prepareMemoryCommitBranch({
      projectDir,
      branch,
      purpose,
      logContent: logText,
    });
  }

  if (parsed.command === "staircase") {
    const outputDir = parsed.options["output-dir"];
    if (outputDir) {
      mkdirSync(outputDir, { recursive: true });
    }

    const result = runMemoryCommitStaircase({
      projectDir: requireOption(parsed.options, "project", parsed.command),
      model: parsed.options.model,
      branchPrefix: parsed.options["branch-prefix"],
      summaryPrefix: parsed.options["summary-prefix"],
      purposePrefix: parsed.options["purpose-prefix"],
      updateRoadmap: parsed.options["update-roadmap"] === "true",
      outputDir,
      extensionPath: parsed.options.extension,
      timeoutMs: parsed.options.timeout
        ? Number.parseInt(parsed.options.timeout, 10)
        : undefined,
      onProgress: printMemoryCommitStaircaseProgress,
    });
    printMemoryCommitStaircaseSummary(result);
    return;
  }

  const result = runMemoryCommitCommand({
    projectDir: requireOption(parsed.options, "project", parsed.command),
    summary: requireOption(parsed.options, "summary", parsed.command),
    updateRoadmap: parsed.options["update-roadmap"] === "true",
    jsonlPath: parsed.options.jsonl,
    extensionPath: parsed.options.extension,
    timeoutMs: parsed.options.timeout
      ? Number.parseInt(parsed.options.timeout, 10)
      : undefined,
  });

  if (result.stderr !== "") {
    process.stderr.write(result.stderr);
  }

  printInvocationSummary(summarizeMemoryCommitJsonl(result.stdout));
  process.exitCode = result.exitCode ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMemoryCommitDebugCli();
}
