import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { GeminiProviderAuthAdapter } from "./provider-auth-gemini.js";

const tempRoots: string[] = [];

describe("GeminiProviderAuthAdapter", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("imports the native Gemini home into a managed account home", async () => {
    const root = await createTempRoot();
    const nativeRoot = path.join(root, "native");
    const nativeState = path.join(nativeRoot, ".gemini");
    const paseoHome = path.join(root, "paseo-home");
    await mkdir(nativeState, { recursive: true });
    await writeFile(
      path.join(nativeState, "google_accounts.json"),
      JSON.stringify({ active: "Gemini.User@Example.com", old: [] }),
    );
    await writeFile(
      path.join(nativeState, "oauth_creds.json"),
      JSON.stringify({
        id_token: createJwt({ email: "Gemini.User@Example.com", sub: "user-123" }),
      }),
    );
    await writeFile(path.join(nativeState, "settings.json"), JSON.stringify({ theme: "Default" }));
    await writeFile(path.join(nativeState, "session.lock"), "locked");

    const previousGeminiHome = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = nativeRoot;
    try {
      const adapter = new GeminiProviderAuthAdapter();
      const imported = await adapter.importCurrent({
        providerBaseDir: path.join(paseoHome, "providers", "gemini"),
        now: () => new Date("2026-05-17T07:30:00.000Z"),
        logger: createLogger(),
      });

      expect(imported).toMatchObject({
        provider: "gemini",
        alias: "gemini.user",
        email: "gemini.user@example.com",
        userId: "user-123",
        authMode: "oauth",
        status: "ready",
      });
      expect(imported.providerHomePath).toMatch(/providers\/gemini\/accounts\/.+\/home$/);
      await expect(
        readFile(path.join(imported.providerHomePath, ".gemini", "settings.json"), "utf8"),
      ).resolves.toContain("Default");
      await expect(
        stat(path.join(imported.providerHomePath, ".gemini", "session.lock")),
      ).rejects.toThrow();

      const launch = adapter.resolveLaunchContext(imported);
      expect(launch).toMatchObject({
        profileKey: imported.key,
        env: { GEMINI_CLI_HOME: imported.providerHomePath },
        providerHomeRef: {
          kind: "managed-profile",
          provider: "gemini",
          profileKey: imported.key,
          homePath: imported.providerHomePath,
        },
      });
    } finally {
      restoreEnv({ GEMINI_CLI_HOME: previousGeminiHome });
    }
  });

  test("preserves managed extension enablement when syncing the native Gemini home", async () => {
    const root = await createTempRoot();
    const nativeRoot = path.join(root, "native");
    const nativeState = path.join(nativeRoot, ".gemini");
    const paseoHome = path.join(root, "paseo-home");
    await mkdir(path.join(nativeState, "extensions", "google-workspace-cli"), {
      recursive: true,
    });
    await writeFile(
      path.join(nativeState, "google_accounts.json"),
      JSON.stringify({ active: "Gemini.User@Example.com", old: [] }),
    );
    await writeFile(
      path.join(nativeState, "oauth_creds.json"),
      JSON.stringify({
        id_token: createJwt({ email: "Gemini.User@Example.com", sub: "user-123" }),
      }),
    );
    await writeFile(
      path.join(nativeState, "extensions", "extension-enablement.json"),
      JSON.stringify({ "google-workspace-cli": { overrides: ["/root/*"] } }),
    );

    const previousGeminiHome = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = nativeRoot;
    try {
      const adapter = new GeminiProviderAuthAdapter();
      const context = {
        providerBaseDir: path.join(paseoHome, "providers", "gemini"),
        now: () => new Date("2026-05-17T07:30:00.000Z"),
        logger: createLogger(),
      };
      const imported = await adapter.importCurrent(context);
      const managedEnablementPath = path.join(
        imported.providerHomePath,
        ".gemini",
        "extensions",
        "extension-enablement.json",
      );
      await writeFile(
        managedEnablementPath,
        JSON.stringify({ "google-workspace-cli": { overrides: ["!/*"] } }),
      );

      await adapter.importCurrent(context);

      await expect(readFile(managedEnablementPath, "utf8")).resolves.toContain("!/*");
    } finally {
      restoreEnv({ GEMINI_CLI_HOME: previousGeminiHome });
    }
  });
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-gemini-auth-"));
  tempRoots.push(root);
  return root;
}

function createJwt(payload: Record<string, string>): string {
  return [base64UrlEncode({ alg: "none", typ: "JWT" }), base64UrlEncode(payload), "signature"].join(
    ".",
  );
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
