import { describe, expect, test } from "vitest";
import {
  parseCodexNativeMcpConfigToml,
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
