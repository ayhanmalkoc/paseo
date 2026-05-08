import { describe, expect, it } from "vitest";
import { resolveWorkspaceSetupDisplayState } from "./workspace-setup-display";
import type { WorkspaceSetupSnapshot } from "@/stores/workspace-setup-store";

function snapshot(input: Partial<WorkspaceSetupSnapshot>): WorkspaceSetupSnapshot {
  return {
    workspaceId: "workspace-1",
    status: "running",
    detail: {
      type: "worktree_setup",
      worktreePath: "/repo/worktree",
      branchName: "feature",
      log: "",
      commands: [],
    },
    error: null,
    updatedAt: Date.now(),
    ...input,
  };
}

describe("resolveWorkspaceSetupDisplayState", () => {
  it("shows an unavailable state instead of a waiting spinner when cached setup status is missing", () => {
    expect(resolveWorkspaceSetupDisplayState(null, "unavailable")).toEqual({
      statusLabel: "Status unavailable",
      isWaiting: false,
      hasNoSetupCommands: false,
      isStatusUnavailable: true,
    });
  });

  it("keeps waiting before a status lookup resolves", () => {
    expect(resolveWorkspaceSetupDisplayState(null, "loading")).toMatchObject({
      statusLabel: "Waiting for setup output",
      isWaiting: true,
      isStatusUnavailable: false,
    });
  });

  it("still treats running snapshots without command output as waiting", () => {
    expect(
      resolveWorkspaceSetupDisplayState(snapshot({ status: "running" }), "available"),
    ).toMatchObject({
      statusLabel: "Running",
      isWaiting: true,
      isStatusUnavailable: false,
    });
  });

  it("identifies completed setup with no commands or log as empty", () => {
    expect(
      resolveWorkspaceSetupDisplayState(snapshot({ status: "completed" }), "available"),
    ).toMatchObject({
      statusLabel: "Completed",
      isWaiting: false,
      hasNoSetupCommands: true,
    });
  });
});
