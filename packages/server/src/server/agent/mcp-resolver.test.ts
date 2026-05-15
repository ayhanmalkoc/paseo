import { describe, expect, it } from "vitest";

import type { McpServerConfig, ProviderHomeRef } from "./agent-sdk-types.js";
import { explainMcpResolution, resolveMcpServers, type McpLaunchEntry } from "./mcp-resolver.js";

function stdio(command: string): McpServerConfig {
  return { type: "stdio", command };
}

function entry(input: {
  id: string;
  scope: McpLaunchEntry["scope"];
  command: string;
  enabled?: boolean;
}): McpLaunchEntry {
  return {
    id: input.id,
    scope: input.scope,
    config: stdio(input.command),
    enabled: input.enabled ?? true,
    source: "native-config",
  };
}

describe("resolveMcpServers", () => {
  it("merges account native MCP, session overrides, and protected system MCP in order", () => {
    const providerHomeRef: ProviderHomeRef = {
      kind: "managed-profile",
      provider: "codex",
      profileKey: "account-a",
    };

    const resolved = resolveMcpServers({
      provider: "codex",
      providerHomeRef,
      agentId: "agent-1",
      paseoMcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      injectPaseoTools: true,
      entries: [
        entry({
          id: "ignored-provider",
          scope: { kind: "account", provider: "claude", accountKey: "account-a" },
          command: "claude",
        }),
        entry({
          id: "account-only",
          scope: { kind: "account", provider: "codex", accountKey: "account-a" },
          command: "account",
        }),
        entry({
          id: "shared",
          scope: { kind: "account", provider: "codex", accountKey: "account-a" },
          command: "account-shared",
        }),
        entry({
          id: "disabled",
          scope: { kind: "account", provider: "codex", accountKey: "account-a" },
          command: "disabled",
          enabled: false,
        }),
        entry({
          id: "paseo",
          scope: { kind: "account", provider: "codex", accountKey: "account-a" },
          command: "fake-paseo",
        }),
      ],
      sessionMcpServers: {
        shared: stdio("session"),
        "session-only": stdio("session-only"),
        paseo: { type: "http", url: "https://example.com/fake-paseo" },
      },
    });

    expect(resolved.servers).toEqual({
      shared: stdio("session"),
      "account-only": stdio("account"),
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

  it("explains selected, overridden, and ignored MCP entries", () => {
    const providerHomeRef: ProviderHomeRef = {
      kind: "managed-profile",
      provider: "codex",
      profileKey: "account-a",
    };

    const explanation = explainMcpResolution({
      provider: "codex",
      providerHomeRef,
      agentId: "agent-1",
      paseoMcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      injectPaseoTools: true,
      entries: [
        entry({
          id: "shared",
          scope: { kind: "account", provider: "codex", accountKey: "account-a" },
          command: "account",
        }),
        entry({
          id: "disabled",
          scope: { kind: "account", provider: "codex", accountKey: "account-a" },
          command: "disabled",
          enabled: false,
        }),
        entry({
          id: "other-provider",
          scope: { kind: "account", provider: "claude", accountKey: "account-a" },
          command: "claude",
        }),
        entry({
          id: "paseo",
          scope: { kind: "account", provider: "codex", accountKey: "account-a" },
          command: "fake-paseo",
        }),
      ],
      sessionMcpServers: {
        shared: stdio("session"),
      },
    });

    expect(explanation.servers?.shared).toEqual(stdio("session"));
    expect(explanation.sources.shared).toEqual({ scope: "session", source: "session" });
    expect(explanation.steps.map((step) => [step.id, step.action, step.reason])).toEqual([
      ["shared", "overridden", "overridden-by-session"],
      ["disabled", "ignored", "disabled"],
      ["other-provider", "ignored", "scope-mismatch"],
      ["paseo", "ignored", "reserved-system-id"],
      ["shared", "selected", undefined],
      ["paseo", "selected", undefined],
    ]);
  });

  it("returns no server map when no scopes apply", () => {
    const resolved = resolveMcpServers({
      provider: "codex",
      agentId: "agent-1",
      entries: [
        entry({
          id: "claude-only",
          scope: { kind: "account", provider: "claude", accountKey: "account-a" },
          command: "claude",
        }),
      ],
    });

    expect(resolved.servers).toBeUndefined();
    expect(resolved.sources).toEqual({});
  });
});
