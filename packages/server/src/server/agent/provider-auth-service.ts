import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type {
  AgentProvider,
  ProviderAuthProfile,
  ProviderAuthUsageSnapshot,
  ProviderHomeRef,
} from "./agent-sdk-types.js";
import {
  createManagedProviderHomeRef,
  createNativeDefaultProviderHomeRef,
  normalizeProviderHomeRef,
} from "./provider-home-ref.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderRuntimeSettings,
} from "./provider-launch-config.js";

export type ProviderAuthImportSource = "current" | "file";

export interface ProviderAuthImportRequest {
  provider: AgentProvider;
  source: ProviderAuthImportSource;
  path?: string;
  alias?: string;
  setDefault?: boolean;
}

export interface ProviderAuthLaunchSelection {
  provider: AgentProvider;
  providerHomeRef?: ProviderHomeRef | null;
}

export interface ProviderAuthLaunchContext {
  profileKey: string | null;
  providerHomeRef: ProviderHomeRef;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export type ProviderAuthSyncStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "unsupported"
  | "missing-auth"
  | "failed";

export interface ProviderAuthSyncResult {
  provider: AgentProvider;
  status: ProviderAuthSyncStatus;
  profile?: ProviderAuthProfile;
  error?: string;
}

export interface ProviderAuthSyncOptions {
  setDefaultWhenEmpty?: boolean;
}

export interface StoredProviderAuthProfile {
  provider: AgentProvider;
  key: string;
  alias: string;
  email?: string;
  accountName?: string;
  accountId?: string;
  userId?: string;
  authMode: ProviderAuthProfile["authMode"];
  plan?: string;
  status: ProviderAuthProfile["status"];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastRefresh?: string;
  providerHomePath: string;
  usage?: ProviderAuthUsageSnapshot;
  usageRefreshError?: ProviderAuthProfile["usageRefreshError"];
  metadata?: Record<string, unknown>;
}

export interface ProviderAuthAdapterContext {
  providerBaseDir: string;
  now: () => Date;
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

export interface ProviderAuthAdapter {
  readonly provider: AgentProvider;
  readonly supportsCurrentAuthSync?: boolean;
  importCurrent(
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile>;
  importAuthFile(
    authFilePath: string,
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile>;
  refreshProfile(
    profile: StoredProviderAuthProfile,
    context: ProviderAuthAdapterContext,
  ): Promise<StoredProviderAuthProfile>;
  resolveLaunchContext(profile: StoredProviderAuthProfile): ProviderAuthLaunchContext;
}

interface StoredProviderAuthProviderState {
  defaultProfileKey?: string | null;
  autoSelect?: {
    enabled?: boolean;
  };
  profiles?: Record<string, StoredProviderAuthProfile>;
}

interface StoredProviderAuthRegistry {
  schemaVersion: 1;
  providers: Record<AgentProvider, StoredProviderAuthProviderState>;
}

const CURRENT_SCHEMA_VERSION = 1;

export class ProviderAuthService {
  private readonly registryPath: string;
  private readonly baseDir: string;
  private readonly adapters: Map<AgentProvider, ProviderAuthAdapter>;
  private readonly runtimeSettings: AgentProviderRuntimeSettingsMap | undefined;
  private registry: StoredProviderAuthRegistry | null = null;
  private loadPromise: Promise<StoredProviderAuthRegistry> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(options: {
    paseoHome: string;
    logger: Logger;
    adapters: ProviderAuthAdapter[];
    runtimeSettings?: AgentProviderRuntimeSettingsMap;
    now?: () => Date;
  }) {
    this.baseDir = path.join(options.paseoHome, "provider-auth");
    this.registryPath = path.join(this.baseDir, "registry.json");
    this.logger = options.logger.child({ module: "provider-auth" });
    this.now = options.now ?? (() => new Date());
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.provider, adapter]));
    this.runtimeSettings = options.runtimeSettings;
  }

  private readonly logger: Logger;
  private readonly now: () => Date;

  supportsProvider(provider: AgentProvider): boolean {
    return this.adapters.has(provider);
  }

  getSupportedProviders(): AgentProvider[] {
    return Array.from(this.adapters.keys()).sort();
  }

  getNativeDefaultProviderHomeRef(provider: AgentProvider): ProviderHomeRef {
    return createNativeDefaultProviderHomeRef({
      provider,
      homePath: resolveNativeDefaultProviderHomePath(provider),
      label: provider === "codex" ? "Codex CLI default" : "Native default",
    });
  }

  async listProfiles(provider?: AgentProvider): Promise<ProviderAuthProfile[]> {
    const registry = await this.load();
    const providers = provider ? [provider] : Object.keys(registry.providers);
    return providers.flatMap((providerId) => {
      const state = registry.providers[providerId];
      const profiles = Object.values(state?.profiles ?? {});
      return profiles.map((profile) =>
        this.toPublicProfile(profile, state?.defaultProfileKey ?? null),
      );
    });
  }

  async importProfile(request: ProviderAuthImportRequest): Promise<ProviderAuthProfile> {
    const adapter = this.requireAdapter(request.provider);
    const context = this.createAdapterContext(request.provider);
    const imported =
      request.source === "current"
        ? await adapter.importCurrent(context, { alias: request.alias })
        : await adapter.importAuthFile(this.requireImportPath(request), context, {
            alias: request.alias,
          });
    const registry = await this.load();
    const result = await this.upsertImportedProfile(registry, request.provider, imported, {
      preserveExistingAlias: false,
      setDefaultWhenEmpty: request.setDefault !== false,
    });
    return result.profile;
  }

  async syncCurrentProfile(
    provider: AgentProvider,
    options: ProviderAuthSyncOptions = {},
  ): Promise<ProviderAuthSyncResult> {
    const adapter = this.adapters.get(provider);
    if (!adapter || adapter.supportsCurrentAuthSync !== true) {
      return { provider, status: "unsupported" };
    }

    try {
      const imported = await adapter.importCurrent(this.createAdapterContext(provider));
      const registry = await this.load();
      const result = await this.upsertImportedProfile(registry, provider, imported, {
        preserveExistingAlias: true,
        setDefaultWhenEmpty: options.setDefaultWhenEmpty ?? true,
      });
      return {
        provider,
        status: result.status,
        profile: result.profile,
      };
    } catch (error) {
      if (isFileNotFoundError(error)) {
        this.logger.debug({ provider }, "Current provider auth file is not available");
        return { provider, status: "missing-auth" };
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err, provider }, "Failed to sync current provider auth profile");
      return { provider, status: "failed", error: err.message };
    }
  }

  async syncAllCurrentProfiles(
    options: ProviderAuthSyncOptions = {},
  ): Promise<ProviderAuthSyncResult[]> {
    const providers = [...this.adapters.values()]
      .filter((adapter) => adapter.supportsCurrentAuthSync === true)
      .map((adapter) => adapter.provider);

    return Promise.all(providers.map((provider) => this.syncCurrentProfile(provider, options)));
  }

  async removeProfile(provider: AgentProvider, profileKey: string): Promise<void> {
    const registry = await this.load();
    const state = this.getOrCreateProviderState(registry, provider);
    const profile = state.profiles?.[profileKey];
    if (!profile) {
      return;
    }
    state.profiles = { ...state.profiles };
    delete state.profiles[profileKey];
    if (state.defaultProfileKey === profileKey) {
      state.defaultProfileKey = selectReplacementDefaultProfileKey(Object.values(state.profiles));
    }
    await this.save(registry);
    await fs
      .rm(path.dirname(profile.providerHomePath), { recursive: true, force: true })
      .catch((error) => {
        this.logger.warn(
          { err: error, provider, profileKey },
          "Failed to remove auth profile files",
        );
      });
  }

  async setDefaultProfile(
    provider: AgentProvider,
    profileKey: string | null,
  ): Promise<ProviderAuthProfile[]> {
    const registry = await this.load();
    const state = this.getOrCreateProviderState(registry, provider);
    if (profileKey && !state.profiles?.[profileKey]) {
      throw new Error(`Provider auth profile '${profileKey}' was not found for ${provider}`);
    }
    state.defaultProfileKey = profileKey;
    await this.save(registry);
    return Object.values(state.profiles ?? {}).map((profile) =>
      this.toPublicProfile(profile, state.defaultProfileKey ?? null),
    );
  }

  async refreshProfile(provider: AgentProvider, profileKey: string): Promise<ProviderAuthProfile> {
    const adapter = this.requireAdapter(provider);
    const registry = await this.load();
    const state = this.getOrCreateProviderState(registry, provider);
    const existing = state.profiles?.[profileKey];
    if (!existing) {
      throw new Error(`Provider auth profile '${profileKey}' was not found for ${provider}`);
    }
    const refreshed = await adapter.refreshProfile(existing, this.createAdapterContext(provider));
    state.profiles = {
      ...state.profiles,
      [profileKey]: {
        ...existing,
        ...refreshed,
        key: profileKey,
        provider,
        updatedAt: this.now().toISOString(),
      },
    };
    await this.save(registry);
    return this.toPublicProfile(state.profiles[profileKey], state.defaultProfileKey ?? null);
  }

  async resolveLaunchContext(
    selection: ProviderAuthLaunchSelection,
  ): Promise<ProviderAuthLaunchContext> {
    const adapter = this.adapters.get(selection.provider);
    const nativeHomeRef = this.getNativeDefaultProviderHomeRef(selection.provider);
    const requestedHomeRef = normalizeProviderHomeRef(
      selection.providerHomeRef,
      selection.provider,
    );
    if (!adapter) {
      if (requestedHomeRef?.kind === "managed-profile") {
        throw new Error(`Provider '${selection.provider}' does not support auth profiles`);
      }
      return {
        profileKey: null,
        providerHomeRef: nativeHomeRef,
        metadata: {
          providerHomeRef: nativeHomeRef,
        },
      };
    }
    if (requestedHomeRef?.kind === "native-default") {
      return {
        profileKey: null,
        providerHomeRef: requestedHomeRef ?? nativeHomeRef,
        metadata: {
          providerHomeRef: requestedHomeRef ?? nativeHomeRef,
        },
      };
    }
    const registry = await this.load();
    const state = this.getOrCreateProviderState(registry, selection.provider);
    const requestedProfileKey =
      requestedHomeRef?.kind === "managed-profile" ? requestedHomeRef.profileKey : null;
    const selected = this.selectProfileForLaunch(state, requestedProfileKey);
    if (!selected) {
      return {
        profileKey: null,
        providerHomeRef: nativeHomeRef,
        metadata: {
          providerHomeRef: nativeHomeRef,
        },
      };
    }
    selected.lastUsedAt = this.now().toISOString();
    await this.save(registry);
    return adapter.resolveLaunchContext(selected);
  }

  private selectProfileForLaunch(
    state: StoredProviderAuthProviderState,
    requestedProfileKey: string | null | undefined,
  ): StoredProviderAuthProfile | null {
    const profiles = state.profiles ?? {};
    const explicitKey = normalizeProfileKey(requestedProfileKey);
    if (explicitKey) {
      const explicit = profiles[explicitKey];
      if (!explicit) {
        throw new Error(`Provider auth profile '${explicitKey}' was not found`);
      }
      return explicit.status === "ready" ? explicit : null;
    }

    const readyProfiles = Object.values(profiles).filter((profile) => profile.status === "ready");
    if (readyProfiles.length === 0) {
      return null;
    }

    if (state.autoSelect?.enabled) {
      return chooseProfileByUsage(readyProfiles);
    }

    const defaultProfile = state.defaultProfileKey ? profiles[state.defaultProfileKey] : null;
    if (defaultProfile?.status === "ready") {
      return defaultProfile;
    }
    return [...readyProfiles].sort(compareProfileRecency)[0] ?? null;
  }

  private toPublicProfile(
    profile: StoredProviderAuthProfile,
    defaultProfileKey: string | null,
  ): ProviderAuthProfile {
    const providerHomeRef = createManagedProviderHomeRef({
      provider: profile.provider,
      profileKey: profile.key,
      label: profile.email ?? profile.accountName ?? profile.alias,
      accountFingerprint: profile.accountId ?? profile.userId ?? profile.email,
    });
    return {
      provider: profile.provider,
      key: profile.key,
      alias: profile.alias,
      email: profile.email,
      accountName: profile.accountName,
      accountId: profile.accountId,
      userId: profile.userId,
      authMode: profile.authMode,
      plan: profile.plan,
      status: profile.status,
      isDefault: defaultProfileKey === profile.key,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      lastUsedAt: profile.lastUsedAt,
      usage: profile.usage,
      usageRefreshError: profile.usageRefreshError,
      providerHomeRef,
    };
  }

  private createAdapterContext(provider: AgentProvider): ProviderAuthAdapterContext {
    const runtimeSettings = this.runtimeSettings?.[provider];
    return {
      providerBaseDir: path.join(this.baseDir, provider),
      now: this.now,
      logger: this.logger.child({ provider }),
      ...(runtimeSettings ? { runtimeSettings } : {}),
    };
  }

  private requireAdapter(provider: AgentProvider): ProviderAuthAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Provider '${provider}' does not support auth profiles`);
    }
    return adapter;
  }

  private requireImportPath(request: ProviderAuthImportRequest): string {
    const raw = request.path?.trim();
    if (!raw) {
      throw new Error("Import path is required");
    }
    return raw;
  }

  private getOrCreateProviderState(
    registry: StoredProviderAuthRegistry,
    provider: AgentProvider,
  ): StoredProviderAuthProviderState {
    registry.providers[provider] ??= {};
    registry.providers[provider].profiles ??= {};
    return registry.providers[provider];
  }

  private async upsertImportedProfile(
    registry: StoredProviderAuthRegistry,
    provider: AgentProvider,
    imported: StoredProviderAuthProfile,
    options: {
      preserveExistingAlias: boolean;
      setDefaultWhenEmpty: boolean;
    },
  ): Promise<{
    profile: ProviderAuthProfile;
    status: Extract<ProviderAuthSyncStatus, "created" | "updated" | "unchanged">;
  }> {
    const state = this.getOrCreateProviderState(registry, provider);
    const previous = state.profiles?.[imported.key];
    const profile: StoredProviderAuthProfile = {
      ...imported,
      alias: options.preserveExistingAlias && previous?.alias ? previous.alias : imported.alias,
      createdAt: previous?.createdAt ?? imported.createdAt,
      updatedAt: this.now().toISOString(),
      lastUsedAt: previous?.lastUsedAt ?? imported.lastUsedAt,
      metadata: mergeProfileMetadata(previous, imported, options.preserveExistingAlias),
    };
    let status: Extract<ProviderAuthSyncStatus, "created" | "updated" | "unchanged">;
    if (!previous) {
      status = "created";
    } else if (hasStoredProfileChanged(previous, profile)) {
      status = "updated";
    } else {
      status = "unchanged";
    }
    const shouldSetDefault = options.setDefaultWhenEmpty && !state.defaultProfileKey;

    if (status !== "unchanged" || shouldSetDefault) {
      state.profiles = {
        ...state.profiles,
        [profile.key]: status === "unchanged" && previous ? previous : profile,
      };
      if (shouldSetDefault) {
        state.defaultProfileKey = profile.key;
      }
      await this.save(registry);
    }

    const stored = state.profiles?.[profile.key] ?? profile;
    return {
      profile: this.toPublicProfile(stored, state.defaultProfileKey ?? null),
      status,
    };
  }

  private async load(): Promise<StoredProviderAuthRegistry> {
    if (this.registry) {
      return this.registry;
    }
    this.loadPromise ??= this.readRegistry();
    this.registry = await this.loadPromise;
    return this.registry;
  }

  private async readRegistry(): Promise<StoredProviderAuthRegistry> {
    await fs.mkdir(this.baseDir, { recursive: true });
    try {
      const data = await fs.readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(data) as Partial<StoredProviderAuthRegistry>;
      return normalizeRegistry(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyRegistry();
      }
      this.logger.warn({ err: error }, "Failed to read provider auth registry; starting empty");
      return emptyRegistry();
    }
  }

  private async save(registry: StoredProviderAuthRegistry): Promise<void> {
    this.registry = registry;
    const payload = `${JSON.stringify(registry, null, 2)}\n`;
    const nextWrite = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
        await writeFileAtomically(this.registryPath, payload);
        return undefined;
      });
    this.pendingWrite = nextWrite;
    await nextWrite;
  }
}

function emptyRegistry(): StoredProviderAuthRegistry {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    providers: {},
  };
}

function normalizeRegistry(input: Partial<StoredProviderAuthRegistry>): StoredProviderAuthRegistry {
  const registry = emptyRegistry();
  const providers = input.providers && typeof input.providers === "object" ? input.providers : {};
  for (const [provider, state] of Object.entries(providers)) {
    if (!state || typeof state !== "object") {
      continue;
    }
    const profiles: Record<string, StoredProviderAuthProfile> = {};
    const rawProfiles = state.profiles && typeof state.profiles === "object" ? state.profiles : {};
    for (const [key, profile] of Object.entries(rawProfiles)) {
      if (!profile || typeof profile !== "object") {
        continue;
      }
      profiles[key] = profile as StoredProviderAuthProfile;
    }
    registry.providers[provider] = {
      defaultProfileKey:
        typeof state.defaultProfileKey === "string" || state.defaultProfileKey === null
          ? state.defaultProfileKey
          : undefined,
      autoSelect: {
        enabled: state.autoSelect?.enabled === true,
      },
      profiles,
    };
  }
  return registry;
}

function normalizeProfileKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveNativeDefaultProviderHomePath(provider: AgentProvider): string | null {
  if (provider === "codex") {
    return path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
  }
  return null;
}

function mergeProfileMetadata(
  previous: StoredProviderAuthProfile | undefined,
  imported: StoredProviderAuthProfile,
  preserveExisting: boolean,
): Record<string, unknown> | undefined {
  const previousMetadata = preserveExisting ? previous?.metadata : undefined;
  const importedMetadata = imported.metadata;
  if (!previousMetadata && !importedMetadata) {
    return undefined;
  }
  return {
    ...previousMetadata,
    ...importedMetadata,
  };
}

function hasStoredProfileChanged(
  previous: StoredProviderAuthProfile,
  next: StoredProviderAuthProfile,
): boolean {
  return (
    JSON.stringify(toComparableProfile(previous)) !== JSON.stringify(toComparableProfile(next))
  );
}

function toComparableProfile(profile: StoredProviderAuthProfile) {
  return {
    provider: profile.provider,
    key: profile.key,
    alias: profile.alias,
    email: profile.email,
    accountName: profile.accountName,
    accountId: profile.accountId,
    userId: profile.userId,
    authMode: profile.authMode,
    plan: profile.plan,
    status: profile.status,
    lastRefresh: profile.lastRefresh,
    providerHomePath: profile.providerHomePath,
    usage: profile.usage ? toComparableUsage(profile.usage) : undefined,
    usageRefreshError: profile.usageRefreshError,
    metadata: profile.metadata,
  };
}

function toComparableUsage(usage: ProviderAuthUsageSnapshot) {
  return {
    source: usage.source,
    primaryUsedPercent: usage.primaryUsedPercent,
    primaryWindowMinutes: usage.primaryWindowMinutes,
    primaryResetsAt: usage.primaryResetsAt,
    secondaryUsedPercent: usage.secondaryUsedPercent,
    secondaryWindowMinutes: usage.secondaryWindowMinutes,
    secondaryResetsAt: usage.secondaryResetsAt,
    creditsRemaining: usage.creditsRemaining,
    limitState: usage.limitState,
  };
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function chooseProfileByUsage(profiles: StoredProviderAuthProfile[]): StoredProviderAuthProfile {
  return [...profiles].sort((left, right) => {
    const rightScore = usageScore(right);
    const leftScore = usageScore(left);
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }
    return compareProfileRecency(left, right);
  })[0];
}

function selectReplacementDefaultProfileKey(profiles: StoredProviderAuthProfile[]): string | null {
  const readyProfiles = profiles.filter((profile) => profile.status === "ready");
  if (readyProfiles.length > 0) {
    return chooseProfileByUsage(readyProfiles).key;
  }
  return [...profiles].sort(compareProfileRecency)[0]?.key ?? null;
}

function usageScore(profile: StoredProviderAuthProfile): number {
  const primary = profile.usage?.primaryUsedPercent;
  const secondary = profile.usage?.secondaryUsedPercent;
  const used = Math.max(
    typeof primary === "number" ? primary : -1,
    typeof secondary === "number" ? secondary : -1,
  );
  if (used < 0) {
    return 0;
  }
  return 100 - used;
}

function compareProfileRecency(
  left: StoredProviderAuthProfile,
  right: StoredProviderAuthProfile,
): number {
  const leftTime = Date.parse(left.lastUsedAt ?? left.updatedAt ?? left.createdAt);
  const rightTime = Date.parse(right.lastUsedAt ?? right.updatedAt ?? right.createdAt);
  return rightTime - leftTime;
}

async function writeFileAtomically(targetPath: string, payload: string) {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(
    directory,
    `.provider-auth.tmp-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, targetPath);
}
