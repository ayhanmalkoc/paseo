import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ProcessEnvRecord } from "../../../paseo-env.js";

export interface OpenCodeManagedRoots {
  providerRoot: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgStateHome: string;
  storageRoot: string;
  envOverlay: ProcessEnvRecord;
}

interface OpenCodeNativeRoots {
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgStateHome: string;
}

export function resolveOpenCodeManagedRoots(paseoHome: string): OpenCodeManagedRoots {
  const providerRoot = path.join(paseoHome, "providers", "opencode");
  const xdgConfigHome = path.join(providerRoot, "config");
  const xdgDataHome = path.join(providerRoot, "data");
  const xdgStateHome = path.join(providerRoot, "state");
  return {
    providerRoot,
    xdgConfigHome,
    xdgDataHome,
    xdgStateHome,
    storageRoot: path.join(xdgDataHome, "opencode", "storage"),
    envOverlay: {
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_STATE_HOME: xdgStateHome,
    },
  };
}

export async function ensureOpenCodeManagedRoots(input: {
  roots: OpenCodeManagedRoots;
  nativeRoots?: OpenCodeNativeRoots;
}): Promise<void> {
  const nativeRoots = input.nativeRoots ?? resolveNativeOpenCodeRoots();
  await Promise.all([
    fs.mkdir(input.roots.xdgConfigHome, { recursive: true }),
    fs.mkdir(input.roots.xdgDataHome, { recursive: true }),
    fs.mkdir(input.roots.xdgStateHome, { recursive: true }),
  ]);
  await Promise.all([
    copyMissingDirectoryEntries(
      path.join(nativeRoots.xdgConfigHome, "opencode"),
      path.join(input.roots.xdgConfigHome, "opencode"),
    ),
    copyMissingDirectoryEntries(
      path.join(nativeRoots.xdgDataHome, "opencode"),
      path.join(input.roots.xdgDataHome, "opencode"),
    ),
    fs.mkdir(path.join(input.roots.xdgStateHome, "opencode"), { recursive: true }),
  ]);
  await syncOpenCodeAuthFile(
    path.join(nativeRoots.xdgDataHome, "opencode", "auth.json"),
    path.join(input.roots.xdgDataHome, "opencode", "auth.json"),
  );
}

function resolveNativeOpenCodeRoots(): OpenCodeNativeRoots {
  return {
    xdgConfigHome: resolveXdgHome("XDG_CONFIG_HOME", ".config"),
    xdgDataHome: resolveXdgHome("XDG_DATA_HOME", path.join(".local", "share")),
    xdgStateHome: resolveXdgHome("XDG_STATE_HOME", path.join(".local", "state")),
  };
}

function resolveXdgHome(
  envKey: "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME",
  fallback: string,
): string {
  const value = process.env[envKey];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return path.join(homedir(), fallback);
}

async function copyMissingDirectoryEntries(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  try {
    await fs.mkdir(targetPath, { recursive: true });
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    const copied = await Promise.all(
      entries.map((entry) =>
        copyMissingDirectoryEntry({
          sourcePath: path.join(sourcePath, entry.name),
          targetPath: path.join(targetPath, entry.name),
          isDirectory: entry.isDirectory(),
        }),
      ),
    );
    return copied.some(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function copyMissingDirectoryEntry(input: {
  sourcePath: string;
  targetPath: string;
  isDirectory: boolean;
}): Promise<boolean> {
  if (input.isDirectory) {
    return copyMissingDirectoryEntries(input.sourcePath, input.targetPath);
  }

  try {
    await fs.access(input.targetPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.copyFile(input.sourcePath, input.targetPath);
  return true;
}

async function syncOpenCodeAuthFile(sourcePath: string, targetPath: string): Promise<void> {
  const nativeAuth = await readJsonRecord(sourcePath);
  if (!nativeAuth) {
    return;
  }
  const managedAuth = (await readJsonRecord(targetPath)) ?? {};
  const mergedAuth = { ...managedAuth, ...nativeAuth };
  const nextContents = `${JSON.stringify(mergedAuth, null, 2)}\n`;
  try {
    const currentContents = await fs.readFile(targetPath, "utf8");
    if (currentContents === nextContents) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, nextContents);
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
