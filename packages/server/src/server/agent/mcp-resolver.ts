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
  const servers: Record<string, McpServerConfig> = {};
  const sources: Record<string, ResolvedMcpSourceInfo> = {};
  const accountKey = getManagedProviderHomeProfileKey(input.providerHomeRef);
  const runtimeProfileId = normalizeString(input.runtimeProfileId);
  const entries = input.entries ?? [];

  for (const entry of entries) {
    if (!entry.enabled || isReservedMcpServerId(entry.id)) {
      continue;
    }
    if (!scopeMatches(entry.scope, input.provider, accountKey, runtimeProfileId)) {
      continue;
    }
    servers[entry.id] = entry.config;
    sources[entry.id] = sourceInfoFromEntry(entry);
  }

  for (const [id, config] of Object.entries(input.sessionMcpServers ?? {})) {
    if (isReservedMcpServerId(id)) {
      continue;
    }
    servers[id] = config;
    sources[id] = {
      scope: "session",
      source: "session",
    };
  }

  if (input.injectPaseoTools === true && input.paseoMcpBaseUrl) {
    servers[SYSTEM_PASEO_MCP_SERVER_ID] = {
      type: "http",
      url: `${input.paseoMcpBaseUrl}?callerAgentId=${input.agentId}`,
    };
    sources[SYSTEM_PASEO_MCP_SERVER_ID] = {
      scope: "system",
      source: "system",
      protected: true,
    };
  }

  return {
    servers: Object.keys(servers).length > 0 ? servers : undefined,
    sources,
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

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
