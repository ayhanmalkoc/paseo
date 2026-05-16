import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { ensureOpenCodeManagedRoots, resolveOpenCodeManagedRoots } from "./managed-roots.js";

const tempRoots: string[] = [];

describe("OpenCode managed roots", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("seeds native config and syncs native auth into the Paseo provider root", async () => {
    const root = await createTempRoot();
    const nativeRoot = path.join(root, "native");
    const paseoHome = path.join(root, "paseo-home");
    await mkdir(path.join(nativeRoot, "config", "opencode"), { recursive: true });
    await mkdir(path.join(nativeRoot, "data", "opencode"), { recursive: true });
    await writeFile(
      path.join(nativeRoot, "config", "opencode", "opencode.jsonc"),
      '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
    );
    await writeFile(
      path.join(nativeRoot, "data", "opencode", "auth.json"),
      '{"opencode":{"type":"api","key":"native-opencode"}}\n',
    );

    const roots = resolveOpenCodeManagedRoots(paseoHome);
    await ensureOpenCodeManagedRoots({
      roots,
      nativeRoots: {
        xdgConfigHome: path.join(nativeRoot, "config"),
        xdgDataHome: path.join(nativeRoot, "data"),
        xdgStateHome: path.join(nativeRoot, "state"),
      },
    });

    await writeFile(
      path.join(nativeRoot, "data", "opencode", "auth.json"),
      '{"opencode":{"type":"api","key":"fresh-opencode"},"openai":{"type":"oauth","access":"native-openai"}}\n',
    );
    await writeFile(
      path.join(roots.xdgDataHome, "opencode", "auth.json"),
      '{"managed":true,"opencode":{"type":"api","key":"stale-opencode"}}\n',
    );
    await ensureOpenCodeManagedRoots({
      roots,
      nativeRoots: {
        xdgConfigHome: path.join(nativeRoot, "config"),
        xdgDataHome: path.join(nativeRoot, "data"),
        xdgStateHome: path.join(nativeRoot, "state"),
      },
    });

    await expect(
      readFile(path.join(roots.xdgConfigHome, "opencode", "opencode.jsonc"), "utf8"),
    ).resolves.toContain("opencode.ai/config.json");
    await expect(
      readFile(path.join(roots.xdgDataHome, "opencode", "auth.json"), "utf8"),
    ).resolves.toBe(
      '{\n  "managed": true,\n  "opencode": {\n    "type": "api",\n    "key": "fresh-opencode"\n  },\n  "openai": {\n    "type": "oauth",\n    "access": "native-openai"\n  }\n}\n',
    );
    expect(roots.storageRoot).toBe(path.join(roots.xdgDataHome, "opencode", "storage"));
    expect(roots.envOverlay).toMatchObject({
      XDG_CONFIG_HOME: roots.xdgConfigHome,
      XDG_DATA_HOME: roots.xdgDataHome,
      XDG_STATE_HOME: roots.xdgStateHome,
    });
  });
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-roots-"));
  tempRoots.push(root);
  return root;
}
