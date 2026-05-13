import { Command } from "commander";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentProviderDefinition,
  type McpRegistryEntry,
  type McpRegistryEntryInput,
  type McpRegistryScope,
  type McpResolutionStep,
  type McpServerConfig,
} from "@getpaseo/server";
import { withOutput } from "../../output/index.js";
import type { CommandOptions, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, collectMultiple } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";

const PROVIDER_IDS = new Set(AGENT_PROVIDER_DEFINITIONS.map((provider) => provider.id));
type AgentProviderId = AgentProviderDefinition["id"];

export interface McpListItem {
  id: string;
  enabled: string;
  source: string;
  scope: string;
  type: string;
  target: string;
}

export interface McpMutationResult {
  id: string;
  action: string;
  scope: string;
  enabled: string;
  type?: string;
  target?: string;
}

export interface McpExplainItem {
  id: string;
  action: string;
  reason: string;
  source: string;
  scope: string;
  type: string;
  target: string;
  overriddenBy: string;
}

const mcpListSchema: OutputSchema<McpListItem> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 24 },
    { header: "ENABLED", field: "enabled", width: 10 },
    { header: "SOURCE", field: "source", width: 14 },
    { header: "SCOPE", field: "scope", width: 24 },
    { header: "TYPE", field: "type", width: 8 },
    { header: "TARGET", field: "target", width: 42 },
  ],
};

const mcpExplainSchema: OutputSchema<McpExplainItem> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 24 },
    { header: "ACTION", field: "action", width: 12 },
    { header: "SOURCE", field: "source", width: 14 },
    { header: "SCOPE", field: "scope", width: 24 },
    { header: "TYPE", field: "type", width: 8 },
    { header: "TARGET", field: "target", width: 36 },
    { header: "REASON", field: "reason", width: 24 },
    { header: "OVERRIDDEN BY", field: "overriddenBy", width: 24 },
  ],
};

const mcpMutationSchema: OutputSchema<McpMutationResult> = {
  idField: "id",
  columns: [
    { header: "ACTION", field: "action", width: 12 },
    { header: "ID", field: "id", width: 24 },
    { header: "SCOPE", field: "scope", width: 24 },
    { header: "ENABLED", field: "enabled", width: 10 },
    { header: "TYPE", field: "type", width: 8 },
    { header: "TARGET", field: "target", width: 42 },
  ],
};

export interface ScopeOptions extends CommandOptions {
  host?: string;
  global?: boolean;
  provider?: string;
  account?: string;
  profile?: string;
}

export interface AddOptions extends ScopeOptions {
  type?: "stdio" | "http" | "sse";
  command?: string;
  arg?: string[];
  env?: string[];
  url?: string;
  header?: string[];
  disabled?: boolean;
}

type RemoveOptions = ScopeOptions;

interface ImportOptions extends CommandOptions {
  host?: string;
  provider?: string;
  fromNative?: boolean;
  path?: string;
}

interface ExplainOptions extends CommandOptions {
  host?: string;
  provider?: string;
  account?: string;
  profile?: string;
  agentId?: string;
  system?: boolean;
  sessionConfig?: string;
}

export function createMcpCommand(): Command {
  const mcp = new Command("mcp").description("Manage scoped MCP registry entries");

  addJsonAndDaemonHostOptions(
    addScopeOptions(mcp.command("list").description("List MCP registry entries")),
  ).action(withOutput(runListCommand));

  addJsonAndDaemonHostOptions(
    addScopeOptions(
      mcp
        .command("add")
        .description("Add or update an MCP registry entry")
        .argument("<id>", "MCP server id")
        .requiredOption("--type <type>", "MCP server type: stdio, http, or sse")
        .option("--command <command>", "stdio command")
        .option("--arg <arg>", "stdio argument; repeat for multiple values", collectMultiple, [])
        .option(
          "--env <key=value>",
          "stdio environment value; repeat for multiple values",
          collectMultiple,
          [],
        )
        .option("--url <url>", "http/sse server URL")
        .option(
          "--header <key=value>",
          "http/sse header value; repeat for multiple values",
          collectMultiple,
          [],
        )
        .option("--disabled", "Create the entry disabled"),
    ),
  ).action(withOutput(runAddCommand));

  addJsonAndDaemonHostOptions(
    addScopeOptions(
      mcp
        .command("remove")
        .description("Remove an MCP registry entry")
        .argument("<id>", "MCP server id"),
    ),
  ).action(withOutput(runRemoveCommand));

  addJsonAndDaemonHostOptions(
    mcp
      .command("import")
      .description("Import MCP registry entries from a native provider config")
      .requiredOption("--provider <provider>", "Provider to import from, e.g. codex")
      .option("--from-native", "Import from the provider's native config")
      .option("--path <path>", "Native provider home or config file path"),
  ).action(withOutput(runImportCommand));

  addJsonAndDaemonHostOptions(
    mcp
      .command("explain")
      .description("Preview resolved MCP servers for a provider/account/profile")
      .requiredOption("--provider <provider>", "Provider to resolve, e.g. codex")
      .option("--account <account>", "Managed account key or provider:accountKey")
      .option("--profile <profileId>", "Runtime profile id")
      .option("--agent-id <agentId>", "Caller agent id used for system Paseo MCP URL")
      .option("--session-config <json>", "Session MCP server override JSON object")
      .option("--no-system", "Exclude system Paseo MCP tools"),
  ).action(withOutput(runExplainCommand));

  return mcp;
}

function addScopeOptions<T extends Command>(command: T): T {
  return command
    .option("--global", "Global MCP scope")
    .option("--provider <provider>", "Provider MCP scope, e.g. codex")
    .option("--account <provider:account>", "Account MCP scope, e.g. codex:work")
    .option("--profile <profileId>", "Runtime profile MCP scope");
}

async function runListCommand(
  options: ScopeOptions,
  _command: Command,
): Promise<ListResult<McpListItem>> {
  const scope = parseOptionalScope(options);
  const client = await connectToDaemon({ host: options.host });
  try {
    const payload = await client.listMcpRegistryEntries();
    const entries = scope
      ? payload.entries.filter((entry) => scopeKey(entry.scope) === scopeKey(scope))
      : payload.entries;
    return {
      type: "list",
      data: entries.map(toListItem),
      schema: mcpListSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runAddCommand(
  id: string,
  options: AddOptions,
  _command: Command,
): Promise<SingleResult<McpMutationResult>> {
  const scope = parseRequiredScope(options);
  const config = parseMcpConfig(options);
  const entry: McpRegistryEntryInput = {
    id,
    scope,
    config,
    enabled: options.disabled !== true,
    source: "user",
  };
  const client = await connectToDaemon({ host: options.host });
  try {
    const payload = await client.upsertMcpRegistryEntry({ entry });
    return {
      type: "single",
      data: {
        action: "upserted",
        ...toMutationResult(payload.entry),
      },
      schema: mcpMutationSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runRemoveCommand(
  id: string,
  options: RemoveOptions,
  _command: Command,
): Promise<SingleResult<McpMutationResult>> {
  const scope = parseRequiredScope(options);
  const client = await connectToDaemon({ host: options.host });
  try {
    const payload = await client.removeMcpRegistryEntry({ id, scope });
    return {
      type: "single",
      data: {
        id,
        action: payload.removed ? "removed" : "not-found",
        scope: formatScope(scope),
        enabled: "-",
      },
      schema: mcpMutationSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runImportCommand(
  options: ImportOptions,
  _command: Command,
): Promise<ListResult<McpListItem>> {
  if (options.fromNative !== true) {
    throw {
      code: "INVALID_MCP_IMPORT_SOURCE",
      message: "Specify --from-native to import MCP servers from a native provider config",
    };
  }
  const provider = parseProvider(options.provider ?? "");
  const client = await connectToDaemon({ host: options.host });
  try {
    const payload = await client.importMcpRegistryEntries({
      provider,
      source: "native",
      path: options.path,
    });
    return {
      type: "list",
      data: payload.entries.map(toListItem),
      schema: mcpListSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runExplainCommand(
  options: ExplainOptions,
  _command: Command,
): Promise<ListResult<McpExplainItem>> {
  const provider = parseProvider(options.provider ?? "");
  const accountKey = parseExplainAccountKey(options.account, provider);
  const sessionMcpServers = options.sessionConfig
    ? parseSessionMcpServers(options.sessionConfig)
    : undefined;
  const client = await connectToDaemon({ host: options.host });
  try {
    const payload = await client.explainMcpRegistry({
      provider,
      accountKey,
      runtimeProfileId: options.profile,
      agentId: options.agentId,
      includeSystem: options.system !== false,
      sessionMcpServers,
    });
    return {
      type: "list",
      data: payload.steps.map(toExplainItem),
      schema: mcpExplainSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function parseOptionalScope(options: ScopeOptions): McpRegistryScope | null {
  const selected = selectedScopeCount(options);
  if (selected === 0) {
    return null;
  }
  return parseRequiredScope(options);
}

export function parseExplainAccountKey(
  value: string | undefined,
  provider: AgentProviderId,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!trimmed.includes(":")) {
    return trimmed;
  }
  const [scopeProvider, accountKey] = splitAccountScope(trimmed);
  if (scopeProvider !== provider) {
    throw {
      code: "INVALID_SCOPE",
      message: `--account provider '${scopeProvider}' does not match --provider '${provider}'`,
    };
  }
  return accountKey;
}

export function parseSessionMcpServers(value: string): Record<string, McpServerConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw {
      code: "INVALID_SESSION_MCP_CONFIG",
      message: `--session-config must be a JSON object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw {
      code: "INVALID_SESSION_MCP_CONFIG",
      message: "--session-config must be a JSON object keyed by MCP server id",
    };
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [id, config] of Object.entries(parsed)) {
    servers[id] = parseSessionMcpServerConfig(id, config);
  }
  return servers;
}

function parseSessionMcpServerConfig(id: string, config: unknown): McpServerConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw {
      code: "INVALID_SESSION_MCP_CONFIG",
      message: `Session MCP server '${id}' must be an object`,
    };
  }
  const value = config as Partial<McpServerConfig>;
  if (value.type === "stdio" && typeof value.command === "string" && value.command.trim()) {
    return {
      type: "stdio",
      command: value.command,
      ...(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string")
        ? { args: value.args }
        : {}),
      ...recordIfNotEmpty("env", normalizeStringRecord(value.env)),
    };
  }
  if ((value.type === "http" || value.type === "sse") && typeof value.url === "string") {
    return {
      type: value.type,
      url: value.url,
      ...recordIfNotEmpty("headers", normalizeStringRecord(value.headers)),
    };
  }
  throw {
    code: "INVALID_SESSION_MCP_CONFIG",
    message: `Session MCP server '${id}' must be stdio, http, or sse config`,
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      record[key] = item;
    }
  }
  return record;
}

export function parseRequiredScope(options: ScopeOptions): McpRegistryScope {
  const selected = selectedScopeCount(options);
  if (selected !== 1) {
    throw {
      code: "INVALID_SCOPE",
      message: "Specify exactly one scope: --global, --provider, --account, or --profile",
    };
  }
  if (options.global) {
    return { kind: "global" };
  }
  if (options.provider) {
    return { kind: "provider", provider: parseProvider(options.provider) };
  }
  if (options.account) {
    const [provider, accountKey] = splitAccountScope(options.account);
    return { kind: "account", provider, accountKey };
  }
  if (options.profile) {
    const profileId = options.profile.trim();
    if (!profileId) {
      throw { code: "INVALID_SCOPE", message: "--profile requires a profile id" };
    }
    return { kind: "runtimeProfile", profileId };
  }
  throw { code: "INVALID_SCOPE", message: "Missing MCP scope" };
}

function selectedScopeCount(options: ScopeOptions): number {
  return [options.global, options.provider, options.account, options.profile].filter(Boolean)
    .length;
}

function parseProvider(value: string): AgentProviderId {
  const provider = value.trim().toLowerCase();
  if (!PROVIDER_IDS.has(provider)) {
    throw {
      code: "INVALID_PROVIDER",
      message: `Unknown provider '${value}'`,
      details: { supported: Array.from(PROVIDER_IDS).sort() },
    };
  }
  return provider as AgentProviderId;
}

function splitAccountScope(value: string): [AgentProviderId, string] {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw {
      code: "INVALID_SCOPE",
      message: "--account must use provider:accountKey format",
    };
  }
  const provider = parseProvider(value.slice(0, separator));
  const accountKey = value.slice(separator + 1).trim();
  if (!accountKey) {
    throw { code: "INVALID_SCOPE", message: "--account requires a non-empty account key" };
  }
  return [provider, accountKey];
}

export function parseMcpConfig(options: AddOptions): McpServerConfig {
  switch (options.type) {
    case "stdio": {
      const command = options.command?.trim();
      if (!command) {
        throw { code: "INVALID_MCP_CONFIG", message: "--command is required for stdio MCP" };
      }
      return {
        type: "stdio",
        command,
        ...(options.arg && options.arg.length > 0 ? { args: options.arg } : {}),
        ...recordIfNotEmpty("env", parseKeyValueList(options.env ?? [], "--env")),
      };
    }
    case "http":
    case "sse": {
      const url = options.url?.trim();
      if (!url) {
        throw { code: "INVALID_MCP_CONFIG", message: "--url is required for http/sse MCP" };
      }
      return {
        type: options.type,
        url,
        ...recordIfNotEmpty("headers", parseKeyValueList(options.header ?? [], "--header")),
      };
    }
    default:
      throw {
        code: "INVALID_MCP_CONFIG",
        message: "--type must be one of stdio, http, or sse",
      };
  }
}

function parseKeyValueList(values: string[], optionName: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw {
        code: "INVALID_KEY_VALUE",
        message: `${optionName} values must use key=value format`,
      };
    }
    const key = value.slice(0, separator).trim();
    if (!key) {
      throw {
        code: "INVALID_KEY_VALUE",
        message: `${optionName} key cannot be empty`,
      };
    }
    result[key] = value.slice(separator + 1);
  }
  return result;
}

function recordIfNotEmpty<Key extends string>(
  key: Key,
  value: Record<string, string>,
): Record<Key, Record<string, string>> | Record<string, never> {
  return Object.keys(value).length > 0
    ? ({ [key]: value } as Record<Key, Record<string, string>>)
    : {};
}

function toListItem(entry: McpRegistryEntry): McpListItem {
  return {
    id: entry.id,
    enabled: entry.enabled ? "yes" : "no",
    source: entry.source,
    scope: formatScope(entry.scope),
    type: entry.config.type,
    target: formatConfigTarget(entry.config),
  };
}

function toMutationResult(entry: McpRegistryEntry): Omit<McpMutationResult, "action"> {
  return {
    id: entry.id,
    scope: formatScope(entry.scope),
    enabled: entry.enabled ? "yes" : "no",
    type: entry.config.type,
    target: formatConfigTarget(entry.config),
  };
}

function toExplainItem(step: McpResolutionStep): McpExplainItem {
  return {
    id: step.id,
    action: step.action,
    reason: step.reason ?? "",
    source: step.source.source,
    scope: formatResolvedScope(step.source),
    type: step.config?.type ?? "-",
    target: step.config ? formatConfigTarget(step.config) : "",
    overriddenBy: step.overriddenBy ? formatResolvedScope(step.overriddenBy) : "",
  };
}

function formatScope(scope: McpRegistryScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "provider":
      return `provider:${scope.provider}`;
    case "account":
      return `account:${scope.provider}:${scope.accountKey}`;
    case "runtimeProfile":
      return `profile:${scope.profileId}`;
  }
  return "";
}

function formatResolvedScope(source: McpResolutionStep["source"]): string {
  switch (source.scope) {
    case "global":
      return "global";
    case "provider":
      return `provider:${source.provider ?? ""}`;
    case "account":
      return `account:${source.provider ?? ""}:${source.accountKey ?? ""}`;
    case "runtimeProfile":
      return `profile:${source.runtimeProfileId ?? ""}`;
    case "session":
      return "session";
    case "system":
      return "system";
  }
  return "";
}

function scopeKey(scope: McpRegistryScope): string {
  return JSON.stringify(scope);
}

function formatConfigTarget(config: McpServerConfig): string {
  switch (config.type) {
    case "stdio":
      return [config.command, ...(config.args ?? [])].join(" ");
    case "http":
    case "sse":
      return config.url;
  }
  return "";
}
