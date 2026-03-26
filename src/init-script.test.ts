import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

describe("brain-init.sh", () => {
  let tmpDir: string;
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.resolve(
    testDir,
    "../skills/brain/scripts/brain-init.sh"
  );

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-init-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create the .memory directory structure", () => {
    // Act
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    // Assert
    expect(fs.existsSync(path.join(tmpDir, ".memory/state.yaml"))).toBeTruthy();
    expect(fs.existsSync(path.join(tmpDir, ".memory/AGENTS.md"))).toBeTruthy();
    expect(fs.existsSync(path.join(tmpDir, ".memory/main.md"))).toBeTruthy();
    expect(
      fs.existsSync(path.join(tmpDir, ".memory/branches/main/log.jsonl"))
    ).toBeTruthy();
    expect(
      fs.existsSync(path.join(tmpDir, ".memory/branches/main/commits.jsonl"))
    ).toBeTruthy();
    expect(
      fs.existsSync(path.join(tmpDir, ".memory/branches/main/metadata.json"))
    ).toBeTruthy();
    expect(
      fs.existsSync(
        path.join(tmpDir, ".memory/branches/main/commit-context.json")
      )
    ).toBeTruthy();
  });

  it("should initialize commit-context.json for the main branch", () => {
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    const context = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".memory/branches/main/commit-context.json"),
        "utf8"
      )
    ) as {
      branchPurpose?: string;
      previousProgressSummary?: string;
      latestContributionBullets?: string[];
    };

    expect(context.branchPurpose).toBe("Main project memory branch");
    expect(context.previousProgressSummary).toBe("Initial commit.");
    expect(context.latestContributionBullets).toStrictEqual([]);
  });

  it("should initialize metadata.json for the main branch", () => {
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".memory/branches/main/metadata.json"),
        "utf8"
      )
    ) as {
      version?: number;
      fileStructure?: Record<string, string>;
      envConfig?: Record<string, string>;
      notes?: string[];
    };

    expect(metadata.version).toBe(1);
    expect(metadata.fileStructure).toStrictEqual({});
    expect(metadata.envConfig).toStrictEqual({});
    expect(metadata.notes).toStrictEqual([]);
  });

  it("should write correct state.yaml with active_branch: main", () => {
    // Act
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    // Assert
    const state = fs.readFileSync(
      path.join(tmpDir, ".memory/state.yaml"),
      "utf8"
    );
    expect(state).toContain("active_branch: main");
    expect(state).toContain("initialized:");
  });

  it("should create root AGENTS.md with static Brain section", () => {
    // Act
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    // Assert
    const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Brain");
    expect(agents).toContain(
      "Tools: memory_commit, memory_branch (create/switch/merge)"
    );
    expect(agents).not.toContain("Current branch:");
  });

  it("should append to existing AGENTS.md without duplicating", () => {
    // Arrange
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      "# My Project\n\nExisting content.\n"
    );

    // Act
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    // Assert
    const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("# My Project");
    expect(agents).toContain("Existing content.");
    expect(agents).toContain("## Brain");
  });

  it("should be idempotent — running twice does not duplicate Brain section", () => {
    // Act
    execFileSync("bash", [scriptPath], { cwd: tmpDir });
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    // Assert
    const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf8");
    const brainMatches = agents.match(/## Brain/g);
    expect(brainMatches?.length).toBe(1);
  });

  it("should not overwrite existing .memory files on second run", () => {
    // Arrange
    execFileSync("bash", [scriptPath], { cwd: tmpDir });
    const statePath = path.join(tmpDir, ".memory/state.yaml");
    const originalState = fs.readFileSync(statePath, "utf8");
    fs.writeFileSync(statePath, `${originalState}\nmodified: true`);

    // Act
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    // Assert
    const stateAfter = fs.readFileSync(statePath, "utf8");
    expect(stateAfter).toContain("modified: true");
  });

  it("should add log.jsonl pattern to .gitignore idempotently", () => {
    // Act
    execFileSync("bash", [scriptPath], { cwd: tmpDir });
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    // Assert
    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf8");
    const matches = gitignore.match(/^\.memory\/branches\/\*\/log\.jsonl$/gm);
    expect(matches?.length).toBe(1);
  });

  it("should write .memory/AGENTS.md with protocol reference and commit checklist", () => {
    // Act
    execFileSync("bash", [scriptPath], { cwd: tmpDir });

    // Assert
    const memoryAgents = fs.readFileSync(
      path.join(tmpDir, ".memory/AGENTS.md"),
      "utf8"
    );
    expect(memoryAgents).toContain("memory_commit");
    expect(memoryAgents).toContain("memory_branch");
    expect(memoryAgents).toContain("create");
    expect(memoryAgents).toContain("switch");
    expect(memoryAgents).toContain("merge");
    expect(memoryAgents).toContain("## When to Commit");
    expect(memoryAgents).toContain("end the session");
  });
});
