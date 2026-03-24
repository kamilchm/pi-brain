import { PassThrough } from "node:stream";

import { spawnCommitter } from "./subagent.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock(import("node:child_process"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: spawnMock as unknown as typeof actual.spawn,
  };
});

type CloseListener = (code?: number | null) => void;
type ExitListener = (code?: number | null) => void;
type ErrorListener = (error: Error) => void;
type ProcessEventName = "close" | "error" | "exit";

class MockChildProcess extends EventTarget {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  pid = 4321;
  private closeListeners = new Map<CloseListener, EventListener>();
  private exitListeners = new Map<ExitListener, EventListener>();
  private errorListeners = new Map<ErrorListener, EventListener>();

  on(event: "close", listener: CloseListener): this;
  on(event: "exit", listener: ExitListener): this;
  on(event: "error", listener: ErrorListener): this;
  on(
    event: ProcessEventName,
    listener: CloseListener | ExitListener | ErrorListener
  ): this {
    if (event === "close") {
      const closeListener = listener as CloseListener;
      const wrapped: EventListener = (evt) => {
        if (evt instanceof CustomEvent) {
          closeListener(evt.detail as number | null | undefined);
        }
      };
      this.closeListeners.set(closeListener, wrapped);
      this.addEventListener(event, wrapped);
      return this;
    }

    if (event === "exit") {
      const exitListener = listener as ExitListener;
      const wrapped: EventListener = (evt) => {
        if (evt instanceof CustomEvent) {
          exitListener(evt.detail as number | null | undefined);
        }
      };
      this.exitListeners.set(exitListener, wrapped);
      this.addEventListener(event, wrapped);
      return this;
    }

    const errorListener = listener as ErrorListener;
    const wrapped: EventListener = (evt) => {
      if (evt instanceof CustomEvent) {
        errorListener(evt.detail as Error);
      }
    };
    this.errorListeners.set(errorListener, wrapped);
    this.addEventListener(event, wrapped);
    return this;
  }

  once(event: "close", listener: CloseListener): this;
  once(event: "exit", listener: ExitListener): this;
  once(event: "error", listener: ErrorListener): this;
  once(
    event: ProcessEventName,
    listener: CloseListener | ExitListener | ErrorListener
  ): this {
    if (event === "close") {
      const closeListener = listener as CloseListener;
      const wrapped: EventListener = (evt) => {
        this.off("close", closeListener);
        if (evt instanceof CustomEvent) {
          closeListener(evt.detail as number | null | undefined);
        }
      };
      this.closeListeners.set(closeListener, wrapped);
      this.addEventListener(event, wrapped, { once: true });
      return this;
    }

    if (event === "exit") {
      const exitListener = listener as ExitListener;
      const wrapped: EventListener = (evt) => {
        this.off("exit", exitListener);
        if (evt instanceof CustomEvent) {
          exitListener(evt.detail as number | null | undefined);
        }
      };
      this.exitListeners.set(exitListener, wrapped);
      this.addEventListener(event, wrapped, { once: true });
      return this;
    }

    const errorListener = listener as ErrorListener;
    const wrapped: EventListener = (evt) => {
      this.off("error", errorListener);
      if (evt instanceof CustomEvent) {
        errorListener(evt.detail as Error);
      }
    };
    this.errorListeners.set(errorListener, wrapped);
    this.addEventListener(event, wrapped, { once: true });
    return this;
  }

  off(event: "close", listener: CloseListener): this;
  off(event: "exit", listener: ExitListener): this;
  off(event: "error", listener: ErrorListener): this;
  off(
    event: ProcessEventName,
    listener: CloseListener | ExitListener | ErrorListener
  ): this {
    if (event === "close") {
      const closeListener = listener as CloseListener;
      const wrapped = this.closeListeners.get(closeListener);
      if (wrapped) {
        this.removeEventListener(event, wrapped);
        this.closeListeners.delete(closeListener);
      }
      return this;
    }

    if (event === "exit") {
      const exitListener = listener as ExitListener;
      const wrapped = this.exitListeners.get(exitListener);
      if (wrapped) {
        this.removeEventListener(event, wrapped);
        this.exitListeners.delete(exitListener);
      }
      return this;
    }

    const errorListener = listener as ErrorListener;
    const wrapped = this.errorListeners.get(errorListener);
    if (wrapped) {
      this.removeEventListener(event, wrapped);
      this.errorListeners.delete(errorListener);
    }
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.dispatchEvent(
      new CustomEvent<number>("exit", {
        detail: signal === "SIGKILL" ? 137 : 124,
      })
    );
    this.dispatchEvent(
      new CustomEvent<number>("close", {
        detail: signal === "SIGKILL" ? 137 : 124,
      })
    );
    return true;
  }
}

describe("spawnCommitter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should report lifecycle progress while the committer runs", async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);

    const progress: {
      stage: string;
      message: string;
      elapsedMs: number;
      pid?: number;
      exitCode?: number;
    }[] = [];

    const resultPromise = spawnCommitter(process.cwd(), "distill", {
      onProgress(update) {
        progress.push(update);
      },
    });

    proc.stdout.write(
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "### Branch Purpose\nDone." }],
        },
      })}\n`
    );
    proc.stderr.write("provider warning\n");
    proc.dispatchEvent(new CustomEvent<number>("close", { detail: 0 }));

    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(progress.map((update) => update.stage)).toStrictEqual([
      "spawned",
      "stdout",
      "stderr",
      "finished",
    ]);
    expect(progress[0]).toMatchObject({
      stage: "spawned",
      pid: 4321,
    });
    expect(progress.at(-1)).toMatchObject({
      stage: "finished",
      exitCode: 0,
    });
  });

  it("should fail fast when the committer subagent exceeds the timeout", async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);

    const progress: {
      stage: string;
      message: string;
      elapsedMs: number;
    }[] = [];

    const resultPromise = spawnCommitter(process.cwd(), "distill", {
      timeoutMs: 1000,
      onProgress(update) {
        progress.push(update);
      },
    });

    proc.stdout.write(
      `${JSON.stringify({
        type: "tool_execution_start",
        toolName: "read",
        args: { path: ".memory/branches/main/log.md" },
      })}\n`
    );
    proc.stderr.write("provider slow response\nretrying\n");

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(proc.killed).toBeTruthy();
    expect(result.exitCode).toBe(124);
    expect(result.error).toContain("timed out");
    expect(result.error).toContain("Normalized tools: read,grep,find,ls");
    expect(result.error).toContain("Last stdout event: tool_execution_start");
    expect(result.error).toContain("tool read");
    expect(result.error).toContain(".memory/branches/main/log.md");
    expect(result.error).toContain("Stderr tail:");
    expect(result.error).toContain("retrying");
    expect(progress.map((update) => update.stage)).toContain("timed_out");
  });

  it("should stop waiting once the child exits after timeout even if close never fires", async () => {
    const proc = new MockChildProcess();
    proc.kill = () => {
      proc.killed = true;
      return true;
    };
    spawnMock.mockReturnValue(proc);

    const resultPromise = spawnCommitter(process.cwd(), "distill", {
      timeoutMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1001);
    proc.dispatchEvent(new CustomEvent<number>("exit", { detail: 124 }));
    const result = await resultPromise;

    expect(proc.killed).toBeTruthy();
    expect(result).toMatchObject({
      exitCode: 124,
      error: expect.stringContaining("timed out"),
    });
  });
});
