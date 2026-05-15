import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { AgentProvider, McpServerConfig } from "./agent-sdk-types.js";
import {
  parseCodexNativeMcpConfigToml,
  removeCodexNativeMcpServerConfig,
  writeCodexNativeMcpServerConfig,
} from "./mcp-native-import.js";
import type { ProviderAuthService } from "./provider-auth-service.js";
import {
  materializeProviderNativeConfigToHome,
  normalizeConfigContent,
  normalizeProviderNativeConfigContentFromHome,
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

  constructor(options: {
    paseoHome: string;
    logger: Logger;
    providerAuthService: ProviderAuthService;
    codexNativeHomeResolver?: () => string;
  }) {
    this.logger = options.logger.child({ module: "provider-native-config" });
    this.paseoHome = options.paseoHome;
    this.providerAuthService = options.providerAuthService;
    this.codexNativeHomeResolver = options.codexNativeHomeResolver ?? resolveDefaultCodexHome;
  }

  getSupportedProviders(): AgentProvider[] {
    return ["codex"];
  }

  async readProviderConfig(input: {
    provider: AgentProvider;
  }): Promise<ProviderNativeConfigSnapshot> {
    const configPath = this.resolveConfigPath(input.provider);
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
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      normalizeProviderNativeConfigContentFromHome({
        content,
        provider: input.provider,
        providerRoot: this.resolveProviderRoot(input.provider),
        sourceHomePath: path.dirname(sourcePath),
      }),
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
    return parseCodexNativeMcpConfigToml(config.content).servers.map((server) => ({
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
      parseCodexNativeMcpConfigToml(snapshot.content).servers.find(
        (server) => server.id === input.id,
      )?.enabled ??
      true;
    const content = writeCodexNativeMcpServerConfig({
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
    const existed = parseCodexNativeMcpConfigToml(snapshot.content).servers.some(
      (server) => server.id === input.id,
    );
    const content = removeCodexNativeMcpServerConfig(snapshot.content, input.id);
    await this.writeProviderConfig({
      provider: input.provider,
      content,
    });
    return existed;
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

  private resolveProviderRoot(provider: AgentProvider): string {
    return getProviderRoot(this.paseoHome, provider);
  }

  private resolveConfigPath(provider: AgentProvider): string {
    return resolveProviderNativeConfigPath(this.resolveProviderRoot(provider), provider);
  }

  private resolveNativeConfigPath(provider: AgentProvider): string {
    if (provider === "codex") {
      return resolveProviderHomeNativeConfigPath(provider, this.codexNativeHomeResolver());
    }
    throw new Error(`Native config sync is not supported for provider '${provider}'`);
  }
}

function resolveDefaultCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
}
