import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { CodexProviderAuthAdapter, parseCodexAuthJson } from "./provider-auth-codex.js";

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${encoded}.signature`;
}

describe("parseCodexAuthJson", () => {
  it("detects API key auth without exposing the secret", () => {
    const parsed = parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: "sk-test-secret" }));

    expect(parsed.authMode).toBe("api-key");
    expect(parsed.alias).toBe("Codex API key");
    expect(parsed.key).toMatch(/^codex-api-/);
    expect(parsed.key).not.toContain("sk-test-secret");
  });

  it("extracts ChatGPT account metadata from Codex tokens", () => {
    const idToken = jwtWithPayload({
      email: "USER@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
        chatgpt_user_id: "user_123",
        chatgpt_plan_type: "plus",
      },
    });

    const parsed = parseCodexAuthJson(
      JSON.stringify({
        tokens: {
          id_token: idToken,
          account_id: "acct_123",
        },
        last_refresh: "2026-05-06T10:00:00.000Z",
      }),
    );

    expect(parsed).toMatchObject({
      alias: "user",
      email: "user@example.com",
      accountId: "acct_123",
      userId: "user_123",
      authMode: "chatgpt",
      plan: "plus",
      lastRefresh: "2026-05-06T10:00:00.000Z",
    });
    expect(parsed.key).toMatch(/^codex-/);
  });
});

describe("CodexProviderAuthAdapter", () => {
  function createContext(providerBaseDir: string) {
    return {
      providerBaseDir,
      now: () => new Date("2026-05-06T12:00:00.000Z"),
      logger: createTestLogger(),
    };
  }

  it("imports auth into an isolated Codex home", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-codex-auth-"));
    try {
      const sourceHome = path.join(root, "source-codex");
      const providerBaseDir = path.join(root, "providers", "codex");
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(
        path.join(sourceHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-test-secret" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(sourceHome, "config.toml"),
        `[hooks.state."${path.join(sourceHome, "hooks.json")}:stop:0:0"]\ntrusted_hash = "abc"\n\nmodel = "gpt-5.4"\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(sourceHome, "hooks.json"),
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
        "utf8",
      );

      const adapter = new CodexProviderAuthAdapter({
        usageReader: async () => {
          throw new Error("import should not refresh usage");
        },
      });
      const profile = await adapter.importAuthFile(
        path.join(sourceHome, "auth.json"),
        createContext(providerBaseDir),
      );

      expect(profile.providerHomePath).toContain(path.join("providers", "codex", "accounts"));
      expect(profile.providerHomePath).toMatch(new RegExp(`${path.sep}home$`));
      expect(profile.usage).toBeUndefined();
      await expect(
        fs.readFile(path.join(profile.providerHomePath, "auth.json"), "utf8"),
      ).resolves.toContain("sk-test-secret");
      await expect(
        fs.readFile(path.join(profile.providerHomePath, "config.toml"), "utf8"),
      ).resolves.toContain("gpt-5.4");
      await expect(
        fs.readFile(path.join(profile.providerHomePath, "config.toml"), "utf8"),
      ).resolves.toContain(
        `[hooks.state."${path.join(profile.providerHomePath, "hooks.json")}:stop:0:0"]`,
      );
      await expect(
        fs.readFile(path.join(profile.providerHomePath, "hooks.json"), "utf8"),
      ).resolves.toContain("context-mode hook codex stop");
      expect(adapter.resolveLaunchContext(profile)).toEqual({
        profileKey: profile.key,
        providerHomeRef: {
          kind: "managed-profile",
          provider: "codex",
          profileKey: profile.key,
          label: "Codex API key",
        },
        env: { CODEX_HOME: profile.providerHomePath },
        metadata: {
          providerHomeRef: {
            kind: "managed-profile",
            provider: "codex",
            profileKey: profile.key,
            label: "Codex API key",
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing provider-managed Codex config during re-import", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-codex-auth-refresh-"));
    try {
      const sourceHome = path.join(root, "source-codex");
      const providerBaseDir = path.join(root, "providers", "codex");
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(
        path.join(sourceHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-test-secret" }),
        "utf8",
      );
      await fs.writeFile(path.join(sourceHome, "config.toml"), 'model = "source-model"\n', "utf8");

      const adapter = new CodexProviderAuthAdapter({
        usageReader: async () => {
          throw new Error("import should not refresh usage");
        },
      });
      const profile = await adapter.importAuthFile(
        path.join(sourceHome, "auth.json"),
        createContext(providerBaseDir),
      );
      const providerConfigPath = path.join(providerBaseDir, "config", "config.toml");
      await fs.writeFile(
        providerConfigPath,
        '# paseo-disabled-mcp-server "context-mode"\n# [mcp_servers.context-mode]\n# command = "context-mode"\n# /paseo-disabled-mcp-server\n',
        "utf8",
      );

      await fs.writeFile(
        path.join(sourceHome, "config.toml"),
        'model = "new-source-model"\n',
        "utf8",
      );
      await adapter.importAuthFile(
        path.join(sourceHome, "auth.json"),
        createContext(providerBaseDir),
      );

      await expect(fs.readFile(providerConfigPath, "utf8")).resolves.toContain(
        "# paseo-disabled-mcp-server",
      );
      await expect(fs.readFile(providerConfigPath, "utf8")).resolves.not.toContain(
        "new-source-model",
      );
      await expect(
        fs.readFile(path.join(profile.providerHomePath, "config.toml"), "utf8"),
      ).resolves.toContain("# paseo-disabled-mcp-server");
      await expect(
        fs.readFile(path.join(profile.providerHomePath, "config.toml"), "utf8"),
      ).resolves.not.toContain("new-source-model");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes usage from live Codex app-server usage", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-codex-auth-"));
    try {
      const sourceHome = path.join(root, "source-codex");
      const providerBaseDir = path.join(root, "providers", "codex");
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(
        path.join(sourceHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-test-secret" }),
        "utf8",
      );

      let requestedCodexHome: string | undefined;
      const adapter = new CodexProviderAuthAdapter({
        usageReader: async (options) => {
          requestedCodexHome = options.codexHome;
          return {
            source: "provider-api",
            primaryUsedPercent: 12,
            primaryWindowMinutes: 300,
            primaryResetsAt: "2026-05-11T12:21:00.000Z",
            secondaryUsedPercent: 64,
            secondaryWindowMinutes: 10_080,
            secondaryResetsAt: "2026-05-14T16:59:00.000Z",
            limitState: "ok",
            refreshedAt: options.now().toISOString(),
          };
        },
      });
      const context = createContext(providerBaseDir);
      const profile = await adapter.importAuthFile(path.join(sourceHome, "auth.json"), context);

      const refreshed = await adapter.refreshProfile(profile, context);

      expect(requestedCodexHome).toBe(profile.providerHomePath);
      expect(refreshed.usage).toMatchObject({
        source: "provider-api",
        primaryUsedPercent: 12,
        secondaryUsedPercent: 64,
        refreshedAt: "2026-05-06T12:00:00.000Z",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes usage refresh errors without clearing previous usage", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-codex-auth-"));
    try {
      const sourceHome = path.join(root, "source-codex");
      const providerBaseDir = path.join(root, "providers", "codex");
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(
        path.join(sourceHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-test-secret" }),
        "utf8",
      );

      const adapter = new CodexProviderAuthAdapter({
        usageReader: async () => {
          throw new Error(
            "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; token invalidated",
          );
        },
      });
      const context = createContext(providerBaseDir);
      const profile = await adapter.importAuthFile(path.join(sourceHome, "auth.json"), context);
      const refreshed = await adapter.refreshProfile(
        {
          ...profile,
          usage: {
            source: "provider-api",
            primaryUsedPercent: 10,
            refreshedAt: "2026-05-06T11:00:00.000Z",
          },
        },
        context,
      );

      expect(refreshed.usage).toMatchObject({
        source: "provider-api",
        primaryUsedPercent: 10,
        refreshedAt: "2026-05-06T11:00:00.000Z",
      });
      expect(refreshed.usageRefreshError).toMatchObject({
        source: "provider-api",
        code: "auth-invalid",
        message: "Codex account needs sign-in again.",
        occurredAt: "2026-05-06T12:00:00.000Z",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
