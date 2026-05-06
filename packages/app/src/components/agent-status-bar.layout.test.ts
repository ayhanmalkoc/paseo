import { describe, expect, it } from "vitest";
import { resolveAgentStatusBarSurface } from "./agent-status-bar.utils";

describe("resolveAgentStatusBarSurface", () => {
  it("uses inline desktop controls only on non-compact web", () => {
    expect(resolveAgentStatusBarSurface({ isWeb: true, isCompact: false })).toBe("desktop");
  });

  it("uses the sheet controls on compact web", () => {
    expect(resolveAgentStatusBarSurface({ isWeb: true, isCompact: true })).toBe("sheet");
  });

  it("keeps native platforms on the sheet controls", () => {
    expect(resolveAgentStatusBarSurface({ isWeb: false, isCompact: false })).toBe("sheet");
    expect(resolveAgentStatusBarSurface({ isWeb: false, isCompact: true })).toBe("sheet");
  });
});
