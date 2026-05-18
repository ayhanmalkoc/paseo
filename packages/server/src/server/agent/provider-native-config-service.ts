import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { AgentProvider, McpServerConfig } from "./agent-sdk-types.js";
import {
  parseGeminiNativeMcpConfigJson,
  parseCodexNativeMcpConfigToml,
  parseOpenCodeNativeMcpConfigJson,
  removeGeminiNativeMcpServerConfig,
  removeCodexNativeMcpServerConfig,
  removeOpenCodeNativeMcpServerConfig,
  writeGeminiNativeMcpServerConfig,
  writeCodexNativeMcpServerConfig,
  writeOpenCodeNativeMcpServerConfig,
} from "./mcp-native-import.js";
import type { ProviderAuthService } from "./provider-auth-service.js";
import {
  materializeProviderNativeConfigToHome,
  normalizeConfigContent,
  normalizeProviderNativeConfigContentFromHome,
  resolveOpenCodeConfigPath,
  resolveProviderHomeNativeConfigPath,
  resolveProviderNativeConfigPath,
  syncProviderNativeHooksFromHome,
} from "./provider-native-config-files.js";
import { getProviderRoot } from "./provider-layout.js";

export interface ProviderNativeConfigSnapshot {
  provider: AgentProvider;
  path: string;
  content: string;
  exists: boolean;
  updatedAt?: string;
  extensions?: ProviderNativeExtension[];
}

export interface ProviderNativeExtension {
  id: string;
  name?: string;
  version?: string;
  path: string;
  enabled?: boolean;
  contextFileName?: string;
  accountKey?: string;
  accountAlias?: string;
  skillIds: string[];
  skills: ProviderNativeExtensionSkill[];
}

export interface ProviderNativeExtensionSkill {
  id: string;
  enabled: boolean;
}

export interface ProviderNativeMcpServer {
  id: string;
  config: McpServerConfig;
  enabled: boolean;
}

export class ProviderNativeConfigService {
  private readonly logger: Logger;
  private readonly paseoHome: string;
  private readonly providerAuthService: ProviderAuthService;
  private readonly codexNativeHomeResolver: () => string;
  private readonly geminiNativeHomeResolver: () => string;
  private readonly opencodeNativeConfigHomeResolver: () => string;

  constructor(options: {
    paseoHome: string;
    logger: Logger;
    providerAuthService: ProviderAuthService;
    codexNativeHomeResolver?: () => string;
    geminiNativeHomeResolver?: () => string;
    opencodeNativeConfigHomeResolver?: () => string;
  }) {
    this.logger = options.logger.child({ module: "provider-native-config" });
    this.paseoHome = options.paseoHome;
    this.providerAuthService = options.providerAuthService;
    this.codexNativeHomeResolver = options.codexNativeHomeResolver ?? resolveDefaultCodexHome;
    this.geminiNativeHomeResolver = options.geminiNativeHomeResolver ?? resolveDefaultGeminiHome;
    this.opencodeNativeConfigHomeResolver =
      options.opencodeNativeConfigHomeResolver ?? resolveDefaultOpenCodeConfigHome;
  }

  getSupportedProviders(): AgentProvider[] {
    return ["codex", "gemini", "opencode"];
  }

  async readProviderConfig(input: {
    provider: AgentProvider;
  }): Promise<ProviderNativeConfigSnapshot> {
    const configPath = this.resolveConfigPath(input.provider);
    const extensions = await this.readProviderExtensions(input.provider);
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(configPath, "utf8"),
        fs.stat(configPath),
      ]);
      return {
        provider: input.provider,
        path: configPath,
        content,
        exists: true,
        updatedAt: stat.mtime.toISOString(),
        ...(extensions.length > 0 ? { extensions } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error, provider: input.provider }, "Failed to read native config");
        throw error;
      }
      return {
        provider: input.provider,
        path: configPath,
        content: "",
        exists: false,
        ...(extensions.length > 0 ? { extensions } : {}),
      };
    }
  }

  async writeProviderConfig(input: {
    provider: AgentProvider;
    content: string;
  }): Promise<ProviderNativeConfigSnapshot> {
    const configPath = this.resolveConfigPath(input.provider);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, normalizeConfigContent(input.content), "utf8");
    await this.materializeProviderConfigToAccounts(input.provider);
    return this.readProviderConfig(input);
  }

  async syncProviderConfigFromNative(input: {
    provider: AgentProvider;
  }): Promise<ProviderNativeConfigSnapshot> {
    const targetPath = this.resolveConfigPath(input.provider);
    const sourcePath = this.resolveNativeConfigPath(input.provider);
    let content: string;
    const existingContent = await fs.readFile(targetPath, "utf8").catch(() => null);
    try {
      content = await fs.readFile(sourcePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Native ${input.provider} config was not found at ${sourcePath}`, {
          cause: error,
        });
      }
      throw error;
    }
    const normalizedContent = normalizeProviderNativeConfigContentFromHome({
      content,
      provider: input.provider,
      providerRoot: this.resolveProviderRoot(input.provider),
      sourceHomePath: path.dirname(sourcePath),
    });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      this.preserveManagedMcpServers(input.provider, normalizedContent, existingContent),
      "utf8",
    );
    await syncProviderNativeHooksFromHome({
      provider: input.provider,
      providerRoot: this.resolveProviderRoot(input.provider),
      sourceHomePath: path.dirname(sourcePath),
    });
    await this.materializeProviderConfigToAccounts(input.provider);
    return this.readProviderConfig(input);
  }

  async listProviderMcpServers(input: {
    provider: AgentProvider;
  }): Promise<ProviderNativeMcpServer[]> {
    const config = await this.readProviderConfig(input);
    if (!config.content.trim()) {
      return [];
    }
    return this.parseNativeMcpConfig(input.provider, config.content).servers.map((server) => ({
      id: server.id,
      config: server.config,
      enabled: server.enabled,
    }));
  }

  async upsertProviderMcpServer(input: {
    provider: AgentProvider;
    id: string;
    config: McpServerConfig;
    enabled?: boolean;
  }): Promise<ProviderNativeMcpServer> {
    const snapshot = await this.readProviderConfig(input);
    const enabled =
      input.enabled ??
      this.parseNativeMcpConfig(input.provider, snapshot.content).servers.find(
        (server) => server.id === input.id,
      )?.enabled ??
      true;
    const content = this.writeNativeMcpServerConfig({
      provider: input.provider,
      content: snapshot.content,
      id: input.id,
      config: input.config,
      enabled,
    });
    await this.writeProviderConfig({
      provider: input.provider,
      content,
    });
    return {
      id: input.id,
      config: input.config,
      enabled,
    };
  }

  async removeProviderMcpServer(input: { provider: AgentProvider; id: string }): Promise<boolean> {
    const snapshot = await this.readProviderConfig(input);
    const existed = this.parseNativeMcpConfig(input.provider, snapshot.content).servers.some(
      (server) => server.id === input.id,
    );
    const content = this.removeNativeMcpServerConfig(input.provider, snapshot.content, input.id);
    await this.writeProviderConfig({
      provider: input.provider,
      content,
    });
    return existed;
  }

  async setProviderExtensionEnabled(input: {
    provider: AgentProvider;
    accountKey: string;
    extensionId: string;
    enabled: boolean;
  }): Promise<ProviderNativeConfigSnapshot> {
    if (input.provider !== "gemini") {
      throw new Error(
        `Native extension toggles are not supported for provider '${input.provider}'`,
      );
    }
    const profile = await this.resolveProviderProfile(input.provider, input.accountKey);
    const homePath = profile.providerHomeRef?.homePath;
    if (!homePath) {
      throw new Error(`Provider account '${input.accountKey}' has no managed home`);
    }
    await writeGeminiExtensionEnabled({
      extensionsRoot: path.join(homePath, ".gemini", "extensions"),
      extensionId: input.extensionId,
      enabled: input.enabled,
    });
    return this.readProviderConfig({ provider: input.provider });
  }

  async setProviderSkillEnabled(input: {
    provider: AgentProvider;
    skillId: string;
    enabled: boolean;
  }): Promise<ProviderNativeConfigSnapshot> {
    if (input.provider !== "gemini") {
      throw new Error(`Native skill toggles are not supported for provider '${input.provider}'`);
    }
    const snapshot = await this.readProviderConfig({ provider: input.provider });
    return this.writeProviderConfig({
      provider: input.provider,
      content: setGeminiSkillEnabled(snapshot.content, input.skillId, input.enabled),
    });
  }

  async materializeProviderConfigToAccounts(provider: AgentProvider): Promise<void> {
    const profiles = await this.providerAuthService.listProfiles(provider);
    await Promise.all(
      profiles.map(async (profile) => {
        const homePath = profile.providerHomeRef?.homePath;
        if (!homePath) {
          return;
        }
        await materializeProviderNativeConfigToHome({
          provider,
          providerRoot: this.resolveProviderRoot(provider),
          providerHomePath: homePath,
        });
      }),
    );
  }

  async materializeProviderConfigToAccount(input: {
    provider: AgentProvider;
    providerHomePath: string;
  }): Promise<boolean> {
    return materializeProviderNativeConfigToHome({
      provider: input.provider,
      providerRoot: this.resolveProviderRoot(input.provider),
      providerHomePath: input.providerHomePath,
    });
  }

  private async readProviderExtensions(
    provider: AgentProvider,
  ): Promise<ProviderNativeExtension[]> {
    if (provider !== "gemini") {
      return [];
    }
    const skillState = await readGeminiSkillState(this.resolveConfigPath(provider));
    const profiles = await this.providerAuthService.listProfiles(provider);
    const extensions = await Promise.all(
      profiles.map(async (profile) => {
        const homePath = profile.providerHomeRef?.homePath;
        if (!homePath) {
          return [];
        }
        return readGeminiExtensionsForAccount({
          accountKey: profile.key,
          accountAlias: profile.alias,
          extensionsRoot: path.join(homePath, ".gemini", "extensions"),
          skillState,
        });
      }),
    );
    return extensions.flat().sort((left, right) => {
      const byAccount = (left.accountAlias ?? "").localeCompare(right.accountAlias ?? "");
      return byAccount || left.id.localeCompare(right.id);
    });
  }

  private resolveProviderRoot(provider: AgentProvider): string {
    return getProviderRoot(this.paseoHome, provider);
  }

  private async resolveProviderProfile(provider: AgentProvider, accountKey: string) {
    const profiles = await this.providerAuthService.listProfiles(provider);
    const profile = profiles.find((candidate) => candidate.key === accountKey);
    if (!profile) {
      throw new Error(`Provider account '${accountKey}' was not found`);
    }
    return profile;
  }

  private resolveConfigPath(provider: AgentProvider): string {
    return resolveProviderNativeConfigPath(this.resolveProviderRoot(provider), provider);
  }

  private resolveNativeConfigPath(provider: AgentProvider): string {
    if (provider === "codex") {
      return resolveProviderHomeNativeConfigPath(provider, this.codexNativeHomeResolver());
    }
    if (provider === "gemini") {
      return resolveProviderHomeNativeConfigPath(provider, this.geminiNativeHomeResolver());
    }
    if (provider === "opencode") {
      return resolveOpenCodeConfigPath(
        path.join(this.opencodeNativeConfigHomeResolver(), "opencode"),
      );
    }
    throw new Error(`Native config sync is not supported for provider '${provider}'`);
  }

  private parseNativeMcpConfig(provider: AgentProvider, content: string) {
    if (provider === "codex") {
      return parseCodexNativeMcpConfigToml(content);
    }
    if (provider === "gemini") {
      return parseGeminiNativeMcpConfigJson(content);
    }
    if (provider === "opencode") {
      return parseOpenCodeNativeMcpConfigJson(content);
    }
    throw new Error(`Native MCP editing is not supported for provider '${provider}'`);
  }

  private preserveManagedMcpServers(
    provider: AgentProvider,
    syncedContent: string,
    existingContent: string | null,
  ): string {
    if (!existingContent) {
      return syncedContent;
    }
    let nextContent = syncedContent;
    for (const server of this.parseNativeMcpConfig(provider, existingContent).servers) {
      nextContent = this.writeNativeMcpServerConfig({
        provider,
        content: nextContent,
        id: server.id,
        config: server.config,
        enabled: server.enabled,
      });
    }
    return nextContent;
  }

  private writeNativeMcpServerConfig(input: {
    provider: AgentProvider;
    content: string;
    id: string;
    config: McpServerConfig;
    enabled: boolean;
  }): string {
    if (input.provider === "codex") {
      return writeCodexNativeMcpServerConfig(input);
    }
    if (input.provider === "gemini") {
      return writeGeminiNativeMcpServerConfig(input);
    }
    if (input.provider === "opencode") {
      return writeOpenCodeNativeMcpServerConfig(input);
    }
    throw new Error(`Native MCP editing is not supported for provider '${input.provider}'`);
  }

  private removeNativeMcpServerConfig(
    provider: AgentProvider,
    content: string,
    id: string,
  ): string {
    if (provider === "codex") {
      return removeCodexNativeMcpServerConfig(content, id);
    }
    if (provider === "gemini") {
      return removeGeminiNativeMcpServerConfig(content, id);
    }
    if (provider === "opencode") {
      return removeOpenCodeNativeMcpServerConfig(content, id);
    }
    throw new Error(`Native MCP editing is not supported for provider '${provider}'`);
  }
}

function resolveDefaultCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
}

function resolveDefaultGeminiHome(): string {
  return path.resolve(path.join(homedir(), ".gemini"));
}

function resolveDefaultOpenCodeConfigHome(): string {
  return path.resolve(path.join(homedir(), ".config"));
}

async function readGeminiExtensionsForAccount(input: {
  accountKey: string;
  accountAlias: string;
  extensionsRoot: string;
  skillState: GeminiSkillState;
}): Promise<ProviderNativeExtension[]> {
  const entries = await fs.readdir(input.extensionsRoot, { withFileTypes: true }).catch(() => []);
  const enablement = await readJsonObject(
    path.join(input.extensionsRoot, "extension-enablement.json"),
  );
  const extensions: ProviderNativeExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const extensionPath = path.join(input.extensionsRoot, entry.name);
    const manifest = await readJsonObject(path.join(extensionPath, "gemini-extension.json"));
    extensions.push({
      id: entry.name,
      name: readString(manifest?.name),
      version: readString(manifest?.version),
      path: extensionPath,
      enabled: resolveGeminiExtensionEnabled(enablement?.[entry.name]),
      contextFileName: readString(manifest?.contextFileName),
      accountKey: input.accountKey,
      accountAlias: input.accountAlias,
      ...formatGeminiExtensionSkills(
        await readGeminiExtensionSkillIds(extensionPath),
        input.skillState,
      ),
    });
  }
  return extensions;
}

function resolveGeminiExtensionEnabled(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const enabled = record.enabled;
    if (typeof enabled === "boolean") {
      return enabled;
    }
    const overrides = readStringArray(record.overrides);
    if (overrides.length === 0) {
      return true;
    }
    const lastOverride = overrides[overrides.length - 1]?.trim();
    return lastOverride ? !lastOverride.startsWith("!") : true;
  }
  return value === undefined ? undefined : true;
}

interface GeminiSkillState {
  enabled: boolean;
  disabledIds: Set<string>;
}

async function readGeminiSkillState(configPath: string): Promise<GeminiSkillState> {
  const settings = await readJsonObject(configPath);
  const skills = readRecord(settings?.skills);
  return {
    enabled: skills?.enabled !== false,
    disabledIds: new Set(readStringArray(skills?.disabled)),
  };
}

function formatGeminiExtensionSkills(skillIds: string[], skillState: GeminiSkillState) {
  return {
    skillIds,
    skills: skillIds.map((id) => ({
      id,
      enabled: skillState.enabled && !skillState.disabledIds.has(id),
    })),
  };
}

async function writeGeminiExtensionEnabled(input: {
  extensionsRoot: string;
  extensionId: string;
  enabled: boolean;
}): Promise<void> {
  const configPath = path.join(input.extensionsRoot, "extension-enablement.json");
  const config = (await readJsonObject(configPath)) ?? {};
  const existing = readRecord(config[input.extensionId]) ?? {};
  config[input.extensionId] = {
    ...existing,
    overrides: [input.enabled ? "/*" : "!/*"],
  };
  delete (config[input.extensionId] as Record<string, unknown>).enabled;
  await writeJsonObject(configPath, config);
}

function setGeminiSkillEnabled(content: string, skillId: string, enabled: boolean): string {
  const settings = parseJsonObject(content, "Gemini settings.json");
  const skills = ensureRecord(settings, "skills");
  const disabled = new Set(readStringArray(skills.disabled));
  if (enabled) {
    disabled.delete(skillId);
    skills.enabled = true;
  } else {
    disabled.add(skillId);
  }
  if (disabled.size > 0) {
    skills.disabled = Array.from(disabled).sort();
  } else {
    delete skills.disabled;
  }
  if (Object.keys(skills).length === 0) {
    delete settings.skills;
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

async function readGeminiExtensionSkillIds(extensionPath: string): Promise<string[]> {
  const ids = new Set<string>();
  await walkFiles(extensionPath, async (filePath) => {
    const relativePath = path.relative(extensionPath, filePath);
    const segments = relativePath.split(path.sep);
    if (
      segments.length >= 3 &&
      segments[0] === "skills" &&
      segments[segments.length - 1]?.toLowerCase() === "skill.md"
    ) {
      ids.add(segments[1]);
      return;
    }
    const basename = path.basename(filePath).replace(/\.[^.]+$/, "");
    if (/^(gws|recipe|persona)-[a-z0-9-]+$/i.test(basename)) {
      ids.add(basename);
    }
  });
  return [...ids].sort();
}

async function walkFiles(
  root: string,
  visit: (filePath: string) => Promise<void>,
  depth = 0,
): Promise<void> {
  if (depth > 5) {
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, visit, depth + 1);
      continue;
    }
    if (entry.isFile()) {
      await visit(fullPath);
    }
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!raw) {
    return null;
  }
  try {
    return parseJsonObject(raw, filePath);
  } catch {
    return null;
  }
}

async function writeJsonObject(filePath: string, value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  if (!content.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ensureRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = readRecord(record[key]);
  if (existing) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  record[key] = next;
  return next;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
