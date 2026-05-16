import { homedir } from "node:os";
import path from "node:path";

import { findExecutable } from "../../../../utils/executable.js";

export async function resolveOpenCodeBinary(): Promise<string> {
  const fromPath = await findExecutable("opencode");
  if (fromPath) {
    return fromPath;
  }
  const installed = await findExecutable(resolveOpenCodeInstalledBinaryCandidate());
  if (installed) {
    return installed;
  }
  throw new Error(
    "OpenCode binary not found. Install OpenCode and ensure it is available in PATH or at ~/.opencode/bin/opencode.",
  );
}

export async function findOpenCodeBinary(): Promise<string | null> {
  try {
    return await resolveOpenCodeBinary();
  } catch {
    return null;
  }
}

function resolveOpenCodeInstalledBinaryCandidate(): string {
  return path.join(
    homedir(),
    ".opencode",
    "bin",
    process.platform === "win32" ? "opencode.cmd" : "opencode",
  );
}
