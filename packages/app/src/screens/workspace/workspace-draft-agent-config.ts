import type { AgentSessionConfig } from "@server/server/agent/agent-sdk-types";

export function buildWorkspaceDraftAgentConfig(input: {
  provider: AgentSessionConfig["provider"];
  cwd: string;
  modeId?: string;
  model?: string;
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

  return {
    provider: input.provider,
    cwd: input.cwd,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.authProfileKey ? { authProfileKey: input.authProfileKey } : {}),
    ...(input.runtimeProfileId ? { runtimeProfileId: input.runtimeProfileId } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.featureValues ? { featureValues: input.featureValues } : {}),
  };
}
