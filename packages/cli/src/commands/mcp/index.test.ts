import { describe, expect, it } from "vitest";
import {
  parseExplainAccountKey,
  parseMcpConfig,
  parseRequiredScope,
  parseSessionMcpServers,
} from "./index.js";

describe("mcp command parsing", () => {
  it("parses provider scopes", () => {
    expect(parseRequiredScope({ provider: "codex" })).toEqual({
      kind: "provider",
      provider: "codex",
    });
  });

  it("parses account scopes", () => {
    expect(parseRequiredScope({ account: "codex:kolektifhubdigital" })).toEqual({
      kind: "account",
      provider: "codex",
      accountKey: "kolektifhubdigital",
    });
  });

  it("rejects ambiguous scopes", () => {
    expect(() => parseRequiredScope({ global: true, provider: "codex" })).toThrow(
      expect.objectContaining({ code: "INVALID_SCOPE" }),
    );
  });

  it("parses stdio MCP config", () => {
    expect(
      parseMcpConfig({
        type: "stdio",
        command: "context-mode",
        arg: ["serve"],
        env: ["FOO=bar"],
      }),
    ).toEqual({
      type: "stdio",
      command: "context-mode",
      args: ["serve"],
      env: { FOO: "bar" },
    });
  });

  it("parses HTTP MCP config", () => {
    expect(
      parseMcpConfig({
        type: "http",
        url: "http://127.0.0.1:3000/mcp",
        header: ["Authorization=Bearer secret"],
      }),
    ).toEqual({
      type: "http",
      url: "http://127.0.0.1:3000/mcp",
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("parses explain account and session override config", () => {
    expect(parseExplainAccountKey("codex:work", "codex")).toBe("work");
    expect(parseExplainAccountKey("work", "codex")).toBe("work");
    expect(() => parseExplainAccountKey("claude:work", "codex")).toThrow(
      expect.objectContaining({ code: "INVALID_SCOPE" }),
    );

    expect(
      parseSessionMcpServers(
        JSON.stringify({
          session: { type: "stdio", command: "session-tool", args: ["--serve"] },
        }),
      ),
    ).toEqual({
      session: { type: "stdio", command: "session-tool", args: ["--serve"] },
    });
  });
});
