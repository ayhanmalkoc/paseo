import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { AgentProvider, McpServerConfig } from "./agent-sdk-types.js";
import { isReservedMcpServerId, type McpLaunchEntry } from "./mcp-resolver.js";

const CODEX_PROVIDER = "codex" as const;
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
  if (options.provider !== CODEX_PROVIDER || !options.providerHomePath || !options.accountKey) {
    return [];
  }
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
        provider: options.provider,
        accountKey: options.accountKey ?? "",
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
  const withoutExisting = removeCodexNativeMcpServerConfig(input.content, input.id);
  const block =
    input.enabled === false
      ? formatPaseoDisabledMcpServerBlock({ id: input.id, config: input.config })
      : formatCodexNativeMcpServerBlock({ id: input.id, config: input.config });
  return normalizeTomlDocument([withoutExisting.trimEnd(), block].filter(Boolean).join("\n\n"));
}

export function removeCodexNativeMcpServerConfig(content: string, id: string): string {
  const withoutDisabled = removePaseoDisabledMcpServerConfig(content, id);
  return removeCodexNativeActiveMcpServerConfig(withoutDisabled, id);
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

function formatPaseoDisabledMcpServerBlock(input: { id: string; config: McpServerConfig }): string {
  const nativeBlock = formatCodexNativeMcpServerBlock(input);
  return [
    `${PASEO_DISABLED_MCP_BEGIN_PREFIX}${JSON.stringify(input.id)}`,
    ...nativeBlock.split("\n").map((line) => `# ${line}`),
    PASEO_DISABLED_MCP_END,
  ].join("\n");
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
