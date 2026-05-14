import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCodexNativeMcpConfigToml,
  readProviderHomeNativeMcpRegistryEntries,
  resolveCodexNativeConfigPath,
} from "./mcp-native-import.js";

describe("parseCodexNativeMcpConfigToml", () => {
  test("imports stdio and HTTP MCP servers from Codex config", () => {
    const parsed = parseCodexNativeMcpConfigToml(`
[mcp_servers.context_mode]
command = "context-mode"
args = ["serve", "--json"]
env = { API_TOKEN = "redacted" }

[mcp_servers.notebooklm]
url = "http://127.0.0.1:3001/mcp"
transport = "http"
headers = { Authorization = "Bearer redacted" }
`);

    expect(parsed.skipped).toEqual([]);
    expect(parsed.servers).toEqual([
      {
        id: "context_mode",
        config: {
          type: "stdio",
          command: "context-mode",
          args: ["serve", "--json"],
          env: { API_TOKEN: "redacted" },
        },
      },
      {
        id: "notebooklm",
        config: {
          type: "http",
          url: "http://127.0.0.1:3001/mcp",
          headers: { Authorization: "Bearer redacted" },
        },
      },
    ]);
  });

  test("imports nested env and sse headers", () => {
    const parsed = parseCodexNativeMcpConfigToml(`
[mcp_servers."with.dot"]
command = "node"

[mcp_servers."with.dot".env]
TOKEN = "secret"

[mcp_servers.events]
url = "http://127.0.0.1:4000/sse"
transport = "sse"

[mcp_servers.events.http_headers]
X-Test = "ok"
`);

    expect(parsed.servers).toEqual([
      {
        id: "with.dot",
        config: {
          type: "stdio",
          command: "node",
          env: { TOKEN: "secret" },
        },
      },
      {
        id: "events",
        config: {
          type: "sse",
          url: "http://127.0.0.1:4000/sse",
          headers: { "X-Test": "ok" },
        },
      },
    ]);
  });

  test("skips unsupported and reserved entries", () => {
    const parsed = parseCodexNativeMcpConfigToml(`
[mcp_servers.paseo]
command = "should-not-import"

[mcp_servers.empty]
startup_timeout_sec = 5
`);

    expect(parsed.servers).toEqual([]);
    expect(parsed.skipped).toEqual([
      { id: "empty", reason: "No supported command or URL config found" },
    ]);
  });
});

describe("resolveCodexNativeConfigPath", () => {
  test("accepts a Codex home directory or config file path", () => {
    expect(resolveCodexNativeConfigPath("/tmp/codex")).toBe("/tmp/codex/config.toml");
    expect(resolveCodexNativeConfigPath("/tmp/codex/config.toml")).toBe("/tmp/codex/config.toml");
  });
});

describe("readProviderHomeNativeMcpRegistryEntries", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads account-scoped MCP entries from a managed Codex home", async () => {
    const providerHomePath = mkdtempSync(path.join(tmpdir(), "paseo-codex-home-"));
    tempRoots.push(providerHomePath);
    await fs.writeFile(
      path.join(providerHomePath, "config.toml"),
      `[mcp_servers.context_mode]
command = "context-mode"
`,
      "utf8",
    );

    const entries = await readProviderHomeNativeMcpRegistryEntries({
      provider: "codex",
      providerHomePath,
      accountKey: "work",
      now: () => new Date("2026-05-14T10:00:00.000Z"),
    });

    expect(entries).toEqual([
      {
        id: "context_mode",
        scope: { kind: "account", provider: "codex", accountKey: "work" },
        config: { type: "stdio", command: "context-mode" },
        enabled: true,
        source: "native-import",
        importedFrom: {
          provider: "codex",
          path: path.join(providerHomePath, "config.toml"),
          importedAt: "2026-05-14T10:00:00.000Z",
        },
        createdAt: "2026-05-14T10:00:00.000Z",
        updatedAt: "2026-05-14T10:00:00.000Z",
      },
    ]);
  });

  test("ignores unsupported providers and missing config files during launch resolution", async () => {
    await expect(
      readProviderHomeNativeMcpRegistryEntries({
        provider: "claude",
        providerHomePath: "/tmp/missing",
        accountKey: "work",
      }),
    ).resolves.toEqual([]);
    await expect(
      readProviderHomeNativeMcpRegistryEntries({
        provider: "codex",
        providerHomePath: "/tmp/missing",
        accountKey: "work",
      }),
    ).resolves.toEqual([]);
  });
});
