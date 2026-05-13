import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { McpRegistryService } from "./mcp-registry-service.js";

describe("McpRegistryService", () => {
  let paseoHome: string;

  beforeEach(() => {
    paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-mcp-registry-"));
  });

  afterEach(() => {
    rmSync(paseoHome, { recursive: true, force: true });
  });

  function createService(now = () => new Date("2026-05-13T10:00:00.000Z")) {
    return new McpRegistryService({
      paseoHome,
      logger: createTestLogger(),
      now,
    });
  }

  it("persists scoped MCP entries", async () => {
    const service = createService();

    await service.upsertEntry({
      id: "context-mode",
      scope: { kind: "provider", provider: "codex" },
      config: {
        type: "stdio",
        command: "context-mode",
        args: ["mcp"],
        env: { CONTEXT_MODE: "1" },
      },
    });

    const reloaded = createService();
    await expect(reloaded.listEntries()).resolves.toEqual([
      {
        id: "context-mode",
        scope: { kind: "provider", provider: "codex" },
        config: {
          type: "stdio",
          command: "context-mode",
          args: ["mcp"],
          env: { CONTEXT_MODE: "1" },
        },
        enabled: true,
        source: "user",
        createdAt: "2026-05-13T10:00:00.000Z",
        updatedAt: "2026-05-13T10:00:00.000Z",
      },
    ]);
  });

  it("rejects the protected Paseo MCP server id", async () => {
    await expect(
      createService().upsertEntry({
        id: "paseo",
        scope: { kind: "global" },
        config: {
          type: "http",
          url: "https://example.com/not-paseo",
        },
      }),
    ).rejects.toThrow("reserved by Paseo");
  });

  it("skips invalid entries when reading a manually edited registry", async () => {
    await fs.mkdir(path.join(paseoHome, "mcp"), { recursive: true });
    await fs.writeFile(
      path.join(paseoHome, "mcp", "registry.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            id: "valid",
            scope: { kind: "global" },
            config: { type: "http", url: "https://example.com/mcp" },
            enabled: true,
            source: "user",
            createdAt: "2026-05-13T10:00:00.000Z",
            updatedAt: "2026-05-13T10:00:00.000Z",
          },
          {
            id: "missing-config",
            scope: { kind: "global" },
          },
          {
            id: "paseo",
            scope: { kind: "global" },
            config: { type: "http", url: "https://example.com/fake" },
          },
        ],
      })}\n`,
      "utf8",
    );

    await expect(createService().listEntries()).resolves.toEqual([
      {
        id: "valid",
        scope: { kind: "global" },
        config: { type: "http", url: "https://example.com/mcp" },
        enabled: true,
        source: "user",
        createdAt: "2026-05-13T10:00:00.000Z",
        updatedAt: "2026-05-13T10:00:00.000Z",
      },
    ]);
  });
});
