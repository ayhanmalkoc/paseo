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
  let providerConfigPath: string;
  let providerHooksPath: string;
  let nativeCodexHome: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "paseo-provider-native-config-"));
    providerHomePath = path.join(tempRoot, "providers", "codex", "accounts", "work", "home");
    providerConfigPath = path.join(tempRoot, "providers", "codex", "config", "config.toml");
    providerHooksPath = path.join(tempRoot, "providers", "codex", "config", "hooks.json");
    nativeCodexHome = path.join(tempRoot, "native-codex");
    await fs.mkdir(providerHomePath, { recursive: true });
    await fs.mkdir(nativeCodexHome, { recursive: true });
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
      paseoHome: tempRoot,
      logger: createTestLogger(),
      providerAuthService,
      codexNativeHomeResolver: () => nativeCodexHome,
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

    const snapshot = await service.readProviderConfig({
      provider: "codex",
    });

    expect(snapshot).toMatchObject({
      provider: "codex",
      path: providerConfigPath,
      content: "",
      exists: false,
    });
    expect(snapshot.updatedAt).toBeUndefined();
  });

  it("writes Codex config.toml into the provider config and materializes account homes", async () => {
    const service = createService();

    const snapshot = await service.writeProviderConfig({
      provider: "codex",
      content: '[mcp_servers.context-mode]\ncommand = "context-mode"\n',
    });

    expect(snapshot).toMatchObject({
      provider: "codex",
      exists: true,
      content: '[mcp_servers.context-mode]\ncommand = "context-mode"\n',
    });
    expect(snapshot.updatedAt).toBeDefined();
    await expect(fs.readFile(providerConfigPath, "utf8")).resolves.toBe(
      '[mcp_servers.context-mode]\ncommand = "context-mode"\n',
    );
    await expect(fs.readFile(path.join(providerHomePath, "config.toml"), "utf8")).resolves.toBe(
      '[mcp_servers.context-mode]\ncommand = "context-mode"\n',
    );
  });

  it("syncs Codex config.toml from the native Codex home into provider config", async () => {
    const service = createService();
    await fs.mkdir(path.dirname(providerConfigPath), { recursive: true });
    await fs.writeFile(providerConfigPath, '[mcp_servers.old]\ncommand = "old"\n');
    await fs.writeFile(providerHooksPath, '{"hooks":{"Stop":[]}}\n');
    const nativeHooksPath = path.join(nativeCodexHome, "hooks.json");
    const accountHooksPath = path.join(providerHomePath, "hooks.json");
    await fs.writeFile(
      path.join(nativeCodexHome, "config.toml"),
      `[hooks.state."${nativeHooksPath}:stop:0:0"]\ntrusted_hash = "abc"\n\n[mcp_servers.context-mode]\ncommand = "context-mode"\n`,
    );
    await fs.writeFile(
      nativeHooksPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "context-mode hook codex stop" }],
            },
          ],
        },
      }),
    );

    const snapshot = await service.syncProviderConfigFromNative({
      provider: "codex",
    });

    expect(snapshot).toMatchObject({
      provider: "codex",
      exists: true,
    });
    await expect(fs.readFile(providerConfigPath, "utf8")).resolves.toContain(
      `[hooks.state."${providerHooksPath}:stop:0:0"]`,
    );
    await expect(fs.readFile(providerConfigPath, "utf8")).resolves.not.toContain(nativeHooksPath);
    await expect(fs.readFile(providerHooksPath, "utf8")).resolves.toContain(
      "context-mode hook codex stop",
    );
    await expect(
      fs.readFile(path.join(providerHomePath, "config.toml"), "utf8"),
    ).resolves.toContain(`[hooks.state."${accountHooksPath}:stop:0:0"]`);
    await expect(
      fs.readFile(path.join(providerHomePath, "config.toml"), "utf8"),
    ).resolves.not.toContain(providerHooksPath);
    await expect(fs.readFile(accountHooksPath, "utf8")).resolves.toContain(
      "context-mode hook codex stop",
    );
  });

  it("manages Codex MCP servers inside provider config", async () => {
    const service = createService();

    const created = await service.upsertProviderMcpServer({
      provider: "codex",
      id: "context-mode",
      config: { type: "stdio", command: "context-mode" },
      enabled: false,
    });

    expect(created).toEqual({
      id: "context-mode",
      config: { type: "stdio", command: "context-mode" },
      enabled: false,
    });
    await expect(service.listProviderMcpServers({ provider: "codex" })).resolves.toEqual([created]);
    await expect(fs.readFile(providerConfigPath, "utf8")).resolves.toContain(
      "# [mcp_servers.context-mode]",
    );
    await expect(fs.readFile(providerConfigPath, "utf8")).resolves.not.toContain(
      "\n[mcp_servers.context-mode]",
    );

    const updated = await service.upsertProviderMcpServer({
      provider: "codex",
      id: "context-mode",
      config: { type: "stdio", command: "context-mode", args: ["serve"] },
    });

    expect(updated.enabled).toBe(false);
    expect(updated.config).toEqual({
      type: "stdio",
      command: "context-mode",
      args: ["serve"],
    });

    await expect(
      service.removeProviderMcpServer({
        provider: "codex",
        id: "context-mode",
      }),
    ).resolves.toBe(true);
    await expect(service.listProviderMcpServers({ provider: "codex" })).resolves.toEqual([]);
  });

  it("rejects unsupported providers", async () => {
    const service = createService();

    await expect(
      service.readProviderConfig({
        provider: "claude",
      }),
    ).rejects.toThrow("Native config is not supported");
  });
});
