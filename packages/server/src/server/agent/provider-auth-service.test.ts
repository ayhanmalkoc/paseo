import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  ProviderAuthAdapter,
  ProviderAuthAdapterContext,
  StoredProviderAuthProfile,
} from "./provider-auth-service.js";
import { ProviderAuthService } from "./provider-auth-service.js";

class FakeAuthAdapter implements ProviderAuthAdapter {
  readonly provider = "codex" as const;

  async importCurrent(
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile> {
    const now = context.now().toISOString();
    const profileRoot = path.join(context.providerBaseDir, "profiles", "profile-a");
    const providerHomePath = path.join(profileRoot, "codex-home");
    await fs.mkdir(providerHomePath, { recursive: true });
    await fs.writeFile(path.join(providerHomePath, "auth.json"), "secret", "utf8");
    return {
      provider: "codex",
      key: "profile-a",
      alias: options?.alias ?? "primary",
      email: "user@example.com",
      authMode: "chatgpt",
      status: "ready",
      createdAt: now,
      updatedAt: now,
      providerHomePath,
    };
  }

  async importAuthFile(
    _authFilePath: string,
    context: ProviderAuthAdapterContext,
  ): Promise<StoredProviderAuthProfile> {
    return this.importCurrent(context, { alias: "from-file" });
  }

  async refreshProfile(profile: StoredProviderAuthProfile): Promise<StoredProviderAuthProfile> {
    return {
      ...profile,
      plan: "plus",
      usage: {
        source: "provider-api",
        primaryUsedPercent: 12,
        refreshedAt: "2026-05-06T12:30:00.000Z",
      },
    };
  }

  resolveLaunchContext(profile: StoredProviderAuthProfile) {
    return {
      profileKey: profile.key,
      env: {
        CODEX_HOME: profile.providerHomePath,
      },
    };
  }
}

describe("ProviderAuthService", () => {
  let paseoHome: string;

  beforeEach(() => {
    paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-auth-"));
  });

  afterEach(() => {
    rmSync(paseoHome, { recursive: true, force: true });
  });

  function createService() {
    return new ProviderAuthService({
      paseoHome,
      logger: createTestLogger(),
      adapters: [new FakeAuthAdapter()],
      now: () => new Date("2026-05-06T12:00:00.000Z"),
    });
  }

  it("imports profiles, exposes sanitized metadata, and resolves launch env", async () => {
    const service = createService();
    const profile = await service.importProfile({
      provider: "codex",
      source: "current",
      alias: "work",
    });

    expect(profile).toMatchObject({
      provider: "codex",
      key: "profile-a",
      alias: "work",
      email: "user@example.com",
      authMode: "chatgpt",
      status: "ready",
      isDefault: true,
    });
    expect(profile).not.toHaveProperty("providerHomePath");

    const launchContext = await service.resolveLaunchContext({ provider: "codex" });
    expect(launchContext.profileKey).toBe("profile-a");
    expect(launchContext.env?.CODEX_HOME).toContain(path.join("profiles", "profile-a"));

    const listed = await service.listProfiles("codex");
    expect(listed[0]?.lastUsedAt).toBe("2026-05-06T12:00:00.000Z");
  });

  it("refreshes profile usage and removes isolated auth files", async () => {
    const service = createService();
    await service.importProfile({ provider: "codex", source: "current" });

    const refreshed = await service.refreshProfile("codex", "profile-a");
    expect(refreshed.plan).toBe("plus");
    expect(refreshed.usage?.primaryUsedPercent).toBe(12);

    const launchContext = await service.resolveLaunchContext({ provider: "codex" });
    const codexHome = launchContext.env?.CODEX_HOME;
    expect(codexHome).toBeTruthy();

    await service.removeProfile("codex", "profile-a");
    expect(await service.listProfiles("codex")).toEqual([]);
    await expect(fs.stat(path.dirname(codexHome!))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
