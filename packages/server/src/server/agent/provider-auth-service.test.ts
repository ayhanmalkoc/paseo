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
  readonly supportsCurrentAuthSync = true;

  currentKey = "profile-a";
  currentAlias = "primary";
  currentEmail = "user@example.com";
  missingCurrent = false;
  currentError: Error | null = null;

  async importCurrent(
    context: ProviderAuthAdapterContext,
    options?: { alias?: string },
  ): Promise<StoredProviderAuthProfile> {
    if (this.currentError) {
      throw this.currentError;
    }
    if (this.missingCurrent) {
      const error = new Error("missing auth") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    const now = context.now().toISOString();
    const profileRoot = path.join(context.providerBaseDir, "profiles", this.currentKey);
    const providerHomePath = path.join(profileRoot, "codex-home");
    await fs.mkdir(providerHomePath, { recursive: true });
    await fs.writeFile(path.join(providerHomePath, "auth.json"), this.currentKey, "utf8");
    return {
      provider: "codex",
      key: this.currentKey,
      alias: options?.alias ?? this.currentAlias,
      email: this.currentEmail,
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
        primaryWindowMinutes: 300,
        primaryResetsAt: "2026-05-06T13:30:00.000Z",
        limitState: "ok",
        refreshedAt: "2026-05-06T12:30:00.000Z",
      },
    };
  }

  resolveLaunchContext(profile: StoredProviderAuthProfile) {
    return {
      profileKey: profile.key,
      providerHomeRef: {
        kind: "managed-profile" as const,
        provider: "codex" as const,
        profileKey: profile.key,
        label: profile.alias,
      },
      env: {
        CODEX_HOME: profile.providerHomePath,
      },
      metadata: {
        providerHomeRef: {
          kind: "managed-profile" as const,
          provider: "codex" as const,
          profileKey: profile.key,
          label: profile.alias,
        },
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

  function createService(adapter = new FakeAuthAdapter()) {
    return new ProviderAuthService({
      paseoHome,
      logger: createTestLogger(),
      adapters: [adapter],
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

    const nativeLaunchContext = await service.resolveLaunchContext({ provider: "codex" });
    expect(nativeLaunchContext.profileKey).toBeNull();
    expect(nativeLaunchContext.providerHomeRef.kind).toBe("native-default");

    const launchContext = await service.resolveLaunchContext({
      provider: "codex",
      providerHomeRef: profile.providerHomeRef,
    });
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
    expect(refreshed.usage?.primaryWindowMinutes).toBe(300);
    expect(refreshed.usage?.primaryResetsAt).toBe("2026-05-06T13:30:00.000Z");
    expect(refreshed.usage?.limitState).toBe("ok");

    const launchContext = await service.resolveLaunchContext({
      provider: "codex",
      providerHomeRef: refreshed.providerHomeRef,
    });
    const codexHome = launchContext.env?.CODEX_HOME;
    expect(codexHome).toBeTruthy();

    await service.removeProfile("codex", "profile-a");
    expect(await service.listProfiles("codex")).toEqual([]);
    await expect(fs.stat(path.dirname(codexHome!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("syncs current auth idempotently without changing an existing default", async () => {
    const adapter = new FakeAuthAdapter();
    const service = createService(adapter);

    const firstSync = await service.syncCurrentProfile("codex");
    expect(firstSync.status).toBe("created");
    expect(firstSync.profile).toMatchObject({
      key: "profile-a",
      alias: "primary",
      isDefault: true,
    });

    const secondSync = await service.syncCurrentProfile("codex");
    expect(secondSync.status).toBe("unchanged");
    expect(await service.listProfiles("codex")).toHaveLength(1);

    adapter.currentKey = "profile-b";
    adapter.currentAlias = "secondary";
    adapter.currentEmail = "other@example.com";
    const thirdSync = await service.syncCurrentProfile("codex");
    expect(thirdSync.status).toBe("created");

    const profiles = await service.listProfiles("codex");
    expect(profiles.map((profile) => profile.key).sort()).toEqual(["profile-a", "profile-b"]);
    expect(profiles.find((profile) => profile.key === "profile-a")?.isDefault).toBe(true);
    expect(profiles.find((profile) => profile.key === "profile-b")?.isDefault).toBe(false);
  });

  it("keeps stored profiles when current auth is missing or invalid", async () => {
    const adapter = new FakeAuthAdapter();
    const service = createService(adapter);
    await service.syncCurrentProfile("codex");

    adapter.missingCurrent = true;
    const missing = await service.syncCurrentProfile("codex");
    expect(missing.status).toBe("missing-auth");
    expect(await service.listProfiles("codex")).toHaveLength(1);

    adapter.missingCurrent = false;
    adapter.currentError = new Error("invalid current auth");
    const failed = await service.syncCurrentProfile("codex");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("invalid current auth");
    expect(await service.listProfiles("codex")).toHaveLength(1);
  });
});
