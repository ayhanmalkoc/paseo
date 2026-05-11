import { describe, expect, it } from "vitest";

import {
  formatProviderAuthUsageSummary,
  formatProviderAuthUsageWarning,
} from "./provider-auth-usage";

describe("provider auth usage formatting", () => {
  it("summarizes primary and secondary windows", () => {
    expect(
      formatProviderAuthUsageSummary({
        source: "local-rollout",
        primaryUsedPercent: 76,
        primaryWindowMinutes: 300,
        secondaryUsedPercent: 56,
        secondaryWindowMinutes: 10_080,
        refreshedAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toBe("24% 5h left / 44% weekly left");
  });

  it("surfaces near-limit state with the dominant window", () => {
    expect(
      formatProviderAuthUsageSummary({
        source: "local-rollout",
        primaryUsedPercent: 94,
        primaryWindowMinutes: 10_080,
        secondaryUsedPercent: 20,
        secondaryWindowMinutes: 300,
        limitState: "near-limit",
        refreshedAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toBe("Near limit: 6% weekly left");
  });

  it("returns a warning only when the account is constrained", () => {
    expect(
      formatProviderAuthUsageWarning({
        source: "local-rollout",
        primaryUsedPercent: 100,
        primaryWindowMinutes: 300,
        limitState: "limited",
        refreshedAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toBe("This account appears to be at its usage limit: 0% 5h left");

    expect(
      formatProviderAuthUsageWarning({
        source: "local-rollout",
        primaryUsedPercent: 50,
        primaryWindowMinutes: 300,
        limitState: "ok",
        refreshedAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toBeNull();
  });
});
