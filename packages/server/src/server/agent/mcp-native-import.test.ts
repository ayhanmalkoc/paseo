import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCodexNativeMcpConfigToml,
  parseOpenCodeNativeMcpConfigJson,
  readProviderHomeNativeMcpEntries,
  removeCodexNativeMcpServerConfig,
  removeOpenCodeNativeMcpServerConfig,
  resolveCodexNativeConfigPath,
  writeCodexNativeMcpServerConfig,
  writeOpenCodeNativeMcpServerConfig,
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

  test("preserves provider-specific MCP subtables while toggling", () => {
    const content = `model = "gpt-5.5"

[mcp_servers."context-mode"]
command = "context-mode"

[mcp_servers."context-mode".tools.ctx_batch_execute]
approval_mode = "approve"

[mcp_servers."context-mode".tools.ctx_search]
approval_mode = "approve"

[mcp_servers.notebooklm]
command = "npx"
`;

    const disabled = writeCodexNativeMcpServerConfig({
      content,
      id: "context-mode",
      config: { type: "stdio", command: "context-mode" },
      enabled: false,
    });

    expect(disabled).toContain('# [mcp_servers."context-mode".tools.ctx_batch_execute]');
    expect(disabled).toContain('# approval_mode = "approve"');
    expect(disabled).toContain("[mcp_servers.notebooklm]");
    expect(disabled).not.toContain("\n[mcp_servers.context-mode]\n");

    const enabled = writeCodexNativeMcpServerConfig({
      content: disabled,
      id: "context-mode",
      config: { type: "stdio", command: "context-mode" },
      enabled: true,
    });

    expect(enabled).toContain('[mcp_servers."context-mode"]');
    expect(enabled).toContain('[mcp_servers."context-mode".tools.ctx_batch_execute]');
    expect(enabled).toContain('[mcp_servers."context-mode".tools.ctx_search]');
    expect(enabled).toContain("[mcp_servers.notebooklm]");
    expect(enabled).not.toContain("paseo-disabled-mcp-server");
  });
});

describe("OpenCode native MCP config", () => {
  test("imports local and remote MCP servers from opencode config", () => {
    const parsed = parseOpenCodeNativeMcpConfigJson(`{
      "$schema": "https://opencode.ai/config.json",
      // OpenCode accepts JSONC config files.
      "mcp": {
        "context-mode": {
          "type": "local",
          "command": ["context-mode", "serve"],
          "environment": {
            "CONTEXT_MODE": "1",
          },
          "enabled": false,
        },
        "remote": {
          "type": "remote",
          "url": "https://example.com/mcp",
          "headers": {
            "Authorization": "Bearer redacted",
          },
          "enabled": true,
        },
      },
    }`);

    expect(parsed.skipped).toEqual([]);
    expect(parsed.servers).toEqual([
      {
        id: "context-mode",
        config: {
          type: "stdio",
          command: "context-mode",
          args: ["serve"],
          env: { CONTEXT_MODE: "1" },
        },
        enabled: false,
      },
      {
        id: "remote",
        config: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer redacted" },
        },
        enabled: true,
      },
    ]);
  });

  test("upserts and removes OpenCode MCP servers", () => {
    const updated = writeOpenCodeNativeMcpServerConfig({
      content: '{ "$schema": "https://opencode.ai/config.json" }',
      id: "context-mode",
      config: { type: "stdio", command: "context-mode", args: ["serve"] },
      enabled: false,
    });

    expect(parseOpenCodeNativeMcpConfigJson(updated).servers).toEqual([
      {
        id: "context-mode",
        config: { type: "stdio", command: "context-mode", args: ["serve"] },
        enabled: false,
      },
    ]);
    expect(updated).toContain('"type": "local"');
    expect(updated).toContain('"enabled": false');

    const removed = removeOpenCodeNativeMcpServerConfig(updated, "context-mode");
    expect(removed).toContain("opencode.ai/config.json");
    expect(removed).not.toContain("context-mode");
  });
});

describe("readProviderHomeNativeMcpEntries", () => {
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

    const entries = await readProviderHomeNativeMcpEntries({
      provider: "codex",
      providerHomePath,
      accountKey: "work",
    });

    expect(entries).toEqual([
      {
        id: "context_mode",
        scope: { kind: "account", provider: "codex", accountKey: "work" },
        config: { type: "stdio", command: "context-mode" },
        enabled: true,
        source: "native-config",
      },
    ]);
  });

  test("ignores non-Codex providers and missing config files during launch resolution", async () => {
    await expect(
      readProviderHomeNativeMcpEntries({
        provider: "claude",
        providerHomePath: "/tmp/missing",
        accountKey: "work",
      }),
    ).resolves.toEqual([]);
    await expect(
      readProviderHomeNativeMcpEntries({
        provider: "codex",
        providerHomePath: "/tmp/missing",
        accountKey: "work",
      }),
    ).resolves.toEqual([]);
  });

  test("reads provider-scoped MCP entries from a managed OpenCode home", async () => {
    const providerHomePath = mkdtempSync(path.join(tmpdir(), "paseo-opencode-home-"));
    tempRoots.push(providerHomePath);
    await fs.mkdir(path.join(providerHomePath, "config", "opencode"), { recursive: true });
    await fs.writeFile(
      path.join(providerHomePath, "config", "opencode", "opencode.json"),
      JSON.stringify(
        {
          mcp: {
            "context-mode": {
              type: "local",
              command: ["context-mode"],
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const entries = await readProviderHomeNativeMcpEntries({
      provider: "opencode",
      providerHomePath,
      accountKey: null,
    });

    expect(entries).toEqual([
      {
        id: "context-mode",
        scope: { kind: "provider", provider: "opencode" },
        config: { type: "stdio", command: "context-mode" },
        enabled: true,
        source: "native-config",
      },
    ]);
  });
});
