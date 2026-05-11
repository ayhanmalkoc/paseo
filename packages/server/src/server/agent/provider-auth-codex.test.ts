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
  it("imports auth into an isolated Codex home", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-codex-auth-"));
    try {
      const sourceHome = path.join(root, "source-codex");
      const providerBaseDir = path.join(root, "provider-auth", "codex");
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(
        path.join(sourceHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-test-secret" }),
        "utf8",
      );
      await fs.writeFile(path.join(sourceHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

      const adapter = new CodexProviderAuthAdapter();
      const profile = await adapter.importAuthFile(path.join(sourceHome, "auth.json"), {
        providerBaseDir,
        now: () => new Date("2026-05-06T12:00:00.000Z"),
        logger: createTestLogger(),
      });

      expect(profile.providerHomePath).toContain(path.join("profiles", profile.key, "codex-home"));
      await expect(
        fs.readFile(path.join(profile.providerHomePath, "auth.json"), "utf8"),
      ).resolves.toContain("sk-test-secret");
      await expect(
        fs.readFile(path.join(profile.providerHomePath, "config.toml"), "utf8"),
      ).resolves.toContain("gpt-5.4");
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

  it("refreshes usage from Codex rollout rate limits", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-codex-auth-"));
    try {
      const sourceHome = path.join(root, "source-codex");
      const providerBaseDir = path.join(root, "provider-auth", "codex");
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(
        path.join(sourceHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-test-secret" }),
        "utf8",
      );

      const adapter = new CodexProviderAuthAdapter();
      const profile = await adapter.importAuthFile(path.join(sourceHome, "auth.json"), {
        providerBaseDir,
        now: () => new Date("2026-05-06T12:00:00.000Z"),
        logger: createTestLogger(),
      });
      const rolloutPath = path.join(
        profile.providerHomePath,
        "sessions",
        "2026",
        "05",
        "11",
        "rollout.jsonl",
      );
      await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
      await fs.writeFile(
        rolloutPath,
        `${JSON.stringify({
          payload: {
            rate_limits: {
              primary: {
                used_percent: 86,
                window_minutes: 300,
                resets_at: 1_778_494_841,
              },
              secondary: {
                used_percent: 44,
                window_minutes: 10_080,
                resets_at: 1_778_942_355,
              },
              credits: {
                remaining: 12,
              },
            },
          },
        })}\n`,
        "utf8",
      );

      const refreshed = await adapter.refreshProfile(profile);

      expect(refreshed.usage).toMatchObject({
        source: "local-rollout",
        primaryUsedPercent: 86,
        primaryWindowMinutes: 300,
        primaryResetsAt: new Date(1_778_494_841 * 1000).toISOString(),
        secondaryUsedPercent: 44,
        secondaryWindowMinutes: 10_080,
        secondaryResetsAt: new Date(1_778_942_355 * 1000).toISOString(),
        creditsRemaining: 12,
        limitState: "near-limit",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes usage from camelCase Codex rollout rate limits", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-codex-auth-"));
    try {
      const sourceHome = path.join(root, "source-codex");
      const providerBaseDir = path.join(root, "provider-auth", "codex");
      await fs.mkdir(sourceHome, { recursive: true });
      await fs.writeFile(
        path.join(sourceHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-test-secret" }),
        "utf8",
      );

      const adapter = new CodexProviderAuthAdapter();
      const profile = await adapter.importAuthFile(path.join(sourceHome, "auth.json"), {
        providerBaseDir,
        now: () => new Date("2026-05-06T12:00:00.000Z"),
        logger: createTestLogger(),
      });
      const rolloutPath = path.join(profile.providerHomePath, "sessions", "rollout.jsonl");
      await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
      await fs.writeFile(
        rolloutPath,
        `${JSON.stringify({
          payload: {
            rateLimits: {
              primary: {
                usedPercent: 100,
                windowMinutes: 300,
                resetsAt: "2026-05-11T00:21:00.000Z",
              },
            },
          },
        })}\n`,
        "utf8",
      );

      const refreshed = await adapter.refreshProfile(profile);

      expect(refreshed.usage).toMatchObject({
        source: "local-rollout",
        primaryUsedPercent: 100,
        primaryWindowMinutes: 300,
        primaryResetsAt: "2026-05-11T00:21:00.000Z",
        limitState: "limited",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
