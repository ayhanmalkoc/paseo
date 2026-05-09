import { describe, expect, test, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Logger } from "pino";

import { CodexAppServerJsonRpcClient } from "./codex-app-server-json-rpc.js";

interface FakeChildProcess extends ChildProcessWithoutNullStreams {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

describe("CodexAppServerJsonRpcClient", () => {
  test("ignores Windows process cleanup stdout lines without warning stack noise", async () => {
    const child = createFakeChildProcess();
    const logger = createMockLogger();
    const client = new CodexAppServerJsonRpcClient(child, logger);

    const resultPromise = client.request("ping", undefined, 1_000);

    child.stdout.write("SUCCESS: The process with PID 1234 has been terminated.\n");
    child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);

    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(logger.debug).toHaveBeenCalledWith(
      { line: "SUCCESS: The process with PID 1234 has been terminated." },
      "Ignoring process cleanup line from Codex app-server stdout",
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();

    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
    child.emit("exit", 0, null);
  });

  test("warns for unexpected non-JSON stdout lines without attaching a stack", async () => {
    const child = createFakeChildProcess();
    const logger = createMockLogger();
    const client = new CodexAppServerJsonRpcClient(child, logger);

    const resultPromise = client.request("ping", undefined, 1_000);

    child.stdout.write("not-json\n");
    child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);

    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(logger.warn).toHaveBeenCalledWith(
      { line: "not-json" },
      "Ignoring non-JSON line from Codex app-server stdout",
    );
    expect(logger.error).not.toHaveBeenCalled();

    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
    child.emit("exit", 0, null);
  });
});

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}
