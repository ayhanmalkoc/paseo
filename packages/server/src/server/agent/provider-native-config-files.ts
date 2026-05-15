import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentProvider } from "./agent-sdk-types.js";

const CODEX_CONFIG_FILENAME = "config.toml";
const CODEX_HOOKS_FILENAME = "hooks.json";

export function resolveProviderNativeConfigPath(
  providerRoot: string,
  provider: AgentProvider,
): string {
  if (provider === "codex") {
    return path.join(providerRoot, "config", CODEX_CONFIG_FILENAME);
  }
  throw new Error(`Native config is not supported for provider '${provider}'`);
}

export function resolveProviderNativeHooksPath(
  providerRoot: string,
  provider: AgentProvider,
): string {
  if (provider === "codex") {
    return path.join(providerRoot, "config", CODEX_HOOKS_FILENAME);
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

export function resolveProviderHomeNativeHooksPath(
  provider: AgentProvider,
  providerHomePath: string,
): string {
  if (provider === "codex") {
    return path.join(providerHomePath, CODEX_HOOKS_FILENAME);
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
    await seedProviderNativeHooksFromHome(input);
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
  await fs.writeFile(
    targetPath,
    normalizeProviderNativeConfigContentFromHome({
      content,
      provider: input.provider,
      providerRoot: input.providerRoot,
      sourceHomePath: input.sourceHomePath,
    }),
    "utf8",
  );
  await seedProviderNativeHooksFromHome(input);
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
  await fs.writeFile(
    targetPath,
    materializeConfigContent({
      content,
      provider: input.provider,
      providerRoot: input.providerRoot,
      providerHomePath: input.providerHomePath,
    }),
    "utf8",
  );
  await materializeProviderNativeHooksToHome(input);
  return true;
}

export function normalizeConfigContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function normalizeProviderNativeConfigContentFromHome(input: {
  content: string;
  provider: AgentProvider;
  providerRoot: string;
  sourceHomePath: string;
}): string {
  let content = normalizeConfigContent(input.content);
  if (input.provider === "codex") {
    content = rewriteCodexHookStatePaths({
      content,
      fromHooksPath: resolveProviderHomeNativeHooksPath(input.provider, input.sourceHomePath),
      toHooksPath: resolveProviderNativeHooksPath(input.providerRoot, input.provider),
    });
  }
  return content;
}

export async function syncProviderNativeHooksFromHome(input: {
  provider: AgentProvider;
  providerRoot: string;
  sourceHomePath: string;
}): Promise<boolean> {
  const sourcePath = resolveProviderHomeNativeHooksPath(input.provider, input.sourceHomePath);
  const targetPath = resolveProviderNativeHooksPath(input.providerRoot, input.provider);
  return copyOptionalFile(sourcePath, targetPath, { overwrite: true });
}

async function seedProviderNativeHooksFromHome(input: {
  provider: AgentProvider;
  providerRoot: string;
  sourceHomePath: string;
}): Promise<boolean> {
  const sourcePath = resolveProviderHomeNativeHooksPath(input.provider, input.sourceHomePath);
  const targetPath = resolveProviderNativeHooksPath(input.providerRoot, input.provider);
  return copyOptionalFile(sourcePath, targetPath, { overwrite: false });
}

async function materializeProviderNativeHooksToHome(input: {
  provider: AgentProvider;
  providerRoot: string;
  providerHomePath: string;
}): Promise<boolean> {
  const sourcePath = resolveProviderNativeHooksPath(input.providerRoot, input.provider);
  const targetPath = resolveProviderHomeNativeHooksPath(input.provider, input.providerHomePath);
  return copyOptionalFile(sourcePath, targetPath, { overwrite: true });
}

async function copyOptionalFile(
  sourcePath: string,
  targetPath: string,
  options: { overwrite: boolean },
): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (!options.overwrite) {
    try {
      await fs.access(targetPath);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, normalizeConfigContent(content), "utf8");
  return true;
}

function materializeConfigContent(input: {
  content: string;
  provider: AgentProvider;
  providerRoot: string;
  providerHomePath: string;
}): string {
  let content = normalizeConfigContent(input.content);
  if (input.provider === "codex") {
    content = rewriteCodexHookStatePaths({
      content,
      fromHooksPath: resolveProviderNativeHooksPath(input.providerRoot, input.provider),
      toHooksPath: resolveProviderHomeNativeHooksPath(input.provider, input.providerHomePath),
    });
  }
  return content;
}

function rewriteCodexHookStatePaths(input: {
  content: string;
  fromHooksPath: string;
  toHooksPath: string;
}): string {
  return input.content.replaceAll(
    `hooks.state."${input.fromHooksPath}:`,
    `hooks.state."${input.toHooksPath}:`,
  );
}
