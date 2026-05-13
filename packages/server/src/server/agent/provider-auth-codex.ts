import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ProviderAuthUsageRefreshError,
  ProviderAuthUsageSnapshot,
} from "./agent-sdk-types.js";
import type {
  ProviderAuthAdapter,
  ProviderAuthAdapterContext,
  ProviderAuthLaunchContext,
  StoredProviderAuthProfile,
} from "./provider-auth-service.js";
import { createManagedProviderHomeRef } from "./provider-home-ref.js";
import {
  readCodexAppServerUsage,
  type ReadCodexAppServerUsageOptions,
} from "./providers/codex-app-server-usage.js";

const CODEX_PROVIDER = "codex" as const;
const CODEX_AUTH_FILENAME = "auth.json";
const CODEX_CONFIG_FILENAME = "config.toml";

type CodexUsageReader = (
  options: ReadCodexAppServerUsageOptions,
) => Promise<ProviderAuthUsageSnapshot | undefined>;

interface CodexUsageReadResult {
  usage?: ProviderAuthUsageSnapshot;
  usageRefreshError?: ProviderAuthUsageRefreshError;
}

export interface ParsedCodexAuth {
  key: string;
  alias: string;
  email?: string;
  accountId?: string;
  userId?: string;
  authMode: StoredProviderAuthProfile["authMode"];
  plan?: string;
  lastRefresh?: string;
}

export class CodexProviderAuthAdapter implements ProviderAuthAdapter {
  readonly provider = CODEX_PROVIDER;
  readonly supportsCurrentAuthSync = true;

  private readonly usageReader: CodexUsageReader;

  constructor(options: { usageReader?: CodexUsageReader } = {}) {
    this.usageReader = options.usageReader ?? readCodexAppServerUsage;
  }

  async importCurrent(
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile> {
    const codexHome = resolveDefaultCodexHome();
    return this.importAuthFile(path.join(codexHome, CODEX_AUTH_FILENAME), context, {
      alias: options?.alias,
    });
  }

  async importAuthFile(
    authFilePath: string,
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile> {
    const resolvedAuthPath = path.resolve(authFilePath);
    const data = await fs.readFile(resolvedAuthPath, "utf8");
    const parsed = parseCodexAuthJson(data);
    const authFileHash = stableHash(data);
    const now = context.now().toISOString();
    const profileRoot = path.join(context.providerBaseDir, "profiles", parsed.key);
    const profileCodexHome = path.join(profileRoot, "codex-home");

    await fs.mkdir(profileCodexHome, { recursive: true });
    await copySensitiveFile(resolvedAuthPath, path.join(profileCodexHome, CODEX_AUTH_FILENAME));
    await copyOptionalCodexConfig(path.dirname(resolvedAuthPath), profileCodexHome);

    return {
      provider: CODEX_PROVIDER,
      key: parsed.key,
      alias: normalizeAlias(options?.alias) ?? parsed.alias,
      email: parsed.email,
      accountId: parsed.accountId,
      userId: parsed.userId,
      authMode: parsed.authMode,
      plan: parsed.plan,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      lastRefresh: parsed.lastRefresh,
      providerHomePath: profileCodexHome,
      metadata: {
        authFileHash,
      },
    };
  }

  async refreshProfile(
    profile: StoredProviderAuthProfile,
    context: ProviderAuthAdapterContext,
  ): Promise<StoredProviderAuthProfile> {
    const authPath = path.join(profile.providerHomePath, CODEX_AUTH_FILENAME);
    const data = await fs.readFile(authPath, "utf8");
    const parsed = parseCodexAuthJson(data);
    const usageResult = await this.readUsage(profile.providerHomePath, context, profile.key, {
      previousUsage: profile.usage,
    });
    return {
      ...profile,
      alias: profile.alias || parsed.alias,
      email: parsed.email,
      accountId: parsed.accountId,
      userId: parsed.userId,
      authMode: parsed.authMode,
      plan: parsed.plan,
      status: "ready",
      lastRefresh: parsed.lastRefresh,
      usage: usageResult.usage,
      usageRefreshError: usageResult.usageRefreshError,
      metadata: {
        ...profile.metadata,
        authFileHash: stableHash(data),
      },
    };
  }

  resolveLaunchContext(profile: StoredProviderAuthProfile): ProviderAuthLaunchContext {
    const providerHomeRef = createManagedProviderHomeRef({
      provider: profile.provider,
      profileKey: profile.key,
      label: profile.email ?? profile.accountName ?? profile.alias,
      accountFingerprint: profile.accountId ?? profile.userId ?? profile.email,
    });
    return {
      profileKey: profile.key,
      providerHomeRef,
      env: {
        CODEX_HOME: profile.providerHomePath,
      },
      metadata: {
        providerHomeRef,
      },
    };
  }

  private async readUsage(
    codexHome: string,
    context: ProviderAuthAdapterContext,
    profileKey: string,
    options: { previousUsage?: ProviderAuthUsageSnapshot },
  ): Promise<CodexUsageReadResult> {
    let usageRefreshError: ProviderAuthUsageRefreshError | undefined;
    const providerUsage = await this.usageReader({
      codexHome,
      logger: context.logger,
      now: context.now,
      ...(context.runtimeSettings ? { runtimeSettings: context.runtimeSettings } : {}),
    }).catch((error) => {
      usageRefreshError = toUsageRefreshError(error, context.now().toISOString());
      context.logger.debug(
        { err: error, profileKey },
        "Failed to refresh Codex usage from app-server",
      );
      return undefined;
    });
    if (providerUsage) {
      return { usage: providerUsage };
    }
    return {
      usage: options.previousUsage,
      ...(usageRefreshError ? { usageRefreshError } : {}),
    };
  }
}

function toUsageRefreshError(error: unknown, occurredAt: string): ProviderAuthUsageRefreshError {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const code = classifyUsageRefreshError(rawMessage);
  return {
    source: "provider-api",
    code,
    message: normalizeUsageRefreshMessage(code, rawMessage),
    occurredAt,
  };
}

function classifyUsageRefreshError(message: string): ProviderAuthUsageRefreshError["code"] {
  if (/token.*invalidated|401\\s+Unauthorized|Unauthorized/i.test(message)) {
    return "auth-invalid";
  }
  if (/timed out|ECONN|ENOTFOUND|fetch failed|network/i.test(message)) {
    return "provider-unavailable";
  }
  return "unknown";
}

function normalizeUsageRefreshMessage(
  code: ProviderAuthUsageRefreshError["code"],
  message: string,
): string {
  if (code === "auth-invalid") {
    return "Codex account needs sign-in again.";
  }
  if (code === "provider-unavailable") {
    return "Codex usage service is temporarily unavailable.";
  }
  return message || "Codex usage refresh failed.";
}

export function parseCodexAuthJson(data: string): ParsedCodexAuth {
  const root = JSON.parse(data) as Record<string, unknown>;
  const apiKey = typeof root.OPENAI_API_KEY === "string" ? root.OPENAI_API_KEY.trim() : "";
  if (apiKey.length > 0) {
    return parseCodexApiKeyAuth(apiKey);
  }

  const tokens = readRecord(root.tokens);
  const idToken = readString(tokens?.id_token);
  const tokenAccountId = readString(tokens?.account_id);
  const lastRefresh = readString(root.last_refresh);
  if (!idToken) {
    return parseCodexUnknownAuth(data, lastRefresh);
  }

  return parseCodexTokenAuth({ data, idToken, tokenAccountId, lastRefresh });
}

function parseCodexApiKeyAuth(apiKey: string): ParsedCodexAuth {
  return {
    key: `codex-api-${stableHash(apiKey)}`,
    alias: "Codex API key",
    authMode: "api-key",
  };
}

function parseCodexUnknownAuth(data: string, lastRefresh: string | null): ParsedCodexAuth {
  return {
    key: `codex-unknown-${stableHash(data)}`,
    alias: "Codex account",
    authMode: "unknown",
    lastRefresh: lastRefresh ?? undefined,
  };
}

function parseCodexTokenAuth(input: {
  data: string;
  idToken: string;
  tokenAccountId: string | null;
  lastRefresh: string | null;
}): ParsedCodexAuth {
  const payload = parseJwtPayload(input.idToken);
  const authClaims = readRecord(payload["https://api.openai.com/auth"]);
  const email = normalizeEmail(readString(payload.email));
  const jwtAccountId = readString(authClaims?.chatgpt_account_id);
  const accountId = input.tokenAccountId ?? jwtAccountId;
  if (input.tokenAccountId && jwtAccountId && input.tokenAccountId !== jwtAccountId) {
    throw new Error("Codex auth account id mismatch");
  }
  const userId = readString(authClaims?.chatgpt_user_id) ?? readString(authClaims?.user_id);
  const plan = readString(authClaims?.chatgpt_plan_type);
  const keyBasis =
    userId && accountId ? `${userId}::${accountId}` : `${email ?? ""}::${input.data}`;
  const alias = email ? email.split("@")[0] : "Codex account";

  return {
    key: `codex-${stableHash(keyBasis)}`,
    alias,
    email,
    accountId: accountId ?? undefined,
    userId: userId ?? undefined,
    authMode: "chatgpt",
    plan: plan ?? undefined,
    lastRefresh: input.lastRefresh ?? undefined,
  };
}

function resolveDefaultCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function normalizeAlias(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value: string | null): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) {
    return {};
  }
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return readRecord(JSON.parse(Buffer.from(padded, "base64").toString("utf8"))) ?? {};
}

async function copySensitiveFile(sourcePath: string, targetPath: string): Promise<void> {
  await fs.copyFile(sourcePath, targetPath);
  if (process.platform !== "win32") {
    await fs.chmod(targetPath, 0o600).catch(() => undefined);
  }
}

async function copyOptionalCodexConfig(sourceDir: string, targetDir: string): Promise<void> {
  const sourceConfig = path.join(sourceDir, CODEX_CONFIG_FILENAME);
  const targetConfig = path.join(targetDir, CODEX_CONFIG_FILENAME);
  await fs.copyFile(sourceConfig, targetConfig).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}
