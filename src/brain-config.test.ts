import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readConfiguredCommitterModel } from "./brain-config.js";

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

    expect(result).toBe("google-antigravity/gemini-3-flash");
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

    expect(result).toBe("openai/gpt-5-mini");
  });

  it("should ignore invalid config files", () => {
    fs.writeFileSync(
      path.join(agentDir, "extensions", "pi-brain.json"),
      "{ not valid json"
    );

    const result = readConfiguredCommitterModel(projectDir, agentDir, {});

    expect(result).toBeUndefined();
  });
});
