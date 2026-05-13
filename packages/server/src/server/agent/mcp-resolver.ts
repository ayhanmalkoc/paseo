import type { AgentProvider, McpServerConfig, ProviderHomeRef } from "./agent-sdk-types.js";
import { getManagedProviderHomeProfileKey } from "./provider-home-ref.js";

export const SYSTEM_PASEO_MCP_SERVER_ID = "paseo";

export type McpRegistryScope =
  | { kind: "global" }
  | { kind: "provider"; provider: AgentProvider }
  | { kind: "account"; provider: AgentProvider; accountKey: string }
  | { kind: "runtimeProfile"; profileId: string };

export type McpRegistryEntrySource = "user" | "native-import";

export interface McpRegistryEntry {
  id: string;
  scope: McpRegistryScope;
  config: McpServerConfig;
  enabled: boolean;
  source: McpRegistryEntrySource;
  importedFrom?: {
    provider: AgentProvider;
    path: string;
    importedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type ResolvedMcpSourceScope = McpRegistryScope["kind"] | "session" | "system";

export interface ResolvedMcpSourceInfo {
  scope: ResolvedMcpSourceScope;
  source: McpRegistryEntrySource | "session" | "system";
  entryId?: string;
  provider?: AgentProvider;
  accountKey?: string;
  runtimeProfileId?: string;
  protected?: boolean;
}

export interface ResolvedMcpServers {
  servers?: Record<string, McpServerConfig>;
  sources: Record<string, ResolvedMcpSourceInfo>;
}

export type McpResolutionStepAction = "selected" | "overridden" | "ignored";

export interface McpResolutionStep {
  id: string;
  action: McpResolutionStepAction;
  reason?: string;
  source: ResolvedMcpSourceInfo;
  config?: McpServerConfig;
  overriddenBy?: ResolvedMcpSourceInfo;
}

export interface McpResolutionExplanation extends ResolvedMcpServers {
  steps: McpResolutionStep[];
}

export function isReservedMcpServerId(id: string): boolean {
  return id === SYSTEM_PASEO_MCP_SERVER_ID;
}

export function resolveMcpServers(input: {
  entries?: McpRegistryEntry[];
  provider: AgentProvider;
  providerHomeRef?: ProviderHomeRef | null;
  runtimeProfileId?: string | null;
  sessionMcpServers?: Record<string, McpServerConfig>;
  injectPaseoTools?: boolean;
  paseoMcpBaseUrl?: string | null;
  agentId: string;
}): ResolvedMcpServers {
  const explanation = explainMcpResolution(input);
  return {
    servers: explanation.servers,
    sources: explanation.sources,
  };
}

export function explainMcpResolution(input: {
  entries?: McpRegistryEntry[];
  provider: AgentProvider;
  providerHomeRef?: ProviderHomeRef | null;
  runtimeProfileId?: string | null;
  sessionMcpServers?: Record<string, McpServerConfig>;
  injectPaseoTools?: boolean;
  paseoMcpBaseUrl?: string | null;
  agentId: string;
}): McpResolutionExplanation {
  const servers: Record<string, McpServerConfig> = {};
  const sources: Record<string, ResolvedMcpSourceInfo> = {};
  const steps: McpResolutionStep[] = [];
  const accountKey = getManagedProviderHomeProfileKey(input.providerHomeRef);
  const runtimeProfileId = normalizeString(input.runtimeProfileId);
  const entries = input.entries ?? [];

  for (const entry of entries) {
    const source = sourceInfoFromEntry(entry);
    if (!entry.enabled) {
      steps.push({
        id: entry.id,
        action: "ignored",
        reason: "disabled",
        source,
      });
      continue;
    }
    if (isReservedMcpServerId(entry.id)) {
      steps.push({
        id: entry.id,
        action: "ignored",
        reason: "reserved-system-id",
        source,
      });
      continue;
    }
    if (!scopeMatches(entry.scope, input.provider, accountKey, runtimeProfileId)) {
      steps.push({
        id: entry.id,
        action: "ignored",
        reason: "scope-mismatch",
        source,
      });
      continue;
    }
    const previousSource = sources[entry.id];
    if (previousSource) {
      const previousStep = findLastSelectedStep(steps, entry.id);
      if (previousStep) {
        previousStep.action = "overridden";
        previousStep.reason = "overridden-by-later-scope";
        previousStep.overriddenBy = source;
      }
    }
    servers[entry.id] = entry.config;
    sources[entry.id] = source;
    steps.push({
      id: entry.id,
      action: "selected",
      source,
      config: entry.config,
    });
  }

  for (const [id, config] of Object.entries(input.sessionMcpServers ?? {})) {
    const source: ResolvedMcpSourceInfo = {
      scope: "session",
      source: "session",
    };
    if (isReservedMcpServerId(id)) {
      steps.push({
        id,
        action: "ignored",
        reason: "reserved-system-id",
        source,
      });
      continue;
    }
    const previousSource = sources[id];
    if (previousSource) {
      const previousStep = findLastSelectedStep(steps, id);
      if (previousStep) {
        previousStep.action = "overridden";
        previousStep.reason = "overridden-by-session";
        previousStep.overriddenBy = source;
      }
    }
    servers[id] = config;
    sources[id] = source;
    steps.push({
      id,
      action: "selected",
      source,
      config,
    });
  }

  if (input.injectPaseoTools === true && input.paseoMcpBaseUrl) {
    const source: ResolvedMcpSourceInfo = {
      scope: "system",
      source: "system",
      protected: true,
    };
    const previousStep = findLastSelectedStep(steps, SYSTEM_PASEO_MCP_SERVER_ID);
    if (previousStep) {
      previousStep.action = "overridden";
      previousStep.reason = "overridden-by-system";
      previousStep.overriddenBy = source;
    }
    servers[SYSTEM_PASEO_MCP_SERVER_ID] = {
      type: "http",
      url: `${input.paseoMcpBaseUrl}?callerAgentId=${input.agentId}`,
    };
    sources[SYSTEM_PASEO_MCP_SERVER_ID] = source;
    steps.push({
      id: SYSTEM_PASEO_MCP_SERVER_ID,
      action: "selected",
      source,
      config: servers[SYSTEM_PASEO_MCP_SERVER_ID],
    });
  }

  return {
    servers: Object.keys(servers).length > 0 ? servers : undefined,
    sources,
    steps,
  };
}

function scopeMatches(
  scope: McpRegistryScope,
  provider: AgentProvider,
  accountKey: string | null,
  runtimeProfileId: string | null,
): boolean {
  if (scope.kind === "global") {
    return true;
  }
  if (scope.kind === "provider") {
    return scope.provider === provider;
  }
  if (scope.kind === "account") {
    return scope.provider === provider && scope.accountKey === accountKey;
  }
  return scope.profileId === runtimeProfileId;
}

function sourceInfoFromEntry(entry: McpRegistryEntry): ResolvedMcpSourceInfo {
  if (entry.scope.kind === "provider") {
    return {
      scope: entry.scope.kind,
      source: entry.source,
      entryId: entry.id,
      provider: entry.scope.provider,
    };
  }
  if (entry.scope.kind === "account") {
    return {
      scope: entry.scope.kind,
      source: entry.source,
      entryId: entry.id,
      provider: entry.scope.provider,
      accountKey: entry.scope.accountKey,
    };
  }
  if (entry.scope.kind === "runtimeProfile") {
    return {
      scope: entry.scope.kind,
      source: entry.source,
      entryId: entry.id,
      runtimeProfileId: entry.scope.profileId,
    };
  }
  return {
    scope: entry.scope.kind,
    source: entry.source,
    entryId: entry.id,
  };
}

function findLastSelectedStep(steps: McpResolutionStep[], id: string): McpResolutionStep | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.id === id && step.action === "selected") {
      return step;
    }
  }
  return null;
}

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
