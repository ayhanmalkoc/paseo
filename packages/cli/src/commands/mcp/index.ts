import { Command } from "commander";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentProviderDefinition,
  type McpRegistryEntry,
  type McpRegistryEntryInput,
  type McpRegistryScope,
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

function parseOptionalScope(options: ScopeOptions): McpRegistryScope | null {
  const selected = selectedScopeCount(options);
  if (selected === 0) {
    return null;
  }
  return parseRequiredScope(options);
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
