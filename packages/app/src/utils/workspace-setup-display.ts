import type { WorkspaceSetupSnapshot } from "@/stores/workspace-setup-store";

export type WorkspaceSetupStatusLookupState = "idle" | "loading" | "available" | "unavailable";

export interface WorkspaceSetupDisplayState {
  statusLabel: string;
  isWaiting: boolean;
  hasNoSetupCommands: boolean;
  isStatusUnavailable: boolean;
}

export function resolveWorkspaceSetupDisplayState(
  snapshot: WorkspaceSetupSnapshot | null,
  lookupState: WorkspaceSetupStatusLookupState,
): WorkspaceSetupDisplayState {
  const commands = snapshot?.detail.commands ?? [];
  const log = snapshot?.detail.log ?? "";
  const isStatusUnavailable = !snapshot && lookupState === "unavailable";
  const isWaiting =
    !isStatusUnavailable && (!snapshot || (snapshot.status === "running" && commands.length === 0));
  const hasNoSetupCommands =
    snapshot?.status === "completed" && commands.length === 0 && log.trim().length === 0;

  return {
    statusLabel: resolveSetupStatusLabel(snapshot?.status, isStatusUnavailable),
    isWaiting,
    hasNoSetupCommands,
    isStatusUnavailable,
  };
}

function resolveSetupStatusLabel(status: string | undefined, isStatusUnavailable: boolean): string {
  if (isStatusUnavailable) return "Status unavailable";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Waiting for setup output";
}
