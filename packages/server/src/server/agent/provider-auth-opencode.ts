import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ProviderAuthAdapter,
  ProviderAuthAdapterContext,
  ProviderAuthLaunchContext,
  StoredProviderAuthProfile,
} from "./provider-auth-service.js";
import { createNativeDefaultProviderHomeRef } from "./provider-home-ref.js";
import {
  ensureOpenCodeManagedRoots,
  resolveOpenCodeManagedRoots,
} from "./providers/opencode/managed-roots.js";

const OPENCODE_PROVIDER = "opencode" as const;
const OPENCODE_AUTH_FILENAME = "auth.json";
const OPENCODE_AUTH_BUNDLE_KEY = "opencode-native-auth";

export interface ParsedOpenCodeAuthBundle {
  key: string;
  alias: string;
  accountName: string;
  authMode: StoredProviderAuthProfile["authMode"];
  providerKeys: string[];
  email?: string;
  accountId?: string;
}

export class OpenCodeProviderAuthAdapter implements ProviderAuthAdapter {
  readonly provider = OPENCODE_PROVIDER;
  readonly supportsCurrentAuthSync = true;

  async importCurrent(
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile> {
    const nativeRoots = resolveNativeOpenCodeRoots();
    return this.importAuthFile(
      path.join(nativeRoots.xdgDataHome, "opencode", OPENCODE_AUTH_FILENAME),
      context,
      {
        alias: options?.alias,
      },
    );
  }

  async importAuthFile(
    authFilePath: string,
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile> {
    const nativeRoots = resolveNativeOpenCodeRoots();
    const managedRoots = resolveOpenCodeManagedRoots(
      resolvePaseoHomeFromProviderBaseDir(context.providerBaseDir),
    );
    await ensureOpenCodeManagedRoots({ roots: managedRoots, nativeRoots });

    const resolvedAuthPath = path.resolve(authFilePath);
    const data = await fs.readFile(resolvedAuthPath, "utf8");
    const parsed = parseOpenCodeAuthJson(data);
    const now = context.now().toISOString();

    return {
      provider: OPENCODE_PROVIDER,
      key: parsed.key,
      alias: normalizeAlias(options?.alias) ?? parsed.alias,
      email: parsed.email,
      accountName: parsed.accountName,
      accountId: parsed.accountId,
      authMode: parsed.authMode,
      plan: parsed.providerKeys.join(", "),
      status: "ready",
      createdAt: now,
      updatedAt: now,
      providerHomePath: managedRoots.providerRoot,
      metadata: {
        authFileHash: stableHash(data),
        authProviders: parsed.providerKeys,
      },
    };
  }

  async refreshProfile(
    profile: StoredProviderAuthProfile,
    context: ProviderAuthAdapterContext,
  ): Promise<StoredProviderAuthProfile> {
    const imported = await this.importCurrent(context, { alias: profile.alias });
    return {
      ...profile,
      ...imported,
      key: profile.key,
      createdAt: profile.createdAt,
      lastUsedAt: profile.lastUsedAt,
      updatedAt: context.now().toISOString(),
    };
  }

  resolveLaunchContext(profile: StoredProviderAuthProfile): ProviderAuthLaunchContext {
    const providerHomeRef = createNativeDefaultProviderHomeRef({
      provider: OPENCODE_PROVIDER,
      homePath: profile.providerHomePath,
      label: profile.alias,
      accountFingerprint: profile.accountId ?? profile.email ?? profile.key,
    });
    return {
      profileKey: profile.key,
      providerHomeRef,
      metadata: {
        providerHomeRef,
      },
    };
  }
}

function resolvePaseoHomeFromProviderBaseDir(providerBaseDir: string): string {
  return path.dirname(path.dirname(providerBaseDir));
}

export function parseOpenCodeAuthJson(data: string): ParsedOpenCodeAuthBundle {
  const root = readRecord(JSON.parse(data));
  if (!root) {
    throw new Error("OpenCode auth file must contain a JSON object");
  }
  const providerKeys = Object.keys(root)
    .filter((key) => readRecord(root[key]) !== null)
    .sort();
  if (providerKeys.length === 0) {
    throw new Error("OpenCode auth file does not contain any provider credentials");
  }
  const openai = readRecord(root.openai);
  const openaiAccess = readString(openai?.access);
  const openaiClaims = openaiAccess ? parseJwtPayload(openaiAccess) : null;
  const profileClaims = readRecord(openaiClaims?.["https://api.openai.com/profile"]);
  const authClaims = readRecord(openaiClaims?.["https://api.openai.com/auth"]);
  const email = normalizeEmail(readString(profileClaims?.email));
  const accountId = readString(openai?.accountId) ?? readString(authClaims?.chatgpt_account_id);

  return {
    key: OPENCODE_AUTH_BUNDLE_KEY,
    alias: "OpenCode native auth",
    accountName: providerKeys.join(" · "),
    authMode: "external",
    providerKeys,
    email,
    accountId: accountId ?? undefined,
  };
}

function resolveNativeOpenCodeRoots() {
  return {
    xdgConfigHome: resolveXdgHome("XDG_CONFIG_HOME", ".config"),
    xdgDataHome: resolveXdgHome("XDG_DATA_HOME", path.join(".local", "share")),
    xdgStateHome: resolveXdgHome("XDG_STATE_HOME", path.join(".local", "state")),
  };
}

function resolveXdgHome(
  envKey: "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME",
  fallback: string,
): string {
  const value = process.env[envKey];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return path.join(homedir(), fallback);
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
