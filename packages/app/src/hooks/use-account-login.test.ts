import { describe, expect, it, vi } from "vitest";

import { isProviderAccountOnboardingSupported } from "./use-account-login";

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: () => false,
}));

describe("provider account onboarding support", () => {
  it("keeps old global feature behavior when daemon does not send provider list", () => {
    expect(
      isProviderAccountOnboardingSupported({ providerAccountOnboarding: true }, "opencode"),
    ).toBe(true);
  });

  it("uses provider list when daemon sends one", () => {
    const features = {
      providerAccountOnboarding: true,
      providerAccountOnboardingProviders: ["codex"] as const,
    };

    expect(isProviderAccountOnboardingSupported(features, "codex")).toBe(true);
    expect(isProviderAccountOnboardingSupported(features, "opencode")).toBe(false);
    expect(isProviderAccountOnboardingSupported(features, null)).toBe(true);
  });
});
