import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type { AgentProvider, McpServerConfig } from "./agent-sdk-types.js";
import {
  isReservedMcpServerId,
  type McpRegistryEntry,
  type McpRegistryEntrySource,
  type McpRegistryScope,
} from "./mcp-resolver.js";

interface StoredMcpRegistry {
  schemaVersion: 1;
  entries: McpRegistryEntry[];
}

export type McpRegistryEntryInput = Omit<
  McpRegistryEntry,
  "createdAt" | "updatedAt" | "enabled" | "source"
> & {
  enabled?: boolean;
  source?: McpRegistryEntrySource;
  createdAt?: string;
  updatedAt?: string;
};

export interface McpRegistryReader {
  listEntries(): Promise<McpRegistryEntry[]>;
}

const CURRENT_SCHEMA_VERSION = 1;

export class McpRegistryService implements McpRegistryReader {
  private readonly registryPath: string;
  private readonly logger: Logger;
  private registry: StoredMcpRegistry | null = null;
  private loadPromise: Promise<StoredMcpRegistry> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(options: { paseoHome: string; logger: Logger; now?: () => Date }) {
    this.registryPath = path.join(options.paseoHome, "mcp", "registry.json");
    this.logger = options.logger.child({ module: "mcp-registry" });
    this.now = options.now ?? (() => new Date());
  }

  async listEntries(): Promise<McpRegistryEntry[]> {
    const registry = await this.load();
    return registry.entries.map(cloneEntry);
  }

  async upsertEntry(input: McpRegistryEntryInput): Promise<McpRegistryEntry> {
    const entry = normalizeEntry(input, this.now().toISOString());
    if (!entry) {
      throw new Error("Invalid MCP registry entry");
    }
    if (isReservedMcpServerId(entry.id)) {
      throw new Error(`MCP server id '${entry.id}' is reserved by Paseo`);
    }

    const registry = await this.load();
    const key = getEntryKey(entry);
    const previousIndex = registry.entries.findIndex((candidate) => getEntryKey(candidate) === key);
    const previous = previousIndex >= 0 ? registry.entries[previousIndex] : undefined;
    const updated = {
      ...entry,
      createdAt: previous?.createdAt ?? entry.createdAt,
      updatedAt: this.now().toISOString(),
    };
    if (previousIndex >= 0) {
      registry.entries[previousIndex] = updated;
    } else {
      registry.entries.push(updated);
    }
    await this.save(registry);
    return cloneEntry(updated);
  }

  async removeEntry(id: string, scope: McpRegistryScope): Promise<boolean> {
    const normalizedId = normalizeRequiredString(id);
    if (!normalizedId || isReservedMcpServerId(normalizedId)) {
      return false;
    }
    const registry = await this.load();
    const key = getEntryKey({ id: normalizedId, scope });
    const nextEntries = registry.entries.filter((entry) => getEntryKey(entry) !== key);
    if (nextEntries.length === registry.entries.length) {
      return false;
    }
    registry.entries = nextEntries;
    await this.save(registry);
    return true;
  }

  private async load(): Promise<StoredMcpRegistry> {
    if (this.registry) {
      return this.registry;
    }
    this.loadPromise ??= this.readRegistry();
    this.registry = await this.loadPromise;
    return this.registry;
  }

  private async readRegistry(): Promise<StoredMcpRegistry> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    try {
      const data = await fs.readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(data) as Partial<StoredMcpRegistry>;
      return normalizeRegistry(parsed, (message, context) => this.logger.warn(context, message));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyRegistry();
      }
      this.logger.warn({ err: error }, "Failed to read MCP registry; starting empty");
      return emptyRegistry();
    }
  }

  private async save(registry: StoredMcpRegistry): Promise<void> {
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

function emptyRegistry(): StoredMcpRegistry {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    entries: [],
  };
}

function normalizeRegistry(
  value: Partial<StoredMcpRegistry>,
  warn: (message: string, context?: Record<string, unknown>) => void,
): StoredMcpRegistry {
  const entries: McpRegistryEntry[] = [];
  for (const rawEntry of Array.isArray(value.entries) ? value.entries : []) {
    const entry = normalizeEntry(rawEntry, new Date().toISOString());
    if (!entry || isReservedMcpServerId(entry.id)) {
      warn("Skipping invalid MCP registry entry", {
        entryId:
          rawEntry && typeof rawEntry === "object"
            ? (rawEntry as unknown as Record<string, unknown>).id
            : undefined,
      });
      continue;
    }
    entries.push(entry);
  }
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    entries,
  };
}

function normalizeEntry(value: unknown, fallbackTimestamp: string): McpRegistryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<McpRegistryEntry>;
  const id = normalizeRequiredString(record.id);
  const scope = normalizeScope(record.scope);
  const config = normalizeMcpServerConfig(record.config);
  if (!id || !scope || !config) {
    return null;
  }
  return {
    id,
    scope,
    config,
    enabled: record.enabled !== false,
    source: record.source === "native-import" ? "native-import" : "user",
    ...(record.importedFrom ? { importedFrom: normalizeImportedFrom(record.importedFrom) } : {}),
    createdAt: normalizeTimestamp(record.createdAt) ?? fallbackTimestamp,
    updatedAt: normalizeTimestamp(record.updatedAt) ?? fallbackTimestamp,
  };
}

function normalizeScope(value: unknown): McpRegistryScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const scope = value as Partial<McpRegistryScope>;
  if (scope.kind === "global") {
    return { kind: "global" };
  }
  if (scope.kind === "provider") {
    const provider = normalizeRequiredString(scope.provider);
    return provider ? { kind: "provider", provider } : null;
  }
  if (scope.kind === "account") {
    const provider = normalizeRequiredString(scope.provider);
    const accountKey = normalizeRequiredString(scope.accountKey);
    return provider && accountKey ? { kind: "account", provider, accountKey } : null;
  }
  if (scope.kind === "runtimeProfile") {
    const profileId = normalizeRequiredString(scope.profileId);
    return profileId ? { kind: "runtimeProfile", profileId } : null;
  }
  return null;
}

function normalizeMcpServerConfig(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const config = value as Partial<McpServerConfig>;
  if (config.type === "stdio") {
    const command = normalizeRequiredString(config.command);
    if (!command) {
      return null;
    }
    return {
      type: "stdio",
      command,
      ...(Array.isArray(config.args) ? { args: config.args.filter(isString) } : {}),
      ...normalizeStringRecordProperty("env", config.env),
    };
  }
  if (config.type === "http" || config.type === "sse") {
    const url = normalizeRequiredString(config.url);
    if (!url) {
      return null;
    }
    return {
      type: config.type,
      url,
      ...normalizeStringRecordProperty("headers", config.headers),
    };
  }
  return null;
}

function normalizeStringRecordProperty<K extends string>(
  key: K,
  value: unknown,
): { [P in K]?: Record<string, string> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] =>
    isString(entry[1]),
  );
  return (entries.length > 0 ? { [key]: Object.fromEntries(entries) } : {}) as {
    [P in K]?: Record<string, string>;
  };
}

function normalizeImportedFrom(value: McpRegistryEntry["importedFrom"]): {
  provider: AgentProvider;
  path: string;
  importedAt: string;
} {
  return {
    provider: normalizeRequiredString(value?.provider),
    path: normalizeRequiredString(value?.path),
    importedAt: normalizeTimestamp(value?.importedAt) ?? new Date().toISOString(),
  };
}

function getEntryKey(entry: Pick<McpRegistryEntry, "id" | "scope">): string {
  const scope = entry.scope;
  if (scope.kind === "global") {
    return `${scope.kind}:${entry.id}`;
  }
  if (scope.kind === "provider") {
    return `${scope.kind}:${scope.provider}:${entry.id}`;
  }
  if (scope.kind === "account") {
    return `${scope.kind}:${scope.provider}:${scope.accountKey}:${entry.id}`;
  }
  return `${scope.kind}:${scope.profileId}:${entry.id}`;
}

function normalizeRequiredString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function cloneEntry(entry: McpRegistryEntry): McpRegistryEntry {
  return JSON.parse(JSON.stringify(entry)) as McpRegistryEntry;
}

async function writeFileAtomically(targetPath: string, payload: string) {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(
    directory,
    `.mcp-registry.tmp-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, targetPath);
}
