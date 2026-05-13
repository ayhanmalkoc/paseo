import { describe, expect, it } from "vitest";

import type { McpServerConfig, ProviderHomeRef } from "./agent-sdk-types.js";
import { resolveMcpServers, type McpRegistryEntry } from "./mcp-resolver.js";

function stdio(command: string): McpServerConfig {
  return { type: "stdio", command };
}

function entry(input: {
  id: string;
  scope: McpRegistryEntry["scope"];
  command: string;
  enabled?: boolean;
}): McpRegistryEntry {
  return {
    id: input.id,
    scope: input.scope,
    config: stdio(input.command),
    enabled: input.enabled ?? true,
    source: "user",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
  };
}

describe("resolveMcpServers", () => {
  it("merges registry scopes, session overrides, and protected system MCP in order", () => {
    const providerHomeRef: ProviderHomeRef = {
      kind: "managed-profile",
      provider: "codex",
      profileKey: "account-a",
    };

    const resolved = resolveMcpServers({
      provider: "codex",
      providerHomeRef,
      runtimeProfileId: "profile-a",
      agentId: "agent-1",
      paseoMcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      injectPaseoTools: true,
      entries: [
        entry({ id: "shared", scope: { kind: "global" }, command: "global" }),
        entry({
          id: "provider-only",
          scope: { kind: "provider", provider: "codex" },
          command: "provider",
        }),
        entry({
          id: "ignored-provider",
          scope: { kind: "provider", provider: "claude" },
          command: "claude",
        }),
        entry({
          id: "account-only",
          scope: { kind: "account", provider: "codex", accountKey: "account-a" },
          command: "account",
        }),
        entry({
          id: "runtime-only",
          scope: { kind: "runtimeProfile", profileId: "profile-a" },
          command: "runtime",
        }),
        entry({ id: "disabled", scope: { kind: "global" }, command: "disabled", enabled: false }),
        entry({ id: "paseo", scope: { kind: "global" }, command: "fake-paseo" }),
      ],
      sessionMcpServers: {
        shared: stdio("session"),
        "session-only": stdio("session-only"),
        paseo: { type: "http", url: "https://example.com/fake-paseo" },
      },
    });

    expect(resolved.servers).toEqual({
      shared: stdio("session"),
      "provider-only": stdio("provider"),
      "account-only": stdio("account"),
      "runtime-only": stdio("runtime"),
      "session-only": stdio("session-only"),
      paseo: {
        type: "http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      },
    });
    expect(resolved.sources.shared).toEqual({ scope: "session", source: "session" });
    expect(resolved.sources.paseo).toEqual({
      scope: "system",
      source: "system",
      protected: true,
    });
  });

  it("returns no server map when no scopes apply", () => {
    const resolved = resolveMcpServers({
      provider: "codex",
      agentId: "agent-1",
      entries: [
        entry({
          id: "claude-only",
          scope: { kind: "provider", provider: "claude" },
          command: "claude",
        }),
      ],
    });

    expect(resolved.servers).toBeUndefined();
    expect(resolved.sources).toEqual({});
  });
});
