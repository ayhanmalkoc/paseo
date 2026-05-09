import { describe, expect, test } from "vitest";

import type { AgentSessionConfig, ProviderAuthProfile, RuntimeProfile } from "./agent-sdk-types.js";
import { LaunchResolver } from "./launch-resolver.js";
import type { ProviderAuthService } from "./provider-auth-service.js";
import type { RuntimeProfileService } from "./runtime-profile-service.js";

const NOW = "2026-05-08T09:00:00.000Z";

describe("LaunchResolver", () => {
  test("runtime profile selections win over composer defaults", async () => {
    const resolver = createResolver({
      profile: createRuntimeProfile({
        accountKey: "profile-account",
        model: "gpt-profile",
        modeId: "full-access",
        thinkingOptionId: "xhigh",
      }),
    });
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: "C:\\dev\\paseo",
      runtimeProfileId: "profile-1",
      authProfileKey: "composer-account",
      model: "gpt-composer",
      modeId: "auto",
      thinkingOptionId: "low",
    };

    const resolved = await resolver.resolve({
      agentId: "agent-1",
      config,
      normalizedConfig: config,
      resolveDefaultAuthProfile: false,
    });

    expect(resolved.config).toMatchObject({
      provider: "codex",
      authProfileKey: "profile-account",
      model: "gpt-profile",
      modeId: "full-access",
      thinkingOptionId: "xhigh",
      runtimeProfileId: "profile-1",
    });
    expect(resolved.snapshot).toMatchObject({
      sourceProfileId: "profile-1",
      accountKey: "profile-account",
      model: "gpt-profile",
      modeId: "full-access",
      thinkingOptionId: "xhigh",
    });
    expect(resolved.launchContext.env.CODEX_HOME).toBe("C:\\profiles\\profile-account");
  });

  test("explicit runtime profile overrides win over stored profile selections", async () => {
    const resolver = createResolver({
      profile: createRuntimeProfile({
        accountKey: "profile-account",
        model: "gpt-profile",
        modeId: "full-access",
        thinkingOptionId: "xhigh",
      }),
    });
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: "C:\\dev\\paseo",
      runtimeProfileId: "profile-1",
      model: "gpt-composer",
      modeId: "auto",
      thinkingOptionId: "low",
      profileOverrides: {
        accountKey: "override-account",
        model: "gpt-override",
        modeId: "auto",
        thinkingOptionId: "medium",
      },
    };

    const resolved = await resolver.resolve({
      agentId: "agent-1",
      config,
      normalizedConfig: config,
      resolveDefaultAuthProfile: false,
    });

    expect(resolved.config).toMatchObject({
      authProfileKey: "override-account",
      model: "gpt-override",
      modeId: "auto",
      thinkingOptionId: "medium",
    });
    expect(resolved.snapshot).toMatchObject({
      accountKey: "override-account",
      model: "gpt-override",
      modeId: "auto",
      thinkingOptionId: "medium",
    });
  });

  test("explicit default profile transition drops the previous source profile snapshot", async () => {
    const resolver = createResolver({
      profile: createRuntimeProfile({
        accountKey: "profile-account",
        model: "gpt-profile",
        modeId: "full-access",
        thinkingOptionId: "xhigh",
      }),
    });
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: "C:\\dev\\paseo",
      runtimeProfileId: null,
      authProfileKey: "composer-account",
      model: "gpt-composer",
      modeId: "auto",
      thinkingOptionId: "low",
      profileSnapshot: {
        sourceProfileId: "profile-1",
        sourceProfileName: "Codex profile",
        sourceProfileVersion: 1,
        provider: "codex",
        accountKey: "profile-account",
        model: "gpt-profile",
        modeId: "full-access",
        thinkingOptionId: "xhigh",
        resolvedAt: NOW,
      },
    };

    const resolved = await resolver.resolve({
      agentId: "agent-1",
      config,
      normalizedConfig: config,
      resolveDefaultAuthProfile: false,
    });

    expect(resolved.snapshot).toMatchObject({
      provider: "codex",
      accountKey: "composer-account",
      model: "gpt-composer",
      modeId: "auto",
      thinkingOptionId: "low",
    });
    expect(resolved.snapshot.sourceProfileId).toBeUndefined();
    expect(resolved.config.profileSnapshot?.sourceProfileId).toBeUndefined();
  });

  test("ad-hoc snapshots are rebuilt from the current launch config", async () => {
    const resolver = createResolver({
      profile: createRuntimeProfile(),
    });
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: "C:\\dev\\paseo",
      runtimeProfileId: null,
      authProfileKey: "composer-account",
      model: "gpt-5.4",
      modeId: "full-access",
      thinkingOptionId: "medium",
      featureValues: {
        fast_mode: false,
      },
      profileSnapshot: {
        provider: "codex",
        accountKey: "composer-account",
        model: "gpt-5.5",
        modeId: "auto",
        thinkingOptionId: "xhigh",
        featureValues: {
          fast_mode: true,
        },
        resolvedAt: NOW,
      },
    };

    const resolved = await resolver.resolve({
      agentId: "agent-1",
      config,
      normalizedConfig: config,
      resolveDefaultAuthProfile: false,
    });

    expect(resolved.snapshot).toMatchObject({
      provider: "codex",
      accountKey: "composer-account",
      model: "gpt-5.4",
      modeId: "full-access",
      thinkingOptionId: "medium",
      featureValues: {
        fast_mode: false,
      },
    });
    expect(resolved.config.profileSnapshot).toMatchObject(resolved.snapshot);
  });

  test("runtime profile feature values win over composer feature preferences", async () => {
    const resolver = createResolver({
      profile: createRuntimeProfile({
        featureValues: {
          fast_mode: true,
          plan_mode: false,
        },
      }),
    });
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: "C:\\dev\\paseo",
      runtimeProfileId: "profile-1",
      featureValues: {
        fast_mode: false,
        plan_mode: true,
      },
    };

    const resolved = await resolver.resolve({
      agentId: "agent-1",
      config,
      normalizedConfig: config,
      resolveDefaultAuthProfile: false,
    });

    expect(resolved.config.featureValues).toEqual({
      fast_mode: true,
      plan_mode: false,
    });
    expect(resolved.snapshot.featureValues).toEqual({
      fast_mode: true,
      plan_mode: false,
    });
  });

  test("runtime profile instruction overlay is appended to the resolved system prompt", async () => {
    const resolver = createResolver({
      profile: createRuntimeProfile({
        instructionOverlay: "Prefer the repo workflow.",
      }),
    });
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: "C:\\dev\\paseo",
      runtimeProfileId: "profile-1",
      systemPrompt: "Base system prompt.",
    };

    const resolved = await resolver.resolve({
      agentId: "agent-1",
      config,
      normalizedConfig: config,
      resolveDefaultAuthProfile: false,
    });

    expect(resolved.config.systemPrompt).toBe("Base system prompt.\n\nPrefer the repo workflow.");
    expect(resolved.snapshot.systemPrompt).toBe("Base system prompt.\n\nPrefer the repo workflow.");
    expect(resolved.snapshot.instructionOverlay).toBe("Prefer the repo workflow.");
  });

  test("runtime profile environment cannot override launch identity or auth env", async () => {
    const resolver = createResolver({
      profile: createRuntimeProfile({
        accountKey: "profile-account",
        envOverlay: {
          CODEX_HOME: "C:\\profiles\\wrong",
          PASEO_AGENT_ID: "wrong-agent",
          CUSTOM_FLAG: "enabled",
        },
      }),
    });
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: "C:\\dev\\paseo",
      runtimeProfileId: "profile-1",
    };

    const resolved = await resolver.resolve({
      agentId: "agent-1",
      config,
      normalizedConfig: config,
      resolveDefaultAuthProfile: false,
    });

    expect(resolved.launchContext.env).toMatchObject({
      CODEX_HOME: "C:\\profiles\\profile-account",
      PASEO_AGENT_ID: "agent-1",
      CUSTOM_FLAG: "enabled",
    });
    expect(resolved.snapshot.envOverlay).toEqual({
      CUSTOM_FLAG: "enabled",
    });
  });

  test("warn concurrency returns launch warnings for active runtime profile conflicts", async () => {
    const resolver = createResolver({
      profile: createRuntimeProfile(),
    });
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: "C:\\dev\\paseo",
      runtimeProfileId: "profile-1",
    };

    const resolved = await resolver.resolve({
      agentId: "agent-2",
      config,
      normalizedConfig: config,
      resolveDefaultAuthProfile: false,
      activeAgents: [
        {
          agentId: "agent-1",
          profileSnapshot: {
            sourceProfileId: "profile-1",
            sourceProfileName: "Codex profile",
            sourceProfileVersion: 1,
            provider: "codex",
            resolvedAt: NOW,
            concurrencyPolicy: "warn",
          },
        },
      ],
    });

    expect(resolved.warnings).toEqual([
      {
        code: "runtime-profile-in-use",
        message: "Another active agent is already using runtime profile 'profile-1'.",
        accountKey: null,
        runtimeProfileId: "profile-1",
        agentIds: ["agent-1"],
      },
    ]);
  });

  test("single-active concurrency blocks active runtime profile conflicts", async () => {
    const resolver = createResolver({
      profile: createRuntimeProfile({ concurrencyPolicy: "single-active" }),
    });
    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: "C:\\dev\\paseo",
      runtimeProfileId: "profile-1",
    };

    await expect(
      resolver.resolve({
        agentId: "agent-2",
        config,
        normalizedConfig: config,
        resolveDefaultAuthProfile: false,
        activeAgents: [
          {
            agentId: "agent-1",
            profileSnapshot: {
              sourceProfileId: "profile-1",
              sourceProfileName: "Codex profile",
              sourceProfileVersion: 1,
              provider: "codex",
              resolvedAt: NOW,
              concurrencyPolicy: "single-active",
            },
          },
        ],
      }),
    ).rejects.toThrow("Cannot start another active agent with runtime profile 'profile-1'.");
  });
});

function createResolver({ profile }: { profile: RuntimeProfile }) {
  const runtimeProfileService = {
    getProfile: async (profileId: string) => (profileId === profile.id ? profile : null),
  } as unknown as RuntimeProfileService;
  const providerAuthService = {
    listProfiles: async () =>
      ["profile-account", "composer-account", "override-account"].map(createProviderAccount),
    syncCurrentProfile: async (provider: string) => ({ provider, status: "unsupported" }),
    resolveLaunchContext: async (selection: { authProfileKey?: string | null }) => ({
      profileKey: selection.authProfileKey ?? null,
      env: selection.authProfileKey
        ? { CODEX_HOME: `C:\\profiles\\${selection.authProfileKey}` }
        : undefined,
    }),
  } as unknown as ProviderAuthService;

  return new LaunchResolver({
    runtimeProfileService,
    providerAuthService,
    now: () => new Date(NOW),
  });
}

function createRuntimeProfile(patch: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: "profile-1",
    version: 1,
    name: "Codex profile",
    provider: "codex",
    concurrencyPolicy: "warn",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function createProviderAccount(key: string): ProviderAuthProfile {
  return {
    provider: "codex",
    key,
    alias: key,
    authMode: "chatgpt",
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
  };
}
