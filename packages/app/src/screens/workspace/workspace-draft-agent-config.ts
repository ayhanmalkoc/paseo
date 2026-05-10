import type { AgentSessionConfig } from "@server/server/agent/agent-sdk-types";

export function buildWorkspaceDraftAgentConfig(input: {
  provider: AgentSessionConfig["provider"];
  cwd: string;
  modeId?: string;
  model?: string;
  providerHomeRef?: AgentSessionConfig["providerHomeRef"];
  authProfileKey?: string;
  runtimeProfileId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}): AgentSessionConfig {
  if (input.runtimeProfileId) {
    return {
      provider: input.provider,
      cwd: input.cwd,
      runtimeProfileId: input.runtimeProfileId,
    };
  }
  const providerHomeRef =
    input.providerHomeRef ??
    (input.authProfileKey
      ? {
          kind: "managed-profile" as const,
          provider: input.provider,
          profileKey: input.authProfileKey,
        }
      : undefined);

  return {
    provider: input.provider,
    cwd: input.cwd,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(providerHomeRef ? { providerHomeRef } : {}),
    ...(input.runtimeProfileId ? { runtimeProfileId: input.runtimeProfileId } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.featureValues ? { featureValues: input.featureValues } : {}),
  };
}
