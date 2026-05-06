import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ProviderAuthUsageSnapshot } from "./agent-sdk-types.js";
import type {
  ProviderAuthAdapter,
  ProviderAuthAdapterContext,
  ProviderAuthLaunchContext,
  StoredProviderAuthProfile,
} from "./provider-auth-service.js";

const CODEX_PROVIDER = "codex" as const;
const CODEX_AUTH_FILENAME = "auth.json";
const CODEX_CONFIG_FILENAME = "config.toml";
const MAX_USAGE_SCAN_FILES = 40;

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

    const usage = await scanLatestUsage(profileCodexHome).catch((error) => {
      context.logger.debug({ err: error, profileKey: parsed.key }, "Failed to scan Codex usage");
      return undefined;
    });

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
      usage,
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
    const usage = await scanLatestUsage(profile.providerHomePath).catch((error) => {
      context.logger.debug({ err: error, profileKey: profile.key }, "Failed to scan Codex usage");
      return undefined;
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
      usage,
      metadata: {
        ...profile.metadata,
        authFileHash: stableHash(data),
      },
    };
  }

  resolveLaunchContext(profile: StoredProviderAuthProfile): ProviderAuthLaunchContext {
    return {
      profileKey: profile.key,
      env: {
        CODEX_HOME: profile.providerHomePath,
      },
      metadata: {
        authProfileKey: profile.key,
      },
    };
  }
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

async function scanLatestUsage(codexHome: string): Promise<ProviderAuthUsageSnapshot | undefined> {
  const sessionsDir = path.join(codexHome, "sessions");
  const files = await collectJsonlFiles(sessionsDir);
  for (const filePath of files) {
    const snapshot = await scanUsageFile(filePath);
    if (snapshot) {
      return snapshot;
    }
  }
  return undefined;
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const entries: Array<{ path: string; mtimeMs: number }> = [];
  await collectJsonlFilesInto(root, entries);
  return [...entries]
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_USAGE_SCAN_FILES)
    .map((entry) => entry.path);
}

async function collectJsonlFilesInto(
  dirPath: string,
  entries: Array<{ path: string; mtimeMs: number }>,
): Promise<void> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    dirents.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await collectJsonlFilesInto(fullPath, entries);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        return;
      }
      const stat = await fs.stat(fullPath);
      entries.push({ path: fullPath, mtimeMs: stat.mtimeMs });
    }),
  );
}

async function scanUsageFile(filePath: string): Promise<ProviderAuthUsageSnapshot | undefined> {
  const text = await fs.readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes("rate_limits")) {
      continue;
    }
    const snapshot = parseUsageLine(line);
    if (snapshot) {
      return snapshot;
    }
  }
  return undefined;
}

function parseUsageLine(line: string): ProviderAuthUsageSnapshot | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const payload = readRecord(parsed.payload);
    const rateLimits = readRecord(payload?.rate_limits) ?? readRecord(payload?.rateLimits);
    if (!rateLimits) {
      return undefined;
    }
    const primary = readRecord(rateLimits.primary);
    const secondary = readRecord(rateLimits.secondary);
    const credits = readRecord(rateLimits.credits);
    return {
      source: "local-rollout",
      primaryUsedPercent: readNumber(primary?.used_percent) ?? readNumber(primary?.usedPercent),
      secondaryUsedPercent:
        readNumber(secondary?.used_percent) ?? readNumber(secondary?.usedPercent),
      creditsRemaining: readNumber(credits?.remaining),
      refreshedAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
