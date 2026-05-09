import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "pino";

import { terminateWithTreeKill } from "../../../utils/tree-kill.js";

const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message: string };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type RequestHandler = (params: unknown) => unknown;

type NotificationHandler = (method: string, params: unknown) => void;

export class CodexAppServerJsonRpcClient {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private notificationHandler: NotificationHandler | null = null;
  private nextId = 1;
  private disposed = false;
  private stderrBuffer = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly logger: Logger,
  ) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => {
      void this.handleLine(line).catch((err: unknown) => {
        this.logger.error({ err }, "Failed to handle Codex app-server JSON-RPC line");
      });
    });

    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > 8192) {
        this.stderrBuffer = this.stderrBuffer.slice(-8192);
      }
    });

    child.on("error", (err) => {
      this.logger.error({ err }, "Codex app-server child process error");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
      this.disposed = true;
    });

    child.on("exit", (code, signal) => {
      const message =
        code === 0 && !signal
          ? "Codex app-server exited"
          : `Codex app-server exited with code ${code ?? "null"} and signal ${signal ?? "null"}`;
      const error = new Error(`${message}\n${this.stderrBuffer}`.trim());
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.disposed = true;
    });
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex app-server client is closed"));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { id, method, params };
    const serialized = JSON.stringify(payload);
    this.child.stdin.write(`${serialized}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    const payload: JsonRpcNotification = { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private writeJsonRpcResponse(response: JsonRpcResponse): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      this.logger.debug({ error }, "Failed to write Codex app-server JSON-RPC response");
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rl.close();
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const result = await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "Codex app-server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "Codex app-server did not report exit after SIGKILL",
      );
    }
  }

  private async handleLine(line: string): Promise<void> {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmedLine);
    } catch {
      const logLine = truncateLogLine(trimmedLine);
      if (isWindowsProcessCleanupLine(trimmedLine)) {
        this.logger.debug(
          { line: logLine },
          "Ignoring process cleanup line from Codex app-server stdout",
        );
      } else {
        this.logger.warn({ line: logLine }, "Ignoring non-JSON line from Codex app-server stdout");
      }
      return;
    }
    if (!isRecord(raw)) {
      this.logger.warn({ line }, "Parsed JSON is not an object");
      return;
    }

    if (isJsonRpcResponse(raw)) {
      const pending = this.pending.get(raw.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(raw.id);
      if (raw.error) {
        pending.reject(new Error(raw.error.message ?? "Unknown error"));
      } else {
        pending.resolve(raw.result);
      }
      return;
    }

    if (isJsonRpcRequest(raw)) {
      const handler = this.requestHandlers.get(raw.method);
      try {
        const result = handler ? await handler(raw.params) : {};
        this.writeJsonRpcResponse({ id: raw.id, result });
      } catch (error) {
        this.writeJsonRpcResponse({
          id: raw.id,
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }
      return;
    }

    if (isJsonRpcNotification(raw)) {
      this.notificationHandler?.(raw.method, raw.params);
    }
  }
}

function truncateLogLine(line: string): string {
  const maxLength = 500;
  return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line;
}

function isWindowsProcessCleanupLine(line: string): boolean {
  return /^SUCCESS: The process with PID \d+(?: \(child process of PID \d+\))? has been terminated\.$/.test(
    line,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  if (!isRecord(msg)) return false;
  if (typeof msg.id !== "number") return false;
  return Object.prototype.hasOwnProperty.call(msg, "result") || !!msg.error;
}

function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (!isRecord(msg)) return false;
  return typeof msg.id === "number" && typeof msg.method === "string";
}

function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (!isRecord(msg)) return false;
  return typeof msg.method === "string" && typeof msg.id !== "number";
}
