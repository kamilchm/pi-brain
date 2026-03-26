import fc from "fast-check";

import {
  buildTimeoutDiagnosticSummary,
  buildCommitterTask,
  describeLastStdoutEvent,
  extractCommitBlocks,
  extractFinalText,
} from "./subagent.js";

const messageEndEventArb = fc.record({
  type: fc.constant("message_end"),
  message: fc.record({
    role: fc.oneof(fc.constant("assistant"), fc.constant("user")),
    content: fc.array(
      fc.record({
        type: fc.constant("text"),
        text: fc.string(),
      })
    ),
  }),
});

const validAssistantStdoutArb = fc
  .tuple(
    fc.array(messageEndEventArb),
    fc.record({
      type: fc.constant("message_end" as const),
      message: fc.record({
        role: fc.constant("assistant" as const),
        content: fc
          .tuple(
            fc.record({
              type: fc.constant("text"),
              text: fc.string({ minLength: 1 }),
            }),
            fc.array(
              fc.record({
                type: fc.constant("text"),
                text: fc.string(),
              })
            )
          )
          .map(([required, rest]) => [required, ...rest]),
      }),
    }),
    fc.array(messageEndEventArb)
  )
  .map(([before, required, after]) =>
    [...before, required, ...after].map((e) => JSON.stringify(e)).join("\n")
  );

const validCommitSubmissionArb = fc.record({
  branchPurpose: fc
    .string({ minLength: 1 })
    .filter((value) => value.trim() !== ""),
  previousProgressSummary: fc
    .string({ minLength: 1 })
    .filter((value) => value.trim() !== ""),
  thisCommitContributionBullets: fc.array(
    fc.string({ minLength: 1 }).filter((value) => value.trim() !== ""),
    {
      minLength: 1,
      maxLength: 5,
    }
  ),
});

describe("buildCommitterTask", () => {
  it("should build task string with branch, summary, and file paths", () => {
    const task = buildCommitterTask("main", "Fixed auth flow");

    expect(task).toContain('branch "main"');
    expect(task).toContain("Fixed auth flow");
    expect(task).toContain(".memory/AGENTS.md");
    expect(task).toContain(".memory/branches/main/log.jsonl");
    expect(task).toContain(".memory/branches/main/commit-context.json");
    expect(task).toContain("submit_memory_commit_blocks");
    expect(task).toContain("Do not answer with freeform prose");
  });

  it("should escape branch names with special characters", () => {
    const task = buildCommitterTask("feature/auth-fix", "Summary");

    expect(task).toContain("feature/auth-fix");
    expect(task).toContain(".memory/branches/feature/auth-fix/log.jsonl");
  });
});

describe("extractFinalText", () => {
  it("should extract text from the last assistant message_end event", () => {
    const stdout = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                branchPurpose: "Build the project.",
                previousProgressSummary: "Initial commit.",
                thisCommitContributionBullets: ["Added spawn module."],
              }),
            },
          ],
        },
      }),
    ].join("\n");

    const result = extractFinalText(stdout);
    expect(result).toContain("branchPurpose");
    expect(result).toContain("thisCommitContributionBullets");
  });

  it("should return the last assistant message when there are multiple", () => {
    const stdout = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Let me read the files..." }],
        },
      }),
      JSON.stringify({
        type: "tool_result_end",
        message: {
          role: "tool",
          content: [{ type: "text", text: "file contents" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({ branchPurpose: "Final answer." }),
            },
          ],
        },
      }),
    ].join("\n");

    const result = extractFinalText(stdout);
    expect(result).toContain("Final answer.");
    expect(result).not.toContain("Let me read");
  });

  it("should return empty string when stdout has no assistant messages", () => {
    expect(extractFinalText("")).toBe("");
    expect(extractFinalText("not json\n")).toBe("");
  });

  it("should handle multiple text content parts", () => {
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Part one." },
          { type: "text", text: "Part two." },
        ],
      },
    });

    const result = extractFinalText(stdout);
    expect(result).toContain("Part one.");
    expect(result).toContain("Part two.");
  });
});

describe("extractCommitBlocks", () => {
  it("should parse structured commit submissions", () => {
    const result = extractCommitBlocks(
      JSON.stringify({
        branchPurpose: "Build the memory extension.",
        previousProgressSummary: "Phase 1 done.",
        thisCommitContributionBullets: ["Phase 2 tools implemented."],
      })
    );

    expect(result).toStrictEqual({
      branchPurpose: "Build the memory extension.",
      previousProgressSummary: "Phase 1 done.",
      thisCommitContributionBullets: ["Phase 2 tools implemented."],
    });
  });

  it("should return null when structured fields are missing", () => {
    expect(extractCommitBlocks("No commit blocks here.")).toBeNull();
    expect(
      extractCommitBlocks('{"branchPurpose":"Only one field"}')
    ).toBeNull();
  });
});

describe("describeLastStdoutEvent", () => {
  it("should summarize the last structured stdout event", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "read",
        args: { path: ".memory/AGENTS.md" },
      }),
      JSON.stringify({
        type: "tool_execution_update",
        toolName: "read",
        partialResult: {
          content: [{ type: "text", text: "Reading protocol reference..." }],
        },
      }),
    ].join("\n");

    const result = describeLastStdoutEvent(stdout);

    expect(result).toContain("tool_execution_update");
    expect(result).toContain("tool read");
    expect(result).toContain("Reading protocol reference");
  });

  it("should fall back to the last raw stdout line when json parsing fails", () => {
    const result = describeLastStdoutEvent("first line\nsecond line");

    expect(result).toContain("Last stdout line");
    expect(result).toContain("second line");
  });
});

describe("buildTimeoutDiagnosticSummary", () => {
  it("should include both stdout event details and stderr tail", () => {
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Still distilling the memory commit..." },
        ],
      },
    });

    const result = buildTimeoutDiagnosticSummary(
      stdout,
      "warning one\nwarning two\n",
      "read,grep,find,ls"
    );

    expect(result).toContain("Normalized tools: read,grep,find,ls");
    expect(result).toContain("Last stdout event: message_end");
    expect(result).toContain("assistant message");
    expect(result).toContain("Still distilling the memory commit");
    expect(result).toContain("Stderr tail:");
    expect(result).toContain("warning two");
  });
});

describe("extractFinalText property-based tests", () => {
  it("should never throw on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => extractFinalText(input)).not.toThrow();
      })
    );
  });

  it("should always return a string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = extractFinalText(input);
        expect(result).toBeTypeOf("string");
      })
    );
  });

  it("should extract text from the last assistant message in valid stdout", () => {
    fc.assert(
      fc.property(validAssistantStdoutArb, (stdout) => {
        const result = extractFinalText(stdout);

        const events = stdout.split("\n").map(
          (line) =>
            JSON.parse(line) as {
              message: {
                role: string;
                content: { text: string }[];
              };
            }
        );
        const assistantEvents = events.filter(
          (e) => e.message.role === "assistant"
        );
        const assistant = assistantEvents.at(-1) as (typeof assistantEvents)[0];
        const expectedTexts = assistant.message.content
          .map((c) => c.text)
          .filter((t) => t.length > 0);
        for (const text of expectedTexts) {
          expect(result).toContain(text);
        }
      })
    );
  });
});

describe("extractCommitBlocks property-based tests", () => {
  it("should never throw on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => extractCommitBlocks(input)).not.toThrow();
      })
    );
  });

  it("should return null or an object", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = extractCommitBlocks(input);
        expect(result === null || typeof result === "object").toBeTruthy();
      })
    );
  });

  it("should extract all required fields when present", () => {
    fc.assert(
      fc.property(validCommitSubmissionArb, (submission) => {
        const result = extractCommitBlocks(JSON.stringify(submission));

        expect(result).not.toBeNull();
        expect(result?.branchPurpose).toBe(submission.branchPurpose.trim());
        expect(result?.previousProgressSummary).toBe(
          submission.previousProgressSummary.trim()
        );
        expect(result?.thisCommitContributionBullets).toStrictEqual(
          submission.thisCommitContributionBullets.map((value) => value.trim())
        );
      })
    );
  });
});

describe("buildCommitterTask property-based tests", () => {
  it("should include branch name and summary in task", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (branch, summary) => {
          const task = buildCommitterTask(branch, summary);

          expect(task).toContain(branch);
          expect(task).toContain(summary);
        }
      )
    );
  });

  it("should include all required file paths", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (branch, summary) => {
          const task = buildCommitterTask(branch, summary);

          expect(task).toContain(".memory/AGENTS.md");
          expect(task).toContain(`${branch}/log.jsonl`);
          expect(task).toContain(`${branch}/commit-context.json`);
        }
      )
    );
  });
});
