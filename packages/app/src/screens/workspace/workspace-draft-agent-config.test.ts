import { describe, expect, it } from "vitest";
import { buildWorkspaceDraftAgentConfig } from "./workspace-draft-agent-config";

describe("workspace-draft-agent-config", () => {
  it("uses runtime profile as the authoritative launch selection", () => {
    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "codex",
        cwd: "/tmp/project",
        modeId: "auto",
        model: "gpt-5.4",
        accountKey: "codex-profile",
        runtimeProfileId: "codex-runtime-profile",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/tmp/project",
      runtimeProfileId: "codex-runtime-profile",
    });
  });

  it("keeps ad-hoc launch selections when no runtime profile is selected", () => {
    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "codex",
        cwd: "/tmp/project",
        modeId: "auto",
        model: "gpt-5.4",
        accountKey: "codex-profile",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "auto",
      model: "gpt-5.4",
      providerHomeRef: {
        kind: "managed-profile",
        provider: "codex",
        profileKey: "codex-profile",
      },
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
    });
  });
});
