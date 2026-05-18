import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { AgentProvider, McpServerConfig } from "./agent-sdk-types.js";
import { isReservedMcpServerId, type McpLaunchEntry } from "./mcp-resolver.js";
import { resolveProviderHomeNativeConfigPath } from "./provider-native-config-files.js";

const CODEX_PROVIDER = "codex" as const;
const OPENCODE_PROVIDER = "opencode" as const;
const CODEX_CONFIG_FILENAME = "config.toml";
const PASEO_DISABLED_MCP_BEGIN_PREFIX = "# paseo-disabled-mcp-server ";
const PASEO_DISABLED_MCP_END = "# /paseo-disabled-mcp-server";

export interface NativeMcpImportSkipped {
  id?: string;
  reason: string;
}

export interface NativeMcpServerCandidate {
  id: string;
  config: McpServerConfig;
  enabled: boolean;
}

export interface NativeMcpImportParseResult {
  servers: NativeMcpServerCandidate[];
  skipped: NativeMcpImportSkipped[];
}

interface RawMcpTable {
  values: Record<string, unknown>;
  env: Record<string, string>;
  headers: Record<string, string>;
}

export async function readProviderHomeNativeMcpEntries(options: {
  provider: AgentProvider;
  providerHomePath?: string | null;
  accountKey?: string | null;
}): Promise<McpLaunchEntry[]> {
  if (!options.providerHomePath) {
    return [];
  }
  if (options.provider === CODEX_PROVIDER) {
    if (!options.accountKey) {
      return [];
    }
    return readCodexProviderHomeNativeMcpEntries({
      providerHomePath: options.providerHomePath,
      accountKey: options.accountKey,
    });
  }
  if (options.provider === OPENCODE_PROVIDER) {
    return readOpenCodeProviderHomeNativeMcpEntries(options.providerHomePath);
  }
  return [];
}

async function readCodexProviderHomeNativeMcpEntries(options: {
  providerHomePath: string;
  accountKey: string;
}): Promise<McpLaunchEntry[]> {
  const configPath = resolveCodexNativeConfigPath(options.providerHomePath);
  const content = await fs.readFile(configPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (content === null) {
    return [];
  }
  const parsed = parseCodexNativeMcpConfigToml(content);
  return parsed.servers
    .filter((server) => server.enabled)
    .map((server) => ({
      id: server.id,
      scope: {
        kind: "account",
        provider: CODEX_PROVIDER,
        accountKey: options.accountKey,
      },
      config: server.config,
      enabled: true,
      source: "native-config",
    }));
}

async function readOpenCodeProviderHomeNativeMcpEntries(
  providerHomePath: string,
): Promise<McpLaunchEntry[]> {
  const configPath = resolveProviderHomeNativeConfigPath(OPENCODE_PROVIDER, providerHomePath);
  const content = await fs.readFile(configPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (content === null) {
    return [];
  }
  const parsed = parseOpenCodeNativeMcpConfigJson(content);
  return parsed.servers
    .filter((server) => server.enabled)
    .map((server) => ({
      id: server.id,
      scope: {
        kind: "provider",
        provider: OPENCODE_PROVIDER,
      },
      config: server.config,
      enabled: true,
      source: "native-config",
    }));
}

export function resolveCodexNativeConfigPath(inputPath?: string): string {
  const rawPath = inputPath?.trim() || process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const expanded = rawPath.startsWith("~/") ? path.join(homedir(), rawPath.slice(2)) : rawPath;
  const resolved = path.resolve(expanded);
  return path.basename(resolved) === CODEX_CONFIG_FILENAME
    ? resolved
    : path.join(resolved, CODEX_CONFIG_FILENAME);
}

export function parseCodexNativeMcpConfigToml(content: string): NativeMcpImportParseResult {
  const disabledBlocks = extractPaseoDisabledMcpBlocks(content);
  const contentWithoutDisabledBlocks = removeAllPaseoDisabledMcpServerConfigs(content);
  const parsed = parseCodexActiveMcpConfigToml(contentWithoutDisabledBlocks);
  return {
    servers: [...parsed.servers, ...disabledBlocks.servers],
    skipped: [...parsed.skipped, ...disabledBlocks.skipped],
  };
}

function parseCodexActiveMcpConfigToml(content: string): NativeMcpImportParseResult {
  const tables = new Map<string, RawMcpTable>();
  const skipped: NativeMcpImportSkipped[] = [];
  let current: {
    id: string;
    section: "root" | "env" | "headers";
  } | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const header = parseTomlTableHeader(line);
    if (header) {
      current = resolveMcpTableHeader(header);
      if (current && !tables.has(current.id)) {
        tables.set(current.id, { values: {}, env: {}, headers: {} });
      }
      continue;
    }
    if (!current) {
      continue;
    }
    const assignment = splitTomlAssignment(line);
    if (!assignment) {
      continue;
    }
    const table = tables.get(current.id);
    if (!table) {
      continue;
    }
    const key = parseTomlKey(assignment.key);
    if (!key) {
      continue;
    }
    const value = parseTomlValue(assignment.value);
    if (current.section === "env") {
      const stringValue = asString(value);
      if (stringValue !== null) {
        table.env[key] = stringValue;
      }
      continue;
    }
    if (current.section === "headers") {
      const stringValue = asString(value);
      if (stringValue !== null) {
        table.headers[key] = stringValue;
      }
      continue;
    }
    table.values[key] = value;
  }

  const servers: NativeMcpServerCandidate[] = [];
  for (const [id, table] of tables) {
    const candidate = buildNativeMcpServerCandidate(id, table);
    if (candidate) {
      servers.push(candidate);
      continue;
    }
    skipped.push({ id, reason: "No supported command or URL config found" });
  }

  return { servers, skipped };
}

function extractPaseoDisabledMcpBlocks(content: string): NativeMcpImportParseResult {
  const servers: NativeMcpServerCandidate[] = [];
  const skipped: NativeMcpImportSkipped[] = [];
  const lines = content.split(/\r?\n/);
  let current: {
    id: string;
    lines: string[];
  } | null = null;

  for (const rawLine of lines) {
    const beginId = parsePaseoDisabledMcpBegin(rawLine.trim());
    if (beginId !== null) {
      current = { id: beginId, lines: [] };
      continue;
    }
    if (current && rawLine.trim() === PASEO_DISABLED_MCP_END) {
      const uncommented = current.lines.map(uncommentPaseoDisabledMcpLine).join("\n");
      const parsed = parseCodexActiveMcpConfigToml(uncommented);
      const matchingServer = parsed.servers.find((server) => server.id === current?.id);
      if (matchingServer) {
        servers.push({ ...matchingServer, enabled: false });
      } else {
        skipped.push({
          id: current.id,
          reason: "Disabled MCP block has no supported command or URL config",
        });
      }
      current = null;
      continue;
    }
    if (current) {
      current.lines.push(rawLine);
    }
  }

  return { servers, skipped };
}

function resolveMcpTableHeader(
  parts: string[],
): { id: string; section: "root" | "env" | "headers" } | null {
  if (parts[0] !== "mcp_servers" || !parts[1]) {
    return null;
  }
  const id = parts[1].trim();
  if (!id || isReservedMcpServerId(id)) {
    return null;
  }
  const section = parts[2];
  if (!section) {
    return { id, section: "root" };
  }
  if (section === "env") {
    return { id, section: "env" };
  }
  if (section === "headers" || section === "http_headers") {
    return { id, section: "headers" };
  }
  return null;
}

function buildNativeMcpServerCandidate(
  id: string,
  table: RawMcpTable,
): NativeMcpServerCandidate | null {
  const enabled = asBoolean(table.values.enabled) ?? true;
  const command = asString(table.values.command);
  if (command) {
    const args = asStringArray(table.values.args);
    const env = mergeStringRecords(asStringRecord(table.values.env), table.env);
    return {
      id,
      enabled,
      config: {
        type: "stdio",
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    };
  }

  const url = asString(table.values.url);
  if (url) {
    const transport = (
      asString(table.values.transport) ??
      asString(table.values.type) ??
      ""
    ).toLowerCase();
    const headers = mergeStringRecords(
      asStringRecord(table.values.headers),
      asStringRecord(table.values.http_headers),
      table.headers,
    );
    return {
      id,
      enabled,
      config: {
        type: transport === "sse" ? "sse" : "http",
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    };
  }

  return null;
}

export function writeCodexNativeMcpServerConfig(input: {
  content: string;
  id: string;
  config: McpServerConfig;
  enabled?: boolean;
}): string {
  const existing = parseCodexNativeMcpConfigToml(input.content).servers.find(
    (server) => server.id === input.id,
  );
  const existingNativeBlock = configsEqual(existing?.config, input.config)
    ? (extractCodexNativeActiveMcpServerBlock(input.content, input.id) ??
      extractPaseoDisabledMcpServerNativeBlock(input.content, input.id))
    : undefined;
  const withoutExisting = removeCodexNativeMcpServerConfig(input.content, input.id);
  const block =
    input.enabled === false
      ? formatPaseoDisabledMcpServerBlock({
          id: input.id,
          config: input.config,
          nativeBlock: existingNativeBlock,
        })
      : (existingNativeBlock ??
        formatCodexNativeMcpServerBlock({ id: input.id, config: input.config }));
  return normalizeTomlDocument([withoutExisting.trimEnd(), block].filter(Boolean).join("\n\n"));
}

export function removeCodexNativeMcpServerConfig(content: string, id: string): string {
  const withoutDisabled = removePaseoDisabledMcpServerConfig(content, id);
  return removeCodexNativeActiveMcpServerConfig(withoutDisabled, id);
}

export function parseGeminiNativeMcpConfigJson(content: string): NativeMcpImportParseResult {
  const skipped: NativeMcpImportSkipped[] = [];
  const settings = parseGeminiSettingsJson(content);
  const serversRecord = readRecord(settings.mcpServers);
  const mcpRecord = readRecord(settings.mcp);
  const allowed = new Set(asStringArray(mcpRecord?.allowed));
  const excluded = new Set(asStringArray(mcpRecord?.excluded));
  const hasAllowedList = Array.isArray(mcpRecord?.allowed);
  const servers: NativeMcpServerCandidate[] = [];

  for (const [id, value] of Object.entries(serversRecord ?? {})) {
    if (isReservedMcpServerId(id)) {
      skipped.push({ id, reason: "Reserved MCP server id" });
      continue;
    }
    const candidate = buildGeminiNativeMcpServerCandidate(id, value);
    if (!candidate) {
      skipped.push({ id, reason: "Unsupported Gemini MCP server config" });
      continue;
    }
    servers.push({
      ...candidate,
      enabled: !excluded.has(id) && (!hasAllowedList || allowed.has(id)),
    });
  }

  return { servers, skipped };
}

export function writeGeminiNativeMcpServerConfig(input: {
  content: string;
  id: string;
  config: McpServerConfig;
  enabled: boolean;
}): string {
  const settings = parseGeminiSettingsJson(input.content);
  const mcpServers = ensureGeminiRecord(settings, "mcpServers");
  const previous = readRecord(mcpServers[input.id]);
  mcpServers[input.id] = formatGeminiNativeMcpServerConfig(input.config, previous);
  setGeminiMcpServerEnabled(settings, input.id, input.enabled);
  return stringifyGeminiSettings(settings);
}

export function removeGeminiNativeMcpServerConfig(content: string, id: string): string {
  const settings = parseGeminiSettingsJson(content);
  const mcpServers = readRecord(settings.mcpServers);
  if (mcpServers) {
    delete mcpServers[id];
    if (Object.keys(mcpServers).length === 0) {
      delete settings.mcpServers;
    }
  }
  removeGeminiMcpServerFromLists(settings, id);
  return stringifyGeminiSettings(settings);
}

export function parseOpenCodeNativeMcpConfigJson(content: string): NativeMcpImportParseResult {
  const skipped: NativeMcpImportSkipped[] = [];
  const settings = parseOpenCodeConfigJson(content);
  const mcpRecord = readRecord(settings.mcp);
  const servers: NativeMcpServerCandidate[] = [];

  for (const [id, value] of Object.entries(mcpRecord ?? {})) {
    if (isReservedMcpServerId(id)) {
      skipped.push({ id, reason: "Reserved MCP server id" });
      continue;
    }
    const candidate = buildOpenCodeNativeMcpServerCandidate(id, value);
    if (!candidate) {
      skipped.push({ id, reason: "Unsupported OpenCode MCP server config" });
      continue;
    }
    servers.push(candidate);
  }

  return { servers, skipped };
}

export function writeOpenCodeNativeMcpServerConfig(input: {
  content: string;
  id: string;
  config: McpServerConfig;
  enabled: boolean;
}): string {
  const settings = parseOpenCodeConfigJson(input.content);
  const mcp = ensureOpenCodeRecord(settings, "mcp");
  const previous = readRecord(mcp[input.id]);
  mcp[input.id] = formatOpenCodeNativeMcpServerConfig(input.config, previous, input.enabled);
  return stringifyOpenCodeConfig(settings);
}

export function removeOpenCodeNativeMcpServerConfig(content: string, id: string): string {
  const settings = parseOpenCodeConfigJson(content);
  const mcp = readRecord(settings.mcp);
  if (mcp) {
    delete mcp[id];
    if (Object.keys(mcp).length === 0) {
      delete settings.mcp;
    }
  }
  return stringifyOpenCodeConfig(settings);
}

function removeCodexNativeActiveMcpServerConfig(content: string, id: string): string {
  const lines = content.split(/\r?\n/);
  const nextLines: string[] = [];
  let skipping = false;

  for (const rawLine of lines) {
    const header = parseTomlTableHeader(stripTomlComment(rawLine).trim());
    if (header) {
      skipping = isCodexNativeMcpTableForId(header, id);
    }
    if (!skipping) {
      nextLines.push(rawLine);
    }
  }

  return normalizeTomlDocument(nextLines.join("\n").trimEnd());
}

function extractCodexNativeActiveMcpServerBlock(content: string, id: string): string | undefined {
  const chunks: string[] = [];
  let current: string[] | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const header = parseTomlTableHeader(stripTomlComment(rawLine).trim());
    if (header) {
      const isTargetTable = isCodexNativeMcpTableForId(header, id);
      if (current) {
        chunks.push(current.join("\n").trimEnd());
        current = null;
      }
      if (isTargetTable) {
        current = [];
      }
    }
    if (current) {
      current.push(rawLine);
    }
  }

  if (current) {
    chunks.push(current.join("\n").trimEnd());
  }

  const block = chunks.filter(Boolean).join("\n\n");
  return block ? normalizeTomlDocument(block) : undefined;
}

function removePaseoDisabledMcpServerConfig(content: string, id: string): string {
  const lines = content.split(/\r?\n/);
  const nextLines: string[] = [];
  let skipping = false;

  for (const rawLine of lines) {
    const disabledId = parsePaseoDisabledMcpBegin(rawLine.trim());
    if (disabledId === id) {
      skipping = true;
      continue;
    }
    if (skipping && rawLine.trim() === PASEO_DISABLED_MCP_END) {
      skipping = false;
      continue;
    }
    if (!skipping) {
      nextLines.push(rawLine);
    }
  }

  return normalizeTomlDocument(nextLines.join("\n").trimEnd());
}

function extractPaseoDisabledMcpServerNativeBlock(content: string, id: string): string | undefined {
  const lines: string[] = [];
  let collecting = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const disabledId = parsePaseoDisabledMcpBegin(rawLine.trim());
    if (disabledId === id) {
      collecting = true;
      continue;
    }
    if (collecting && rawLine.trim() === PASEO_DISABLED_MCP_END) {
      break;
    }
    if (collecting) {
      if (rawLine.startsWith("# ")) {
        lines.push(rawLine.slice(2));
      } else if (rawLine === "#") {
        lines.push("");
      } else if (rawLine.startsWith("#")) {
        lines.push(rawLine.slice(1));
      } else {
        lines.push(rawLine);
      }
    }
  }

  const block = lines.join("\n").trimEnd();
  return block ? normalizeTomlDocument(block) : undefined;
}

function removeAllPaseoDisabledMcpServerConfigs(content: string): string {
  const lines = content.split(/\r?\n/);
  const nextLines: string[] = [];
  let skipping = false;

  for (const rawLine of lines) {
    if (parsePaseoDisabledMcpBegin(rawLine.trim()) !== null) {
      skipping = true;
      continue;
    }
    if (skipping && rawLine.trim() === PASEO_DISABLED_MCP_END) {
      skipping = false;
      continue;
    }
    if (!skipping) {
      nextLines.push(rawLine);
    }
  }

  return normalizeTomlDocument(nextLines.join("\n").trimEnd());
}

function isCodexNativeMcpTableForId(parts: string[], id: string): boolean {
  return parts[0] === "mcp_servers" && parts[1] === id;
}

function parseGeminiSettingsJson(content: string): Record<string, unknown> {
  if (!content.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Gemini settings.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini settings.json must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function buildGeminiNativeMcpServerCandidate(
  id: string,
  value: unknown,
): Omit<NativeMcpServerCandidate, "enabled"> | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }
  const command = asString(record.command);
  if (command) {
    const args = asStringArray(record.args);
    const env = asStringRecord(record.env);
    return {
      id,
      config: {
        type: "stdio",
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    };
  }
  const httpUrl = asString(record.httpUrl);
  if (httpUrl) {
    const headers = asStringRecord(record.headers);
    return {
      id,
      config: {
        type: "http",
        url: httpUrl,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    };
  }
  const url = asString(record.url);
  if (url) {
    const headers = asStringRecord(record.headers);
    return {
      id,
      config: {
        type: "sse",
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    };
  }
  return null;
}

function formatGeminiNativeMcpServerConfig(
  config: McpServerConfig,
  previous: Record<string, unknown> | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous };
  delete next.command;
  delete next.args;
  delete next.env;
  delete next.httpUrl;
  delete next.url;
  delete next.headers;
  if (config.type === "stdio") {
    next.command = config.command;
    if (config.args?.length) {
      next.args = config.args;
    }
    if (config.env && Object.keys(config.env).length > 0) {
      next.env = config.env;
    }
    return next;
  }
  if (config.type === "http") {
    next.httpUrl = config.url;
  } else {
    next.url = config.url;
  }
  if (config.headers && Object.keys(config.headers).length > 0) {
    next.headers = config.headers;
  }
  return next;
}

function setGeminiMcpServerEnabled(
  settings: Record<string, unknown>,
  id: string,
  enabled: boolean,
): void {
  const mcp = ensureGeminiRecord(settings, "mcp");
  const excluded = new Set(asStringArray(mcp.excluded));
  if (enabled) {
    excluded.delete(id);
    if (Array.isArray(mcp.allowed)) {
      const allowed = new Set(asStringArray(mcp.allowed));
      allowed.add(id);
      mcp.allowed = Array.from(allowed).sort();
    }
  } else {
    excluded.add(id);
  }
  if (excluded.size > 0) {
    mcp.excluded = Array.from(excluded).sort();
  } else {
    delete mcp.excluded;
  }
  pruneEmptyGeminiMcp(settings);
}

function removeGeminiMcpServerFromLists(settings: Record<string, unknown>, id: string): void {
  const mcp = readRecord(settings.mcp);
  if (!mcp) {
    return;
  }
  for (const key of ["allowed", "excluded"]) {
    if (!Array.isArray(mcp[key])) {
      continue;
    }
    const values = asStringArray(mcp[key]).filter((value) => value !== id);
    if (values.length > 0) {
      mcp[key] = values;
    } else {
      delete mcp[key];
    }
  }
  pruneEmptyGeminiMcp(settings);
}

function pruneEmptyGeminiMcp(settings: Record<string, unknown>): void {
  const mcp = readRecord(settings.mcp);
  if (mcp && Object.keys(mcp).length === 0) {
    delete settings.mcp;
  }
}

function ensureGeminiRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = readRecord(record[key]);
  if (existing) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  record[key] = next;
  return next;
}

function stringifyGeminiSettings(settings: Record<string, unknown>): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function parseOpenCodeConfigJson(content: string): Record<string, unknown> {
  if (!content.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (jsonError) {
    try {
      parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(content));
    } catch (jsoncError) {
      let message = String(jsoncError);
      if (jsoncError instanceof Error) {
        message = jsoncError.message;
      } else if (jsonError instanceof Error) {
        message = jsonError.message;
      }
      throw new Error(`OpenCode config is invalid: ${message}`, { cause: jsoncError });
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenCode config must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function buildOpenCodeNativeMcpServerCandidate(
  id: string,
  value: unknown,
): NativeMcpServerCandidate | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }
  const type = asString(record.type)?.toLowerCase();
  const enabled = asBoolean(record.enabled) ?? true;
  if (type === "local") {
    const commandParts = asStringArray(record.command);
    const command = commandParts[0] ?? asString(record.command);
    if (!command) {
      return null;
    }
    const args = commandParts.length > 1 ? commandParts.slice(1) : [];
    const env = mergeStringRecords(asStringRecord(record.environment), asStringRecord(record.env));
    return {
      id,
      enabled,
      config: {
        type: "stdio",
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    };
  }
  if (type === "remote") {
    const url = asString(record.url);
    if (!url) {
      return null;
    }
    const headers = asStringRecord(record.headers);
    return {
      id,
      enabled,
      config: {
        type: "http",
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    };
  }
  return null;
}

function formatOpenCodeNativeMcpServerConfig(
  config: McpServerConfig,
  previous: Record<string, unknown> | null,
  enabled: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous };
  delete next.command;
  delete next.environment;
  delete next.env;
  delete next.url;
  delete next.headers;
  if (config.type === "stdio") {
    next.type = "local";
    next.command = [config.command, ...(config.args ?? [])];
    if (config.env && Object.keys(config.env).length > 0) {
      next.environment = config.env;
    }
  } else {
    next.type = "remote";
    next.url = config.url;
    if (config.headers && Object.keys(config.headers).length > 0) {
      next.headers = config.headers;
    }
  }
  next.enabled = enabled;
  return next;
}

function ensureOpenCodeRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = readRecord(record[key]);
  if (existing) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  record[key] = next;
  return next;
}

function stringifyOpenCodeConfig(settings: Record<string, unknown>): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function stripJsonCommentsAndTrailingCommas(content: string): string {
  const withoutComments: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (quote) {
      withoutComments.push(char);
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      withoutComments.push(char);
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") {
        index += 1;
      }
      withoutComments.push("\n");
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    withoutComments.push(char);
  }
  return withoutComments.join("").replace(/,\s*([}\]])/g, "$1");
}

function formatCodexNativeMcpServerBlock(input: { id: string; config: McpServerConfig }): string {
  const keyPath = `mcp_servers.${formatTomlKey(input.id)}`;
  const lines: string[] = [`[${keyPath}]`];

  if (input.config.type === "stdio") {
    lines.push(`command = ${formatTomlValue(input.config.command)}`);
    if (input.config.args && input.config.args.length > 0) {
      lines.push(`args = ${formatTomlValue(input.config.args)}`);
    }
    if (input.config.env && Object.keys(input.config.env).length > 0) {
      lines.push("", `[${keyPath}.env]`);
      for (const [key, value] of Object.entries(input.config.env).sort()) {
        lines.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
      }
    }
    return lines.join("\n");
  }

  lines.push(`url = ${formatTomlValue(input.config.url)}`);
  if (input.config.type === "sse") {
    lines.push(`transport = "sse"`);
  }
  if (input.config.headers && Object.keys(input.config.headers).length > 0) {
    lines.push("", `[${keyPath}.http_headers]`);
    for (const [key, value] of Object.entries(input.config.headers).sort()) {
      lines.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
    }
  }
  return lines.join("\n");
}

function formatPaseoDisabledMcpServerBlock(input: {
  id: string;
  config: McpServerConfig;
  nativeBlock?: string;
}): string {
  const nativeBlock = input.nativeBlock ?? formatCodexNativeMcpServerBlock(input);
  return [
    `${PASEO_DISABLED_MCP_BEGIN_PREFIX}${JSON.stringify(input.id)}`,
    ...nativeBlock.split("\n").map((line) => `# ${line}`),
    PASEO_DISABLED_MCP_END,
  ].join("\n");
}

function configsEqual(left: McpServerConfig | undefined, right: McpServerConfig): boolean {
  return left !== undefined && stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parsePaseoDisabledMcpBegin(line: string): string | null {
  if (!line.startsWith(PASEO_DISABLED_MCP_BEGIN_PREFIX)) {
    return null;
  }
  const rawId = line.slice(PASEO_DISABLED_MCP_BEGIN_PREFIX.length).trim();
  if (!rawId) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawId);
    return typeof parsed === "string" && parsed.trim() ? parsed : null;
  } catch {
    return rawId;
  }
}

function uncommentPaseoDisabledMcpLine(line: string): string {
  return line.replace(/^# ?/, "");
}

function formatTomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatTomlValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }
  return JSON.stringify(value);
}

function normalizeTomlDocument(content: string): string {
  const trimmed = content.trimEnd();
  return trimmed ? `${trimmed}\n` : "";
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlTableHeader(line: string): string[] | null {
  if (!line.startsWith("[") || !line.endsWith("]") || line.startsWith("[[")) {
    return null;
  }
  return splitTomlPath(line.slice(1, -1).trim());
}

function splitTomlPath(value: string): string[] {
  return splitTopLevel(value, ".")
    .map(parseTomlKey)
    .filter((part): part is string => Boolean(part));
}

function splitTomlAssignment(line: string): { key: string; value: string } | null {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "=" && depth === 0) {
      return {
        key: line.slice(0, index).trim(),
        value: line.slice(index + 1).trim(),
      };
    }
  }
  return null;
}

function parseTomlKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return parseTomlString(trimmed);
  }
  return trimmed;
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return parseTomlString(trimmed);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitTopLevel(trimmed.slice(1, -1), ",")
      .map((part) => parseTomlValue(part))
      .filter((part): part is string => typeof part === "string");
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const record: Record<string, string> = {};
    for (const part of splitTopLevel(trimmed.slice(1, -1), ",")) {
      const assignment = splitTomlAssignment(part);
      if (!assignment) {
        continue;
      }
      const key = parseTomlKey(assignment.key);
      const parsedValue = parseTomlValue(assignment.value);
      const stringValue = asString(parsedValue);
      if (key && stringValue !== null) {
        record[key] = stringValue;
      }
    }
    return record;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return trimmed;
}

function parseTomlString(value: string): string {
  if (value.startsWith("'")) {
    return value.slice(1, -1);
  }
  const body = value.slice(1, -1);
  return body.replace(/\\(["\\btnfrt])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "b":
        return "\b";
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "f":
        return "\f";
      case "r":
        return "\r";
      default:
        return escaped;
    }
  });
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : [];
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const stringValue = asString(rawValue);
    if (stringValue !== null) {
      record[key] = stringValue;
    }
  }
  return record;
}

function mergeStringRecords(...records: Array<Record<string, string>>): Record<string, string> {
  return Object.assign({}, ...records);
}
