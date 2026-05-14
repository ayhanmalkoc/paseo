import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ProviderAuthProfile } from "./agent-sdk-types.js";
import type { ProviderAuthService } from "./provider-auth-service.js";
import { ProviderNativeConfigService } from "./provider-native-config-service.js";

describe("ProviderNativeConfigService", () => {
  let tempRoot: string;
  let providerHomePath: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "paseo-provider-native-config-"));
    providerHomePath = path.join(tempRoot, "providers", "codex", "accounts", "work", "home");
    await fs.mkdir(providerHomePath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function createService(profiles: ProviderAuthProfile[] = [createProfile()]) {
    const providerAuthService = {
      listProfiles: async (provider?: string) =>
        profiles.filter((profile) => !provider || profile.provider === provider),
    } as unknown as ProviderAuthService;
    return new ProviderNativeConfigService({
      logger: createTestLogger(),
      providerAuthService,
    });
  }

  function createProfile(patch: Partial<ProviderAuthProfile> = {}): ProviderAuthProfile {
    return {
      provider: "codex",
      key: "work",
      alias: "Work",
      authMode: "chatgpt",
      status: "ready",
      createdAt: "2026-05-14T10:00:00.000Z",
      updatedAt: "2026-05-14T10:00:00.000Z",
      providerHomeRef: {
        kind: "managed-profile",
        provider: "codex",
        profileKey: "work",
        homePath: providerHomePath,
        label: "Work",
      },
      ...patch,
    };
  }

  it("reads missing Codex config as an empty snapshot", async () => {
    const service = createService();

    const snapshot = await service.readAccountConfig({
      provider: "codex",
      profileKey: "work",
    });

    expect(snapshot).toMatchObject({
      provider: "codex",
      profileKey: "work",
      path: path.join(providerHomePath, "config.toml"),
      content: "",
      exists: false,
    });
    expect(snapshot.updatedAt).toBeUndefined();
  });

  it("writes Codex config.toml into the managed account home", async () => {
    const service = createService();

    const snapshot = await service.writeAccountConfig({
      provider: "codex",
      profileKey: "work",
      content: '[mcp_servers.context-mode]\ncommand = "context-mode"\n',
    });

    expect(snapshot).toMatchObject({
      provider: "codex",
      profileKey: "work",
      exists: true,
      content: '[mcp_servers.context-mode]\ncommand = "context-mode"\n',
    });
    expect(snapshot.updatedAt).toBeDefined();
    await expect(fs.readFile(path.join(providerHomePath, "config.toml"), "utf8")).resolves.toBe(
      '[mcp_servers.context-mode]\ncommand = "context-mode"\n',
    );
  });

  it("rejects unsupported providers and accounts without managed homes", async () => {
    const service = createService([
      createProfile({
        provider: "claude",
        key: "claude-work",
        providerHomeRef: undefined,
      }),
    ]);

    await expect(
      service.readAccountConfig({
        provider: "claude",
        profileKey: "claude-work",
      }),
    ).rejects.toThrow("does not have a managed provider home");
  });
});
