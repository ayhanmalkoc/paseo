import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { ProviderAuthService } from "./provider-auth-service.js";

const CODEX_CONFIG_FILENAME = "config.toml";

export interface ProviderNativeConfigSnapshot {
  provider: AgentProvider;
  profileKey: string;
  path: string;
  content: string;
  exists: boolean;
  updatedAt?: string;
}

export class ProviderNativeConfigService {
  private readonly logger: Logger;
  private readonly providerAuthService: ProviderAuthService;

  constructor(options: { logger: Logger; providerAuthService: ProviderAuthService }) {
    this.logger = options.logger.child({ module: "provider-native-config" });
    this.providerAuthService = options.providerAuthService;
  }

  getSupportedProviders(): AgentProvider[] {
    return ["codex"];
  }

  async readAccountConfig(input: {
    provider: AgentProvider;
    profileKey: string;
  }): Promise<ProviderNativeConfigSnapshot> {
    const profile = await this.requireProfile(input.provider, input.profileKey);
    const configPath = this.resolveConfigPath(input.provider, profile.providerHomePath);
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(configPath, "utf8"),
        fs.stat(configPath),
      ]);
      return {
        provider: input.provider,
        profileKey: input.profileKey,
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
        profileKey: input.profileKey,
        path: configPath,
        content: "",
        exists: false,
      };
    }
  }

  async writeAccountConfig(input: {
    provider: AgentProvider;
    profileKey: string;
    content: string;
  }): Promise<ProviderNativeConfigSnapshot> {
    const profile = await this.requireProfile(input.provider, input.profileKey);
    const configPath = this.resolveConfigPath(input.provider, profile.providerHomePath);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, normalizeConfigContent(input.content), "utf8");
    return this.readAccountConfig(input);
  }

  private async requireProfile(provider: AgentProvider, profileKey: string) {
    const profiles = await this.providerAuthService.listProfiles(provider);
    const profile = profiles.find((candidate) => candidate.key === profileKey);
    if (!profile) {
      throw new Error(`Provider account '${profileKey}' was not found`);
    }
    if (!profile.providerHomeRef?.homePath) {
      throw new Error(`Provider account '${profileKey}' does not have a managed provider home`);
    }
    return {
      ...profile,
      providerHomePath: profile.providerHomeRef.homePath,
    };
  }

  private resolveConfigPath(provider: AgentProvider, providerHomePath: string): string {
    if (provider === "codex") {
      return path.join(providerHomePath, CODEX_CONFIG_FILENAME);
    }
    throw new Error(`Native config is not supported for provider '${provider}'`);
  }
}

function normalizeConfigContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
