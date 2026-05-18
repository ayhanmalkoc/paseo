import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ProviderAuthAdapter,
  ProviderAuthAdapterContext,
  ProviderAuthLaunchContext,
  StoredProviderAuthProfile,
} from "./provider-auth-service.js";
import { getProviderAccountHomePath, getProviderAccountRoot } from "./provider-layout.js";
import { createManagedProviderHomeRef } from "./provider-home-ref.js";

const GEMINI_PROVIDER = "gemini" as const;
const GEMINI_HOME_DIR = ".gemini";
const GOOGLE_ACCOUNTS_FILENAME = "google_accounts.json";
const OAUTH_CREDS_FILENAME = "oauth_creds.json";

interface GeminiNativeIdentity {
  key: string;
  alias: string;
  authMode: StoredProviderAuthProfile["authMode"];
  email?: string;
  accountName?: string;
  accountId?: string;
  userId?: string;
}

export class GeminiProviderAuthAdapter implements ProviderAuthAdapter {
  readonly provider = GEMINI_PROVIDER;
  readonly supportsCurrentAuthSync = true;

  async importCurrent(
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile> {
    return this.importAuthFile(resolveNativeGeminiStateDir(), context, options);
  }

  async importAuthFile(
    authFilePath: string,
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile> {
    const sourceStateDir = await resolveGeminiStateDir(authFilePath);
    const identity = await readGeminiIdentity(sourceStateDir, options?.alias);
    const now = context.now().toISOString();
    const providerRoot = context.providerBaseDir;
    const profileRoot = getProviderAccountRoot(providerRoot, identity);
    const providerHomePath = getProviderAccountHomePath(providerRoot, identity);
    const targetStateDir = path.join(providerHomePath, GEMINI_HOME_DIR);
    const extensionEnablement = await readGeminiExtensionEnablement(targetStateDir);

    await fs.rm(targetStateDir, { recursive: true, force: true });
    await fs.mkdir(targetStateDir, { recursive: true, mode: 0o700 });
    await copyGeminiStateDir(sourceStateDir, targetStateDir);
    await restoreGeminiExtensionEnablement(targetStateDir, extensionEnablement);
    await writeAccountMetadata(profileRoot, {
      provider: GEMINI_PROVIDER,
      key: identity.key,
      alias: identity.alias,
      email: identity.email,
      accountName: identity.accountName,
      accountId: identity.accountId,
      userId: identity.userId,
      authMode: identity.authMode,
      updatedAt: now,
    });

    return {
      provider: GEMINI_PROVIDER,
      key: identity.key,
      alias: identity.alias,
      email: identity.email,
      accountName: identity.accountName,
      accountId: identity.accountId,
      userId: identity.userId,
      authMode: identity.authMode,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      lastRefresh: now,
      providerHomePath,
      metadata: {
        stateDirHash: await hashDirectoryFiles(targetStateDir),
      },
    };
  }

  async refreshProfile(
    profile: StoredProviderAuthProfile,
    context: ProviderAuthAdapterContext,
  ): Promise<StoredProviderAuthProfile> {
    const stateDir = path.join(profile.providerHomePath, GEMINI_HOME_DIR);
    await fs.access(stateDir);
    const identity = await readGeminiIdentity(stateDir, profile.alias);
    const now = context.now().toISOString();
    return {
      ...profile,
      alias: profile.alias,
      email: identity.email,
      accountName: identity.accountName,
      accountId: identity.accountId,
      userId: identity.userId,
      authMode: identity.authMode,
      status: "ready",
      updatedAt: now,
      lastRefresh: now,
      metadata: {
        ...profile.metadata,
        stateDirHash: await hashDirectoryFiles(stateDir),
      },
    };
  }

  resolveLaunchContext(profile: StoredProviderAuthProfile): ProviderAuthLaunchContext {
    const providerHomeRef = createManagedProviderHomeRef({
      provider: GEMINI_PROVIDER,
      profileKey: profile.key,
      homePath: profile.providerHomePath,
      label: profile.email ?? profile.accountName ?? profile.alias,
      accountFingerprint: profile.accountId ?? profile.userId ?? profile.email,
    });
    return {
      profileKey: profile.key,
      providerHomeRef,
      env: {
        GEMINI_CLI_HOME: profile.providerHomePath,
      },
      metadata: {
        providerHomeRef,
      },
    };
  }
}

async function resolveGeminiStateDir(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  const stats = await fs.stat(resolved).catch(() => null);
  if (!stats) {
    throw new Error(`Gemini auth path not found: ${resolved}`);
  }
  if (stats.isDirectory()) {
    if (path.basename(resolved) === GEMINI_HOME_DIR) {
      return resolved;
    }
    const nestedStateDir = path.join(resolved, GEMINI_HOME_DIR);
    if (existsSync(nestedStateDir)) {
      return nestedStateDir;
    }
    throw new Error(`Gemini auth path must be a Gemini home root or ${GEMINI_HOME_DIR} directory`);
  }
  const parentDir = path.dirname(resolved);
  if (path.basename(parentDir) === GEMINI_HOME_DIR) {
    return parentDir;
  }
  throw new Error(`Gemini auth file must live inside a ${GEMINI_HOME_DIR} directory`);
}

function resolveNativeGeminiStateDir(): string {
  const root = process.env.GEMINI_CLI_HOME?.trim() || homedir();
  return path.join(path.resolve(root), GEMINI_HOME_DIR);
}

async function readGeminiIdentity(
  sourceStateDir: string,
  requestedAlias?: string,
): Promise<GeminiNativeIdentity> {
  const accounts = await readGoogleAccounts(sourceStateDir);
  const oauth = await readOauthCredentials(sourceStateDir);
  const email = normalizeEmail(accounts.email ?? oauth.email);
  const accountName = email ?? accounts.accountName ?? "Gemini native account";
  const keySeed = email ?? accounts.accountId ?? oauth.userId ?? accountName;
  const key = `gemini-${stableHash(keySeed)}`;
  const alias = normalizeAlias(requestedAlias) ?? normalizeAlias(email?.split("@")[0]) ?? "Gemini";
  return {
    key,
    alias,
    email,
    accountName,
    accountId: accounts.accountId,
    userId: oauth.userId,
    authMode: oauth.hasOauth || email ? "oauth" : "external",
  };
}

async function readGoogleAccounts(
  sourceStateDir: string,
): Promise<{ email?: string; accountName?: string; accountId?: string }> {
  const value = await readJsonRecord(path.join(sourceStateDir, GOOGLE_ACCOUNTS_FILENAME));
  const active = value?.active;
  const activeRecord = readRecord(active);
  const activeString = readString(active);
  const email = normalizeEmail(
    activeString ?? readString(activeRecord?.email) ?? readString(activeRecord?.name),
  );
  return {
    email,
    accountName: email ?? readString(activeRecord?.name) ?? undefined,
    accountId: readString(activeRecord?.id) ?? readString(activeRecord?.accountId) ?? undefined,
  };
}

async function readOauthCredentials(
  sourceStateDir: string,
): Promise<{ email?: string; userId?: string; hasOauth: boolean }> {
  const value = await readJsonRecord(path.join(sourceStateDir, OAUTH_CREDS_FILENAME));
  const idToken = readString(value?.id_token) ?? readString(value?.idToken);
  const payload = idToken ? parseJwtPayload(idToken) : {};
  return {
    email: normalizeEmail(readString(payload.email)),
    userId: readString(payload.sub) ?? undefined,
    hasOauth: Boolean(value),
  };
}

async function copyGeminiStateDir(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipGeminiStateEntry(entry.name)) {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
      await copyGeminiStateDir(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    await fs.copyFile(sourcePath, targetPath);
    if (process.platform !== "win32") {
      await fs.chmod(targetPath, 0o600).catch(() => undefined);
    }
  }
}

function shouldSkipGeminiStateEntry(name: string): boolean {
  return (
    name.endsWith(".lock") ||
    name.endsWith(".tmp") ||
    name.endsWith(".bak") ||
    name === "logs" ||
    name === "tmp"
  );
}

async function readGeminiExtensionEnablement(stateDir: string): Promise<string | null> {
  const filePath = path.join(stateDir, "extensions", "extension-enablement.json");
  return fs.readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
}

async function restoreGeminiExtensionEnablement(
  stateDir: string,
  content: string | null,
): Promise<void> {
  if (!content) {
    return;
  }
  const filePath = path.join(stateDir, "extensions", "extension-enablement.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, content, { mode: 0o600 });
}

async function hashDirectoryFiles(root: string): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  for (const file of files.sort()) {
    hash.update(path.relative(root, file));
    hash.update(await fs.readFile(file));
  }
  return hash.digest("hex").slice(0, 16);
}

async function writeAccountMetadata(
  profileRoot: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(profileRoot, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(stripUndefined(metadata), null, 2)}\n`;
  await fs.writeFile(path.join(profileRoot, "metadata.json"), payload, "utf8");
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!raw) {
    return null;
  }
  try {
    return readRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) {
    return {};
  }
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return readRecord(JSON.parse(Buffer.from(padded, "base64").toString("utf8"))) ?? {};
  } catch {
    return {};
  }
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function normalizeAlias(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
