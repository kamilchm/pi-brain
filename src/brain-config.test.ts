import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  readConfiguredCommitterModel,
  readConfiguredCommitterModelConfig,
  readConfiguredCommitterTimeoutMs,
} from "./brain-config.js";

describe("readConfiguredCommitterModel", () => {
  let tmpDir: string;
  let agentDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-config-test-"));
    agentDir = path.join(tmpDir, "agent");
    projectDir = path.join(tmpDir, "project");

    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".pi", "extensions"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return undefined when no config sources are present", () => {
    const result = readConfiguredCommitterModel(projectDir, agentDir, {});

    expect(result).toBeUndefined();
  });

  it("should read the global committer model from the agent dir", () => {
    fs.writeFileSync(
      path.join(agentDir, "extensions", "pi-brain.json"),
      JSON.stringify({ committerModel: "google-antigravity/gemini-3-flash" })
    );

    const result = readConfiguredCommitterModel(projectDir, agentDir, {});
    const detailed = readConfiguredCommitterModelConfig(
      projectDir,
      agentDir,
      {}
    );

    expect(result).toBe("google-antigravity/gemini-3-flash");
    expect(detailed).toStrictEqual({
      model: "google-antigravity/gemini-3-flash",
      source: `global config (${path.join(agentDir, "extensions", "pi-brain.json")})`,
    });
  });

  it("should let project config override global config", () => {
    fs.writeFileSync(
      path.join(agentDir, "extensions", "pi-brain.json"),
      JSON.stringify({ committerModel: "google-antigravity/gemini-3-flash" })
    );
    fs.writeFileSync(
      path.join(projectDir, ".pi", "extensions", "pi-brain.json"),
      JSON.stringify({ committerModel: "anthropic/claude-sonnet-4-5" })
    );

    const result = readConfiguredCommitterModel(projectDir, agentDir, {});

    expect(result).toBe("anthropic/claude-sonnet-4-5");
  });

  it("should let environment override file config", () => {
    fs.writeFileSync(
      path.join(agentDir, "extensions", "pi-brain.json"),
      JSON.stringify({ committerModel: "google-antigravity/gemini-3-flash" })
    );

    const result = readConfiguredCommitterModel(projectDir, agentDir, {
      PI_BRAIN_COMMIT_MODEL: "openai/gpt-5-mini",
    });
    const detailed = readConfiguredCommitterModelConfig(projectDir, agentDir, {
      PI_BRAIN_COMMIT_MODEL: "openai/gpt-5-mini",
    });

    expect(result).toBe("openai/gpt-5-mini");
    expect(detailed).toStrictEqual({
      model: "openai/gpt-5-mini",
      source: "environment variable (PI_BRAIN_COMMIT_MODEL)",
    });
  });

  it("should format global config paths using tilde when HOME matches", () => {
    const homeDir = path.join(tmpDir, "home");
    const customAgentDir = path.join(homeDir, ".pi", "agent");
    fs.mkdirSync(path.join(customAgentDir, "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(customAgentDir, "extensions", "pi-brain.json"),
      JSON.stringify({ committerModel: "github-copilot/gpt-5.4-mini" })
    );

    const result = readConfiguredCommitterModelConfig(
      projectDir,
      customAgentDir,
      {
        HOME: homeDir,
      }
    );

    expect(result).toStrictEqual({
      model: "github-copilot/gpt-5.4-mini",
      source: "global config (~/.pi/agent/extensions/pi-brain.json)",
    });
  });

  it("should ignore invalid config files", () => {
    fs.writeFileSync(
      path.join(agentDir, "extensions", "pi-brain.json"),
      "{ not valid json"
    );

    const result = readConfiguredCommitterModel(projectDir, agentDir, {});

    expect(result).toBeUndefined();
  });

  it("should read the global committer timeout from config", () => {
    fs.writeFileSync(
      path.join(agentDir, "extensions", "pi-brain.json"),
      JSON.stringify({ committerTimeoutMs: 180_000 })
    );

    const result = readConfiguredCommitterTimeoutMs(projectDir, agentDir, {});

    expect(result).toBe(180_000);
  });

  it("should let environment override configured committer timeout", () => {
    fs.writeFileSync(
      path.join(agentDir, "extensions", "pi-brain.json"),
      JSON.stringify({ committerTimeoutMs: 180_000 })
    );

    const result = readConfiguredCommitterTimeoutMs(projectDir, agentDir, {
      PI_BRAIN_COMMIT_TIMEOUT_MS: "240000",
    });

    expect(result).toBe(240_000);
  });

  it("should ignore removed committerRunner config", () => {
    fs.writeFileSync(
      path.join(projectDir, ".pi", "extensions", "pi-brain.json"),
      JSON.stringify({
        committerModel: "github-copilot/grok-code-fast-1",
        committerRunner: "rpc",
      })
    );

    const result = readConfiguredCommitterModelConfig(projectDir, agentDir, {});

    expect(result).toStrictEqual({
      model: "github-copilot/grok-code-fast-1",
      source: `project config (${path.join(projectDir, ".pi", "extensions", "pi-brain.json")})`,
    });
  });
});
