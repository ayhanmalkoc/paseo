import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import type { ProviderAuthUsageSnapshot } from "../agent-sdk-types.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { findExecutable } from "../../../utils/executable.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { CodexAppServerJsonRpcClient } from "./codex-app-server-json-rpc.js";
import { buildCodexAppServerInitializeParams } from "./codex-app-server-protocol.js";

const CODEX_APP_SERVER_USAGE_TIMEOUT_MS = 12_000;

export interface ReadCodexAppServerUsageOptions {
  codexHome: string;
  runtimeSettings?: ProviderRuntimeSettings;
  logger: Logger;
  now: () => Date;
}

export async function readCodexAppServerUsage(
  options: ReadCodexAppServerUsageOptions,
): Promise<ProviderAuthUsageSnapshot | undefined> {
  const launchPrefix = await resolveProviderCommandPrefix(
    options.runtimeSettings?.command,
    resolveCodexBinary,
  );
  const child = spawnProcess(launchPrefix.command, [...launchPrefix.args, "app-server"], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    ...createProviderEnvSpec({
      overlays: [{ CODEX_HOME: options.codexHome }],
      ...(options.runtimeSettings ? { runtimeSettings: options.runtimeSettings } : {}),
    }),
  });
  assertChildWithPipes(child);

  const client = new CodexAppServerJsonRpcClient(
    child,
    options.logger.child({ module: "codex-app-server-usage" }),
  );
  try {
    await client.request(
      "initialize",
      buildCodexAppServerInitializeParams(),
      CODEX_APP_SERVER_USAGE_TIMEOUT_MS,
    );
    const response = await client.request(
      "account/rateLimits/read",
      undefined,
      CODEX_APP_SERVER_USAGE_TIMEOUT_MS,
    );
    return parseCodexAppServerUsageResponse(response, options.now);
  } finally {
    await client.dispose();
  }
}

async function resolveCodexBinary(): Promise<string> {
  const found = await findExecutable("codex");
  if (found) {
    return found;
  }
  throw new Error(
    "Codex binary not found. Install the Codex CLI (https://github.com/openai/codex) and ensure it is available in your shell PATH.",
  );
}

function assertChildWithPipes(
  child: ChildProcess,
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Child process did not expose stdio pipes");
  }
}

export function parseCodexAppServerUsageResponse(
  response: unknown,
  now: () => Date,
): ProviderAuthUsageSnapshot | undefined {
  const record = readRecord(response);
  const rateLimitsByLimitId = readRecord(record?.rateLimitsByLimitId);
  const codexRateLimits = readRecord(rateLimitsByLimitId?.codex);
  const fallbackRateLimits =
    codexRateLimits ??
    firstRateLimitsByLimitId(rateLimitsByLimitId) ??
    readRecord(record?.rateLimits);
  if (!fallbackRateLimits) {
    return undefined;
  }
  return mapRateLimitSnapshot(fallbackRateLimits, now);
}

function firstRateLimitsByLimitId(
  rateLimitsByLimitId: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!rateLimitsByLimitId) {
    return undefined;
  }
  for (const value of Object.values(rateLimitsByLimitId)) {
    const record = readRecord(value);
    if (record) {
      return record;
    }
  }
  return undefined;
}

function mapRateLimitSnapshot(
  rateLimits: Record<string, unknown>,
  now: () => Date,
): ProviderAuthUsageSnapshot | undefined {
  const primary = readRateLimitWindow(rateLimits.primary);
  const secondary = readRateLimitWindow(rateLimits.secondary);
  const credits = readRecord(rateLimits.credits);
  const rateLimitReachedType = rateLimits.rateLimitReachedType;
  const snapshot: ProviderAuthUsageSnapshot = {
    source: "provider-api",
    primaryUsedPercent: primary.usedPercent,
    primaryWindowMinutes: primary.windowMinutes,
    primaryResetsAt: primary.resetsAt,
    secondaryUsedPercent: secondary.usedPercent,
    secondaryWindowMinutes: secondary.windowMinutes,
    secondaryResetsAt: secondary.resetsAt,
    creditsRemaining: readNumber(credits?.balance),
    limitState: resolveLimitState(primary.usedPercent, secondary.usedPercent, rateLimitReachedType),
    refreshedAt: now().toISOString(),
  };
  return hasUsageFields(snapshot) ? snapshot : undefined;
}

function readRateLimitWindow(value: unknown): {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string;
} {
  const record = readRecord(value);
  return {
    usedPercent: readNumber(record?.usedPercent),
    windowMinutes: readNumber(record?.windowDurationMins),
    resetsAt: readResetTimestamp(record?.resetsAt),
  };
}

function readResetTimestamp(value: unknown): string | undefined {
  const number = readNumber(value);
  if (number !== undefined && number > 0) {
    return epochTimestampToIso(number);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return epochTimestampToIso(numericValue);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function epochTimestampToIso(value: number): string | undefined {
  const timestamp = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function resolveLimitState(
  primaryUsedPercent: number | undefined,
  secondaryUsedPercent: number | undefined,
  rateLimitReachedType: unknown,
): ProviderAuthUsageSnapshot["limitState"] | undefined {
  if (typeof rateLimitReachedType === "string" && rateLimitReachedType.length > 0) {
    return "limited";
  }
  const usedPercents = [primaryUsedPercent, secondaryUsedPercent].filter(
    (value): value is number => typeof value === "number",
  );
  if (usedPercents.length === 0) {
    return undefined;
  }
  const usedPercent = Math.max(...usedPercents);
  if (usedPercent >= 100) {
    return "limited";
  }
  if (usedPercent >= 85) {
    return "near-limit";
  }
  return "ok";
}

function hasUsageFields(snapshot: ProviderAuthUsageSnapshot): boolean {
  return (
    snapshot.primaryUsedPercent !== undefined ||
    snapshot.primaryWindowMinutes !== undefined ||
    snapshot.primaryResetsAt !== undefined ||
    snapshot.secondaryUsedPercent !== undefined ||
    snapshot.secondaryWindowMinutes !== undefined ||
    snapshot.secondaryResetsAt !== undefined ||
    snapshot.creditsRemaining !== undefined ||
    snapshot.limitState !== undefined
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
