import type {
  AgentProfileSnapshot,
  RuntimeLaunchWarning,
  RuntimeProfileConcurrencyPolicy,
} from "./agent-sdk-types.js";
import { getProviderHomeRefKey } from "./provider-home-ref.js";

export interface AccountLeaseSnapshot {
  agentId: string;
  profileSnapshot?: AgentProfileSnapshot;
}

export class AccountLeaseCoordinator {
  evaluate(input: {
    candidate: AgentProfileSnapshot;
    activeAgents: AccountLeaseSnapshot[];
    excludeAgentId?: string;
  }): RuntimeLaunchWarning[] {
    const policy = input.candidate.concurrencyPolicy ?? "allow";
    if (policy === "allow") {
      return [];
    }

    const conflictingAgents = this.findConflicts(input);
    if (conflictingAgents.length === 0) {
      return [];
    }

    const warning = buildWarning(policy, input.candidate, conflictingAgents);
    if (policy === "single-active") {
      throw new AccountLeaseConflictError(warning.message, warning);
    }
    return [warning];
  }

  private findConflicts(input: {
    candidate: AgentProfileSnapshot;
    activeAgents: AccountLeaseSnapshot[];
    excludeAgentId?: string;
  }): AccountLeaseSnapshot[] {
    return input.activeAgents.filter((agent) => {
      if (agent.agentId === input.excludeAgentId) {
        return false;
      }
      const snapshot = agent.profileSnapshot;
      if (!snapshot) {
        return false;
      }
      const candidateHomeKey = getProviderHomeRefKey(input.candidate.providerHomeRef);
      const snapshotHomeKey = getProviderHomeRefKey(snapshot.providerHomeRef);
      if (candidateHomeKey && candidateHomeKey === snapshotHomeKey) {
        return true;
      }
      // COMPAT(providerHomeRef): old snapshots may only carry accountKey.
      if (
        !candidateHomeKey &&
        input.candidate.accountKey &&
        snapshot.accountKey === input.candidate.accountKey
      ) {
        return true;
      }
      return Boolean(
        input.candidate.sourceProfileId &&
        snapshot.sourceProfileId === input.candidate.sourceProfileId,
      );
    });
  }
}

export class AccountLeaseConflictError extends Error {
  constructor(
    message: string,
    readonly warning: RuntimeLaunchWarning,
  ) {
    super(message);
    this.name = "AccountLeaseConflictError";
  }
}

function buildWarning(
  policy: RuntimeProfileConcurrencyPolicy,
  candidate: AgentProfileSnapshot,
  agents: AccountLeaseSnapshot[],
): RuntimeLaunchWarning {
  const agentIds = agents.map((agent) => agent.agentId);
  const providerHomeRef =
    candidate.sourceProfileId && candidate.providerHomeRef?.kind === "native-default"
      ? null
      : (candidate.providerHomeRef ?? null);
  const accountKey = candidate.accountKey ?? null;
  const runtimeProfileId = candidate.sourceProfileId ?? null;
  const target = describeLeaseTarget(providerHomeRef, accountKey, runtimeProfileId);
  const message =
    policy === "single-active"
      ? `Cannot start another active agent with ${target}.`
      : `Another active agent is already using ${target}.`;
  return {
    code: providerHomeRef || accountKey ? "account-in-use" : "runtime-profile-in-use",
    message,
    ...(providerHomeRef ? { providerHomeRef } : {}),
    accountKey,
    runtimeProfileId,
    agentIds,
  };
}

function describeLeaseTarget(
  providerHomeRef: AgentProfileSnapshot["providerHomeRef"] | null,
  accountKey: string | null,
  runtimeProfileId: string | null,
): string {
  if (providerHomeRef) {
    if (providerHomeRef.kind === "managed-profile" && providerHomeRef.profileKey) {
      return `provider home '${providerHomeRef.profileKey}'`;
    }
    return "native provider home";
  }
  if (accountKey && runtimeProfileId) {
    return `account '${accountKey}' and runtime profile '${runtimeProfileId}'`;
  }
  if (accountKey) {
    return `account '${accountKey}'`;
  }
  return `runtime profile '${runtimeProfileId}'`;
}
