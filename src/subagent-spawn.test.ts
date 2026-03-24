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
type ErrorListener = (error: Error) => void;
type ProcessEventName = "close" | "error";

class MockChildProcess extends EventTarget {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  private closeListeners = new Map<CloseListener, EventListener>();
  private errorListeners = new Map<ErrorListener, EventListener>();

  on(event: "close", listener: CloseListener): this;
  on(event: "error", listener: ErrorListener): this;
  on(event: ProcessEventName, listener: CloseListener | ErrorListener): this {
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
  once(event: "error", listener: ErrorListener): this;
  once(event: ProcessEventName, listener: CloseListener | ErrorListener): this {
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
  off(event: "error", listener: ErrorListener): this;
  off(event: ProcessEventName, listener: CloseListener | ErrorListener): this {
    if (event === "close") {
      const closeListener = listener as CloseListener;
      const wrapped = this.closeListeners.get(closeListener);
      if (wrapped) {
        this.removeEventListener(event, wrapped);
        this.closeListeners.delete(closeListener);
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

  it("should fail fast when the committer subagent exceeds the timeout", async () => {
    const proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);

    const resultPromise = spawnCommitter(process.cwd(), "distill", {
      timeoutMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(proc.killed).toBeTruthy();
    expect(result.exitCode).toBe(124);
    expect(result.error).toContain("timed out");
  });
});
