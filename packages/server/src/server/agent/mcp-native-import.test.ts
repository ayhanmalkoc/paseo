import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCodexNativeMcpConfigToml,
  readProviderHomeNativeMcpRegistryEntries,
  removeCodexNativeMcpServerConfig,
  resolveCodexNativeConfigPath,
  writeCodexNativeMcpServerConfig,
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
        enabled: true,
      },
      {
        id: "notebooklm",
        config: {
          type: "http",
          url: "http://127.0.0.1:3001/mcp",
          headers: { Authorization: "Bearer redacted" },
        },
        enabled: true,
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
        enabled: true,
      },
      {
        id: "events",
        config: {
          type: "sse",
          url: "http://127.0.0.1:4000/sse",
          headers: { "X-Test": "ok" },
        },
        enabled: true,
      },
    ]);
  });

  test("keeps disabled native MCP entries parseable", () => {
    const parsed = parseCodexNativeMcpConfigToml(`
# paseo-disabled-mcp-server "context_mode"
# [mcp_servers.context_mode]
# command = "context-mode"
# /paseo-disabled-mcp-server
`);

    expect(parsed.servers).toEqual([
      {
        id: "context_mode",
        config: { type: "stdio", command: "context-mode" },
        enabled: false,
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

describe("Codex native MCP config writers", () => {
  test("upserts and removes MCP server blocks", () => {
    const updated = writeCodexNativeMcpServerConfig({
      content: 'model = "gpt-5.5"\n\n[mcp_servers."context-mode"]\ncommand = "old"\n',
      id: "context-mode",
      config: { type: "stdio", command: "context-mode", args: ["serve"] },
      enabled: false,
    });

    expect(updated).toContain('model = "gpt-5.5"');
    expect(updated).not.toContain('command = "old"');
    expect(updated).not.toContain("\n[mcp_servers.context-mode]");
    expect(updated).toContain("# [mcp_servers.context-mode]");
    expect(updated).toContain('command = "context-mode"');
    expect(updated).toContain('args = ["serve"]');
    expect(updated).not.toContain("enabled = false");
    expect(parseCodexNativeMcpConfigToml(updated).servers).toEqual([
      {
        id: "context-mode",
        config: { type: "stdio", command: "context-mode", args: ["serve"] },
        enabled: false,
      },
    ]);

    const removed = removeCodexNativeMcpServerConfig(updated, "context-mode");
    expect(removed).toContain('model = "gpt-5.5"');
    expect(removed).not.toContain("context-mode");
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
