import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BranchManager } from "./branches.js";
import {
  createInitialBranchMetadata,
  parseBranchMetadata,
  serializeBranchMetadata,
} from "./metadata.js";

describe("metadata", () => {
  it("should create default structured branch metadata", () => {
    expect(createInitialBranchMetadata()).toStrictEqual({
      version: 1,
      fileStructure: {},
      envConfig: {},
      notes: [],
    });
  });

  it("should serialize and parse structured branch metadata", () => {
    const serialized = serializeBranchMetadata({
      version: 1,
      fileStructure: {
        "src/index.ts": "extension entrypoint",
      },
      envConfig: {
        NODE_ENV: "development",
      },
      notes: ["Initialized structured metadata."],
    });

    expect(parseBranchMetadata(serialized)).toStrictEqual({
      version: 1,
      fileStructure: {
        "src/index.ts": "extension entrypoint",
      },
      envConfig: {
        NODE_ENV: "development",
      },
      notes: ["Initialized structured metadata."],
    });
  });

  it("should reject malformed metadata", () => {
    expect(
      parseBranchMetadata(
        '{"version":1,"fileStructure":[],"envConfig":{},"notes":[]}'
      )
    ).toBeNull();
    expect(
      parseBranchMetadata(
        '{"version":1,"fileStructure":{},"envConfig":{},"notes":[1]}'
      )
    ).toBeNull();
  });
});

describe("branchManager metadata integration", () => {
  let tmpDir: string;
  let manager: BranchManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-metadata-test-"));
    fs.mkdirSync(path.join(tmpDir, ".memory", "branches"), {
      recursive: true,
    });
    manager = new BranchManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should initialize metadata.json with the structured schema", () => {
    manager.createBranch("main", "Main branch");

    expect(manager.readMetadata("main")).toStrictEqual({
      version: 1,
      fileStructure: {},
      envConfig: {},
      notes: [],
    });
  });

  it("should persist structured metadata updates", () => {
    manager.createBranch("main", "Main branch");
    manager.writeMetadata("main", {
      version: 1,
      fileStructure: {
        "src/index.ts": "extension entrypoint",
      },
      envConfig: {
        PNPM_HOME: "/tmp/pnpm",
      },
      notes: ["Updated metadata."],
    });

    expect(manager.readMetadata("main")).toStrictEqual({
      version: 1,
      fileStructure: {
        "src/index.ts": "extension entrypoint",
      },
      envConfig: {
        PNPM_HOME: "/tmp/pnpm",
      },
      notes: ["Updated metadata."],
    });
  });
});
