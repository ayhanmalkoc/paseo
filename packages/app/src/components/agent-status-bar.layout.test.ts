import { describe, expect, it } from "vitest";
import {
  resolveAgentStatusBarSurface,
  shouldSplitAgentStatusBarControls,
} from "./agent-status-bar.utils";

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

describe("shouldSplitAgentStatusBarControls", () => {
  it("splits model and preferences controls only on compact web", () => {
    expect(shouldSplitAgentStatusBarControls({ isWeb: true, isCompact: true })).toBe(true);
    expect(shouldSplitAgentStatusBarControls({ isWeb: true, isCompact: false })).toBe(false);
    expect(shouldSplitAgentStatusBarControls({ isWeb: false, isCompact: true })).toBe(false);
    expect(shouldSplitAgentStatusBarControls({ isWeb: false, isCompact: false })).toBe(false);
  });
});
