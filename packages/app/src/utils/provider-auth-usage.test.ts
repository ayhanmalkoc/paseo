import { describe, expect, it } from "vitest";

import {
  formatProviderAuthUsageSummary,
  formatProviderAuthUsageWarning,
} from "./provider-auth-usage";

describe("provider auth usage formatting", () => {
  it("summarizes primary and secondary windows", () => {
    const primaryResetsAt = "2026-05-11T12:21:00.000Z";
    const secondaryResetsAt = "2026-05-13T14:59:00.000Z";
    const primaryResetLabel = new Date(primaryResetsAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const secondaryResetLabel = new Date(secondaryResetsAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    expect(
      formatProviderAuthUsageSummary({
        source: "provider-api",
        primaryUsedPercent: 76,
        primaryWindowMinutes: 300,
        primaryResetsAt,
        secondaryUsedPercent: 56,
        secondaryWindowMinutes: 10_080,
        secondaryResetsAt,
        refreshedAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toBe(
      `24% 5h left · resets ${primaryResetLabel}\n44% weekly left · resets ${secondaryResetLabel}`,
    );
  });

  it("summarizes near-limit usage without changing the display format", () => {
    expect(
      formatProviderAuthUsageSummary({
        source: "provider-api",
        primaryUsedPercent: 94,
        primaryWindowMinutes: 10_080,
        secondaryUsedPercent: 20,
        secondaryWindowMinutes: 300,
        limitState: "near-limit",
        refreshedAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toBe("6% weekly left\n80% 5h left");
  });

  it("returns a warning only when the account is constrained", () => {
    expect(
      formatProviderAuthUsageWarning({
        source: "provider-api",
        primaryUsedPercent: 100,
        primaryWindowMinutes: 300,
        limitState: "limited",
        refreshedAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toBe("This account appears to be at its usage limit: 0% 5h left");

    expect(
      formatProviderAuthUsageWarning({
        source: "provider-api",
        primaryUsedPercent: 50,
        primaryWindowMinutes: 300,
        limitState: "ok",
        refreshedAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toBeNull();
  });
});
