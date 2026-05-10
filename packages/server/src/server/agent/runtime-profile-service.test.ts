import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { RuntimeProfileService } from "./runtime-profile-service.js";

const TEMP_DIRS: string[] = [];

describe("RuntimeProfileService", () => {
  afterEach(async () => {
    await Promise.all(TEMP_DIRS.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("migrates deprecated featureDefaults into featureValues and drops old workspace fields", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "runtime-profile-service-"));
    TEMP_DIRS.push(paseoHome);
    const registryDir = join(paseoHome, "runtime-profiles");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      join(registryDir, "profiles.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          "profile-1": {
            id: "profile-1",
            version: 1,
            name: "Codex work",
            provider: "codex",
            featureDefaults: {
              fast_mode: false,
              plan_mode: false,
            },
            featureValues: {
              fast_mode: true,
            },
            workspaceDefaults: {
              cwd: "C:\\dev\\paseo",
            },
            concurrencyPolicy: "warn",
            createdAt: "2026-05-08T09:00:00.000Z",
            updatedAt: "2026-05-08T09:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    const service = new RuntimeProfileService({
      paseoHome,
      logger: createTestLogger(),
    });

    const profiles = await service.listProfiles();

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.featureValues).toEqual({
      fast_mode: true,
      plan_mode: false,
    });
    expect(profiles[0]).not.toHaveProperty("featureDefaults");
    expect(profiles[0]).not.toHaveProperty("workspaceDefaults");
    expect(profiles[0]?.sessionBehavior).toBe("continue");
  });
});
