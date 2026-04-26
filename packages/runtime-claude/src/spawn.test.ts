import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  classifyClaudeTurnResult,
  spawnClaudeTurn,
  type SpawnLike,
} from "./spawn.js";

describe("spawnClaudeTurn", () => {
  it("writes stream-json input, parses ndjson output, and returns success", async () => {
    const stdin = new PassThrough();
    let writtenStdin = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      writtenStdin += chunk;
    });

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const spawnImpl: SpawnLike = (_command, _args, _options) => {
      queueMicrotask(() => {
        stdout.write('{"type":"message_start"}\n');
        stdout.write('{"type":"result","subtype":"success"}\n');
        stdout.end();
        stderr.end();
        child.emit("close", 0, null);
      });

      return child;
    };

    const child = {
      stdin,
      stdout,
      stderr,
      emit(event: string, ...args: unknown[]) {
        emitter.emit(event, ...args);
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        emitter.once(event, listener);
        return child;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        emitter.on(event, listener);
        return child;
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        emitter.removeListener(event, listener);
        return child;
      },
    } as unknown as ReturnType<SpawnLike>;

    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();

    const events: string[] = [];
    const result = await spawnClaudeTurn(
      {
        cwd: "/workspace",
        args: ["-p"],
        stdinMessages: [{ type: "user", text: "hello" }],
      },
      {
        spawnImpl,
        onEvent: (event) => {
          events.push(event.name);
        },
      }
    );

    expect(writtenStdin).toBe('{"type":"user","text":"hello"}\n');
    expect(result.result).toBe("success");
    expect(result.classification.kind).toBe("success");
    expect(events).toEqual(["agent.turnStarted", "agent.turnCompleted"]);
    expect(result.records).toEqual([
      {
        stream: "stdout",
        line: '{"type":"message_start"}',
        message: { type: "message_start" },
      },
      {
        stream: "stdout",
        line: '{"type":"result","subtype":"success"}',
        message: { type: "result", subtype: "success" },
      },
    ]);
  });

  it("preserves parse errors from non-json lines", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();

    const child = {
      stdin,
      stdout,
      stderr,
      emit(event: string, ...args: unknown[]) {
        emitter.emit(event, ...args);
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        emitter.once(event, listener);
        return child;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        emitter.on(event, listener);
        return child;
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        emitter.removeListener(event, listener);
        return child;
      },
    } as unknown as ReturnType<SpawnLike>;

    const spawnImpl: SpawnLike = () => {
      queueMicrotask(() => {
        stderr.write("permission denied\n");
        stdout.end();
        stderr.end();
        child.emit("close", 1, null);
      });

      return child;
    };

    const result = await spawnClaudeTurn(
      {
        cwd: "/workspace",
        args: ["-p"],
        stdinMessages: [],
      },
      { spawnImpl }
    );

    expect(result.result).toBe("process-error");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.stream).toBe("stderr");
    expect(result.records[0]?.parseError).toBeTypeOf("string");
  });

  it("classifies non-zero exits with error wire events and emits agent.error", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();

    const child = {
      stdin,
      stdout,
      stderr,
      emit(event: string, ...args: unknown[]) {
        emitter.emit(event, ...args);
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        emitter.once(event, listener);
        return child;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        emitter.on(event, listener);
        return child;
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        emitter.removeListener(event, listener);
        return child;
      },
    } as unknown as ReturnType<SpawnLike>;

    const spawnImpl: SpawnLike = () => {
      queueMicrotask(() => {
        stdout.write(
          '{"type":"error","error":{"type":"api_error","message":"temporarily unavailable"}}\n'
        );
        stdout.end();
        stderr.end();
        child.emit("close", 1, null);
      });

      return child;
    };
    const eventNames: string[] = [];

    const result = await spawnClaudeTurn(
      {
        cwd: "/workspace",
        args: ["-p"],
        stdinMessages: [],
      },
      {
        spawnImpl,
        onEvent: (event) => {
          eventNames.push(event.name);
        },
      }
    );

    expect(result.result).toBe("process-error");
    expect(result.classification).toMatchObject({
      kind: "process-error",
      transient: true,
      reason: "exit_1",
    });
    expect(eventNames).toEqual(["agent.error"]);
  });

  it("returns a structured process error when spawn emits error", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();

    const child = {
      stdin,
      stdout,
      stderr,
      emit(event: string, ...args: unknown[]) {
        emitter.emit(event, ...args);
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        emitter.once(event, listener);
        return child;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        emitter.on(event, listener);
        return child;
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        emitter.removeListener(event, listener);
        return child;
      },
    } as unknown as ReturnType<SpawnLike>;

    const spawnImpl: SpawnLike = () => {
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        child.emit("error", new Error("ENOENT"));
      });

      return child;
    };

    const result = await spawnClaudeTurn(
      {
        cwd: "/workspace",
        args: ["-p"],
        stdinMessages: [],
      },
      { spawnImpl }
    );

    expect(result.result).toBe("process-error");
    expect(result.errorMessage).toBe("ENOENT");
    expect(result.records).toContainEqual({
      stream: "stderr",
      line: "",
      parseError: "ENOENT",
    });
  });

  it("absorbs stdout stream errors into structured records instead of throwing", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();

    const child = {
      stdin,
      stdout,
      stderr,
      emit(event: string, ...args: unknown[]) {
        emitter.emit(event, ...args);
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        emitter.once(event, listener);
        return child;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        emitter.on(event, listener);
        return child;
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        emitter.removeListener(event, listener);
        return child;
      },
    } as unknown as ReturnType<SpawnLike>;

    const spawnImpl: SpawnLike = () => {
      queueMicrotask(() => {
        stdout.emit("error", new Error("stdout boom"));
        stdout.end();
        stderr.end();
        child.emit("close", 1, null);
      });

      return child;
    };

    const result = await spawnClaudeTurn(
      {
        cwd: "/workspace",
        args: ["-p"],
        stdinMessages: [],
      },
      { spawnImpl }
    );

    expect(result.result).toBe("process-error");
    expect(
      result.records.filter(
        (record) =>
          record.stream === "stdout" && record.parseError === "stdout boom"
      )
    ).toEqual([
      {
        stream: "stdout",
        line: "",
        parseError: "stdout boom",
      },
    ]);
  });

  it("does not hang when stdin closes before drain after backpressure", async () => {
    const stdin = new PassThrough();
    const originalWrite = stdin.write.bind(stdin);
    stdin.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding) => {
      originalWrite(
        chunk as never,
        typeof encoding === "string" ? encoding : undefined
      );
      return false;
    }) as typeof stdin.write;

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();

    const child = {
      stdin,
      stdout,
      stderr,
      emit(event: string, ...args: unknown[]) {
        emitter.emit(event, ...args);
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        emitter.once(event, listener);
        return child;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        emitter.on(event, listener);
        return child;
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        emitter.removeListener(event, listener);
        return child;
      },
    } as unknown as ReturnType<SpawnLike>;

    const spawnImpl: SpawnLike = () => {
      queueMicrotask(() => {
        stdin.destroy(new Error("stdin closed"));
        stdout.end();
        stderr.end();
        child.emit("error", new Error("ENOENT"));
      });

      return child;
    };

    const result = await spawnClaudeTurn(
      {
        cwd: "/workspace",
        args: ["-p"],
        stdinMessages: [{ type: "user", text: "hello" }],
      },
      { spawnImpl }
    );

    expect(result.result).toBe("process-error");
    expect(result.errorMessage).toBe("ENOENT");
    expect(result.records).toContainEqual({
      stream: "stderr",
      line: "",
      parseError: "ENOENT",
    });
  });
});

describe("classifyClaudeTurnResult", () => {
  it("classifies SIGTERM as a process error", () => {
    expect(classifyClaudeTurnResult(null, "SIGTERM")).toBe("process-error");
  });

  it("classifies SIGINT and SIGKILL as process errors", () => {
    expect(classifyClaudeTurnResult(null, "SIGINT")).toBe("process-error");
    expect(classifyClaudeTurnResult(null, "SIGKILL")).toBe("process-error");
  });
});
