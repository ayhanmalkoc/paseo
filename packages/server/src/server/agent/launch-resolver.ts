import type {
  AgentLaunchContext,
  AgentProfileSnapshot,
  AgentProvider,
  AgentSessionConfig,
  ProviderHomeRef,
  RuntimeLaunchWarning,
  RuntimeProfile,
  RuntimeProfileLaunchOverrides,
  RuntimeProfileSessionBehavior,
} from "./agent-sdk-types.js";
import type { ProviderAuthService } from "./provider-auth-service.js";
import type { RuntimeProfileService } from "./runtime-profile-service.js";
import { AccountLeaseCoordinator, type AccountLeaseSnapshot } from "./account-lease-coordinator.js";
import {
  createManagedProviderHomeRef,
  createNativeDefaultProviderHomeRef,
  getManagedProviderHomeProfileKey,
  normalizeProviderHomeRef,
} from "./provider-home-ref.js";

export interface ResolvedAgentLaunch {
  config: AgentSessionConfig;
  snapshot: AgentProfileSnapshot;
  launchContext: AgentLaunchContext;
  warnings: RuntimeLaunchWarning[];
}

export interface LaunchResolverOptions {
  runtimeProfileService?: RuntimeProfileService | null;
  providerAuthService?: ProviderAuthService | null;
  leaseCoordinator?: AccountLeaseCoordinator;
  now?: () => Date;
}

const DEFAULT_SESSION_BEHAVIOR: RuntimeProfileSessionBehavior = "continue";

export class LaunchResolver {
  private readonly runtimeProfileService: RuntimeProfileService | null;
  private readonly providerAuthService: ProviderAuthService | null;
  private readonly leaseCoordinator: AccountLeaseCoordinator;
  private readonly now: () => Date;

  constructor(options: LaunchResolverOptions = {}) {
    this.runtimeProfileService = options.runtimeProfileService ?? null;
    this.providerAuthService = options.providerAuthService ?? null;
    this.leaseCoordinator = options.leaseCoordinator ?? new AccountLeaseCoordinator();
    this.now = options.now ?? (() => new Date());
  }

  async resolve(input: {
    agentId: string;
    config: AgentSessionConfig;
    normalizedConfig: AgentSessionConfig;
    resolveDefaultAuthProfile: boolean;
    activeAgents?: AccountLeaseSnapshot[];
    excludeAgentId?: string;
  }): Promise<ResolvedAgentLaunch> {
    const profile = await this.resolveRuntimeProfile(input.normalizedConfig.runtimeProfileId);
    const mergedConfig = this.mergeRuntimeProfileIntoConfig(input.normalizedConfig, profile);
    const previousAdHocSnapshot =
      !profile && !mergedConfig.profileOverrides && !mergedConfig.profileSnapshot?.sourceProfileId
        ? mergedConfig.profileSnapshot
        : undefined;
    const requestedProviderHomeRef = resolveProviderHomeRefSelection({
      provider: mergedConfig.provider,
      config: mergedConfig,
      previousAdHocSnapshot,
      overrides: mergedConfig.profileOverrides,
      profile,
    });
    const authLaunch = await this.resolveAuthLaunch({
      provider: mergedConfig.provider,
      requestedProviderHomeRef,
      resolveDefault: input.resolveDefaultAuthProfile,
      sourceProfile: profile,
    });
    const { authProfileKey: _deprecatedAuthProfileKey, ...configWithoutDeprecatedAuth } =
      mergedConfig;
    const config = {
      ...configWithoutDeprecatedAuth,
      ...(profile ? { runtimeProfileId: profile.id } : {}),
      providerHomeRef: authLaunch.providerHomeRef,
    };
    const snapshot = this.buildSnapshot({
      profile,
      config,
      overrides: mergedConfig.profileOverrides,
      providerHomeRef: authLaunch.providerHomeRef,
    });
    const warnings = this.leaseCoordinator.evaluate({
      candidate: snapshot,
      activeAgents: input.activeAgents ?? [],
      excludeAgentId: input.excludeAgentId,
    });
    return {
      config: {
        ...config,
        profileSnapshot: snapshot,
        sessionBehavior: snapshot.sessionBehavior,
      },
      snapshot,
      launchContext: {
        env: {
          ...snapshot.envOverlay,
          ...authLaunch.env,
          PASEO_AGENT_ID: input.agentId,
        },
      },
      warnings,
    };
  }

  private async resolveRuntimeProfile(
    runtimeProfileId: string | null | undefined,
  ): Promise<RuntimeProfile | null> {
    const profileId = normalizeSelection(runtimeProfileId);
    if (!profileId) {
      return null;
    }
    if (!this.runtimeProfileService) {
      throw new Error("Runtime profiles are not available");
    }
    const profile = await this.runtimeProfileService.getProfile(profileId);
    if (!profile) {
      throw new Error(`Runtime profile '${profileId}' was not found`);
    }
    return profile;
  }

  private mergeRuntimeProfileIntoConfig(
    config: AgentSessionConfig,
    profile: RuntimeProfile | null,
  ): AgentSessionConfig {
    if (!profile) {
      return config;
    }
    const overrides = config.profileOverrides ?? {};
    const cwd = config.cwd;
    if (!cwd) {
      throw new Error(`Runtime profile '${profile.name}' does not define a working directory`);
    }
    return {
      ...config,
      provider: profile.provider,
      cwd,
      ...buildRuntimeSelectionConfig(config, overrides, profile),
      featureValues: mergeRecordValues(profile.featureValues, overrides.featureValues),
      sessionBehavior: resolveRuntimeProfileSessionBehavior(overrides, profile),
      systemPrompt: resolveRuntimeSystemPrompt(config, overrides, profile),
      mcpServers: mergeRecordValues(profile.mcpServers, overrides.mcpServers, config.mcpServers),
    };
  }

  private async resolveAuthLaunch(input: {
    provider: AgentProvider;
    requestedProviderHomeRef: ProviderHomeRef | null;
    resolveDefault: boolean;
    sourceProfile: RuntimeProfile | null;
  }): Promise<{
    profileKey: string | null;
    providerHomeRef: ProviderHomeRef;
    env?: Record<string, string>;
  }> {
    const requestedProfileKey = getManagedProviderHomeProfileKey(input.requestedProviderHomeRef);
    if (!this.providerAuthService) {
      if (requestedProfileKey) {
        throw new Error("Provider accounts are not available");
      }
      return {
        profileKey: null,
        providerHomeRef:
          normalizeProviderHomeRef(input.requestedProviderHomeRef, input.provider) ??
          createNativeDefaultProviderHomeRef({ provider: input.provider }),
      };
    }

    if (requestedProfileKey) {
      await this.assertReadyAccount(input.provider, requestedProfileKey);
    }

    if (input.resolveDefault) {
      await this.providerAuthService.syncCurrentProfile(input.provider);
    }

    const authLaunch = await this.providerAuthService.resolveLaunchContext({
      provider: input.provider,
      providerHomeRef: input.requestedProviderHomeRef,
    });
    if (requestedProfileKey && !authLaunch.profileKey) {
      throw new Error(
        input.sourceProfile
          ? `Runtime profile '${input.sourceProfile.name}' references an account that is not ready`
          : `Provider account '${requestedProfileKey}' is not ready`,
      );
    }
    return authLaunch;
  }

  private async assertReadyAccount(provider: AgentProvider, accountKey: string): Promise<void> {
    const accounts = await this.providerAuthService?.listProfiles(provider);
    const account = accounts?.find((candidate) => candidate.key === accountKey);
    if (!account) {
      throw new Error(`Provider account '${accountKey}' was not found for ${provider}`);
    }
    if (account.status !== "ready") {
      throw new Error(`Provider account '${accountKey}' is ${account.status}`);
    }
  }

  private buildSnapshot(input: {
    profile: RuntimeProfile | null;
    config: AgentSessionConfig;
    overrides?: RuntimeProfileLaunchOverrides;
    providerHomeRef: ProviderHomeRef;
  }): AgentProfileSnapshot {
    const { profile, config, overrides } = input;
    return stripUndefined<AgentProfileSnapshot>({
      ...buildSnapshotProfileIdentity(profile),
      provider: config.provider,
      providerHomeRef: input.providerHomeRef,
      accountKey: getManagedProviderHomeProfileKey(input.providerHomeRef),
      ...buildSnapshotRuntimeSelection(config),
      ...buildSnapshotProfileSettings(profile, overrides),
      sessionBehavior: resolveSnapshotSessionBehavior(profile, overrides, config),
      systemPrompt: config.systemPrompt ?? null,
      featureValues: config.featureValues,
      resolvedAt: this.now().toISOString(),
    });
  }
}

export function synthesizeAgentProfileSnapshot(config: AgentSessionConfig): AgentProfileSnapshot {
  const providerHomeRef =
    normalizeProviderHomeRef(config.providerHomeRef, config.provider) ??
    // COMPAT(providerHomeRef): old stored configs may only have authProfileKey.
    resolveManagedHomeRefFromProfileKey(config.provider, config.authProfileKey) ??
    createNativeDefaultProviderHomeRef({ provider: config.provider });
  return stripUndefined<AgentProfileSnapshot>({
    provider: config.provider,
    providerHomeRef,
    accountKey: getManagedProviderHomeProfileKey(providerHomeRef),
    model: config.model ?? null,
    modeId: config.modeId ?? null,
    thinkingOptionId: config.thinkingOptionId ?? null,
    systemPrompt: config.systemPrompt ?? null,
    featureValues: config.featureValues,
    concurrencyPolicy: "allow" as const,
    sessionBehavior: normalizeSessionBehavior(config.sessionBehavior),
    resolvedAt: new Date().toISOString(),
  });
}

function firstString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeSelection(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeSelection(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveProviderHomeRefSelection(input: {
  provider: AgentProvider;
  config: AgentSessionConfig;
  previousAdHocSnapshot?: AgentProfileSnapshot;
  overrides?: RuntimeProfileLaunchOverrides;
  profile: RuntimeProfile | null;
}): ProviderHomeRef | null {
  return (
    normalizeProviderHomeRef(input.config.providerHomeRef, input.provider) ??
    normalizeProviderHomeRef(input.previousAdHocSnapshot?.providerHomeRef, input.provider) ??
    normalizeProviderHomeRef(input.overrides?.providerHomeRef, input.provider) ??
    normalizeProviderHomeRef(input.profile?.providerHomeRef, input.provider) ??
    resolveManagedHomeRefFromProfileKey(
      input.provider,
      firstString(
        input.config.authProfileKey,
        input.previousAdHocSnapshot?.accountKey,
        input.overrides?.accountKey,
        input.profile?.accountKey,
      ),
    )
  );
}

function resolveManagedHomeRefFromProfileKey(
  provider: AgentProvider,
  profileKey: string | null | undefined,
): ProviderHomeRef | null {
  const normalized = normalizeSelection(profileKey);
  if (!normalized) {
    return null;
  }
  return createManagedProviderHomeRef({ provider, profileKey: normalized });
}

function buildRuntimeSelectionConfig(
  config: AgentSessionConfig,
  overrides: RuntimeProfileLaunchOverrides,
  profile: RuntimeProfile,
): Partial<AgentSessionConfig> {
  const providerHomeRef =
    normalizeProviderHomeRef(overrides.providerHomeRef, profile.provider) ??
    normalizeProviderHomeRef(profile.providerHomeRef, profile.provider) ??
    resolveManagedHomeRefFromProfileKey(
      profile.provider,
      firstString(overrides.accountKey, profile.accountKey),
    );
  return {
    modeId: firstString(overrides.modeId, profile.modeId, config.modeId) ?? undefined,
    model: firstString(overrides.model, profile.model, config.model) ?? undefined,
    thinkingOptionId:
      firstString(overrides.thinkingOptionId, profile.thinkingOptionId, config.thinkingOptionId) ??
      undefined,
    ...(providerHomeRef ? { providerHomeRef } : {}),
  };
}

function resolveRuntimeProfileSessionBehavior(
  overrides: RuntimeProfileLaunchOverrides,
  profile: RuntimeProfile,
): RuntimeProfileSessionBehavior {
  return normalizeSessionBehavior(overrides.sessionBehavior ?? profile.sessionBehavior);
}

function resolveRuntimeSystemPrompt(
  config: AgentSessionConfig,
  overrides: RuntimeProfileLaunchOverrides,
  profile: RuntimeProfile,
): string | undefined {
  return joinInstructionParts(
    firstString(overrides.systemPrompt, profile.systemPrompt, config.systemPrompt),
    firstString(overrides.instructionOverlay, profile.instructionOverlay),
  );
}

function buildSnapshotProfileIdentity(
  profile: RuntimeProfile | null,
): Pick<AgentProfileSnapshot, "sourceProfileId" | "sourceProfileName" | "sourceProfileVersion"> {
  return {
    sourceProfileId: profile?.id,
    sourceProfileVersion: profile?.version,
    sourceProfileName: profile?.name,
  };
}

function buildSnapshotRuntimeSelection(
  config: AgentSessionConfig,
): Pick<AgentProfileSnapshot, "modeId" | "model" | "thinkingOptionId"> {
  return {
    model: config.model ?? null,
    modeId: config.modeId ?? null,
    thinkingOptionId: config.thinkingOptionId ?? null,
  };
}

function buildSnapshotProfileSettings(
  profile: RuntimeProfile | null,
  overrides: RuntimeProfileLaunchOverrides | undefined,
): SnapshotProfileSettings {
  return {
    instructionOverlay:
      firstString(overrides?.instructionOverlay, profile?.instructionOverlay) ?? null,
    envOverlay: sanitizeProfileEnvOverlay(
      mergeRecordValues(profile?.envOverlay, overrides?.envOverlay),
    ),
    concurrencyPolicy: resolveSnapshotConcurrencyPolicy(profile),
  };
}

type SnapshotProfileSettings = Pick<
  AgentProfileSnapshot,
  "concurrencyPolicy" | "envOverlay" | "instructionOverlay"
>;

function resolveSnapshotSessionBehavior(
  profile: RuntimeProfile | null,
  overrides: RuntimeProfileLaunchOverrides | undefined,
  config: AgentSessionConfig,
): RuntimeProfileSessionBehavior {
  if (profile) {
    return normalizeSessionBehavior(overrides?.sessionBehavior ?? profile.sessionBehavior);
  }
  return normalizeSessionBehavior(config.sessionBehavior);
}

function resolveSnapshotConcurrencyPolicy(profile: RuntimeProfile | null) {
  return profile?.concurrencyPolicy ?? ("allow" as const);
}

function normalizeSessionBehavior(
  value: RuntimeProfileSessionBehavior | null | undefined,
): RuntimeProfileSessionBehavior {
  return value === "fresh" || value === "continue" ? value : DEFAULT_SESSION_BEHAVIOR;
}

function mergeRecordValues<T extends Record<string, unknown>>(
  ...values: Array<T | null | undefined>
): T {
  return Object.assign({}, ...values.filter(isRecordValue)) as T;
}

function isRecordValue<T extends Record<string, unknown>>(value: T | null | undefined): value is T {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

function joinInstructionParts(...parts: Array<string | null | undefined>): string | undefined {
  const normalized = parts
    .map((part) => normalizeSelection(part))
    .filter((part): part is string => Boolean(part));
  return normalized.length > 0 ? normalized.join("\n\n") : undefined;
}

const RESERVED_PROFILE_ENV_KEYS = new Set(["CODEX_HOME", "PASEO_AGENT_ID"]);

function sanitizeProfileEnvOverlay(
  value: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  if (!isRecordValue(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    ([key]) => !RESERVED_PROFILE_ENV_KEYS.has(key.toUpperCase()),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
