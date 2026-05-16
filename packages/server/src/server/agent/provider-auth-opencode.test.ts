import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { OpenCodeProviderAuthAdapter, parseOpenCodeAuthJson } from "./provider-auth-opencode.js";

const tempRoots: string[] = [];

describe("parseOpenCodeAuthJson", () => {
  test("summarizes every linked native auth provider", () => {
    const parsed = parseOpenCodeAuthJson(
      JSON.stringify({
        opencode: { type: "api", key: "zen-key" },
        openai: { type: "oauth", access: createJwt({ email: "Test@Example.com" }) },
        openrouter: { type: "api", key: "router-key" },
      }),
    );

    expect(parsed).toMatchObject({
      key: "opencode-native-auth",
      alias: "OpenCode native auth",
      accountName: "openai · opencode · openrouter",
      authMode: "external",
      providerKeys: ["openai", "opencode", "openrouter"],
      email: "test@example.com",
    });
  });
});

describe("OpenCodeProviderAuthAdapter", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("imports the native auth bundle and syncs it into the managed OpenCode root", async () => {
    const root = await createTempRoot();
    const nativeRoot = path.join(root, "native");
    const paseoHome = path.join(root, "paseo-home");
    await mkdir(path.join(nativeRoot, "config", "opencode"), { recursive: true });
    await mkdir(path.join(nativeRoot, "data", "opencode"), { recursive: true });
    await writeFile(
      path.join(nativeRoot, "data", "opencode", "auth.json"),
      JSON.stringify({
        opencode: { type: "api", key: "zen-key" },
        openai: { type: "oauth", access: createJwt({ email: "openai@example.com" }) },
      }),
    );

    const previousEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.XDG_CONFIG_HOME = path.join(nativeRoot, "config");
    process.env.XDG_DATA_HOME = path.join(nativeRoot, "data");
    process.env.XDG_STATE_HOME = path.join(nativeRoot, "state");
    try {
      const adapter = new OpenCodeProviderAuthAdapter();
      const imported = await adapter.importCurrent({
        providerBaseDir: path.join(paseoHome, "providers", "opencode"),
        now: () => new Date("2026-05-16T09:30:00.000Z"),
        logger: createLogger(),
      });

      expect(imported).toMatchObject({
        provider: "opencode",
        key: "opencode-native-auth",
        alias: "OpenCode native auth",
        email: "openai@example.com",
        accountName: "openai · opencode",
        authMode: "external",
        plan: "openai, opencode",
        status: "ready",
        providerHomePath: path.join(paseoHome, "providers", "opencode"),
      });
      await expect(
        readFile(
          path.join(paseoHome, "providers", "opencode", "data", "opencode", "auth.json"),
          "utf8",
        ),
      ).resolves.toContain('"openai"');
    } finally {
      restoreEnv(previousEnv);
    }
  });
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-auth-"));
  tempRoots.push(root);
  return root;
}

function createJwt(profile: { email: string }): string {
  return [
    base64UrlEncode({ alg: "none", typ: "JWT" }),
    base64UrlEncode({ "https://api.openai.com/profile": profile }),
    "signature",
  ].join(".");
}

function base64UrlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createLogger() {
  return {
    child: () => createLogger(),
    debug: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
  } as never;
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
