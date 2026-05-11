import { describe, expect, it } from "vitest";

import { parseCodexAppServerUsageResponse } from "./codex-app-server-usage.js";

describe("parseCodexAppServerUsageResponse", () => {
  it("maps Codex app-server rate limits into provider usage", () => {
    const usage = parseCodexAppServerUsageResponse(
      {
        rateLimits: {
          limitId: "fallback",
          primary: {
            usedPercent: 99,
            windowDurationMins: 300,
            resetsAt: 1_778_494_841,
          },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 12,
              windowDurationMins: 300,
              resetsAt: 1_778_494_841,
            },
            secondary: {
              usedPercent: 64,
              windowDurationMins: 10_080,
              resetsAt: 1_778_942_355_000,
            },
            credits: {
              hasCredits: true,
              unlimited: false,
              balance: "42",
            },
            planType: "plus",
            rateLimitReachedType: null,
          },
        },
      },
      () => new Date("2026-05-06T12:00:00.000Z"),
    );

    expect(usage).toEqual({
      source: "provider-api",
      primaryUsedPercent: 12,
      primaryWindowMinutes: 300,
      primaryResetsAt: new Date(1_778_494_841 * 1000).toISOString(),
      secondaryUsedPercent: 64,
      secondaryWindowMinutes: 10_080,
      secondaryResetsAt: new Date(1_778_942_355_000).toISOString(),
      creditsRemaining: 42,
      limitState: "ok",
      refreshedAt: "2026-05-06T12:00:00.000Z",
    });
  });

  it("marks provider usage limited when app-server reports a reached limit", () => {
    const usage = parseCodexAppServerUsageResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: 30,
            windowDurationMins: 300,
            resetsAt: null,
          },
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: "0",
          },
          rateLimitReachedType: "workspace_member_usage_limit_reached",
        },
      },
      () => new Date("2026-05-06T12:00:00.000Z"),
    );

    expect(usage).toMatchObject({
      source: "provider-api",
      primaryUsedPercent: 30,
      limitState: "limited",
    });
    expect(usage?.creditsRemaining).toBe(0);
  });
});
