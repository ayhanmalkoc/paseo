import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentProvider } from "./agent-sdk-types.js";

const CODEX_CONFIG_FILENAME = "config.toml";

export function resolveProviderNativeConfigPath(
  providerRoot: string,
  provider: AgentProvider,
): string {
  if (provider === "codex") {
    return path.join(providerRoot, "config", CODEX_CONFIG_FILENAME);
  }
  throw new Error(`Native config is not supported for provider '${provider}'`);
}

export function resolveProviderHomeNativeConfigPath(
  provider: AgentProvider,
  providerHomePath: string,
): string {
  if (provider === "codex") {
    return path.join(providerHomePath, CODEX_CONFIG_FILENAME);
  }
  throw new Error(`Native config is not supported for provider '${provider}'`);
}

export async function seedProviderNativeConfigFromHome(input: {
  provider: AgentProvider;
  providerRoot: string;
  sourceHomePath: string;
}): Promise<boolean> {
  const targetPath = resolveProviderNativeConfigPath(input.providerRoot, input.provider);
  try {
    await fs.access(targetPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const sourcePath = resolveProviderHomeNativeConfigPath(input.provider, input.sourceHomePath);
  let content: string;
  try {
    content = await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, normalizeConfigContent(content), "utf8");
  return true;
}

export async function materializeProviderNativeConfigToHome(input: {
  provider: AgentProvider;
  providerRoot: string;
  providerHomePath: string;
}): Promise<boolean> {
  const sourcePath = resolveProviderNativeConfigPath(input.providerRoot, input.provider);
  let content: string;
  try {
    content = await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const targetPath = resolveProviderHomeNativeConfigPath(input.provider, input.providerHomePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, normalizeConfigContent(content), "utf8");
  return true;
}

export function normalizeConfigContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
