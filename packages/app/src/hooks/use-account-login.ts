import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import type {
  AccountLoginMethod,
  AccountLoginSession,
  AgentProvider,
} from "@server/server/agent/agent-sdk-types";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { providerAuthProfilesServerQueryKey } from "./use-provider-auth-profiles";

export function accountLoginSessionsQueryKey(
  serverId: string | null,
  provider?: AgentProvider | null,
) {
  return ["accountLoginSessions", serverId, provider ?? "__all__"] as const;
}

export function accountLoginMethodsQueryKey(
  serverId: string | null,
  provider?: AgentProvider | null,
) {
  return ["accountLoginMethods", serverId, provider ?? "__none__"] as const;
}

export function useAccountLogin(serverId: string | null, provider?: AgentProvider | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryClient = useQueryClient();
  const isSupported = useSessionStore(
    useCallback(
      (state) =>
        serverId
          ? state.sessions[serverId]?.serverInfo?.features?.providerAccountOnboarding === true
          : false,
      [serverId],
    ),
  );
  const sessionsKey = useMemo(
    () => accountLoginSessionsQueryKey(serverId, provider),
    [provider, serverId],
  );
  const methodsKey = useMemo(
    () => accountLoginMethodsQueryKey(serverId, provider),
    [provider, serverId],
  );

  const methodsQuery = useQuery({
    queryKey: methodsKey,
    enabled: Boolean(client && serverId && provider && isSupported),
    queryFn: async () => {
      const response = await requireClient(client).listAccountLoginMethods({
        provider: requireProvider(provider),
      });
      return response.methods;
    },
    staleTime: 60_000,
  });

  const sessionsQuery = useQuery({
    queryKey: sessionsKey,
    enabled: Boolean(client && serverId && isSupported),
    queryFn: async () => {
      const response = await requireClient(client).listAccountLoginSessions({
        provider: provider ?? undefined,
      });
      return response.sessions;
    },
    refetchInterval: (query) => {
      const sessions = query.state.data ?? [];
      return sessions.some((session) => isLoginInFlight(session.status)) ? 2_000 : false;
    },
    staleTime: 5_000,
  });

  const invalidateSessions = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["accountLoginSessions", serverId] });
  }, [queryClient, serverId]);

  useEffect(() => {
    if (!client || !serverId || !isSupported) {
      return;
    }
    return client.on("account_login_update", (message) => {
      const session = message.payload.session;
      queryClient.setQueryData<AccountLoginSession[] | undefined>(
        accountLoginSessionsQueryKey(serverId, session.provider),
        (current) => mergeSession(current, session),
      );
      queryClient.setQueryData<AccountLoginSession[] | undefined>(
        accountLoginSessionsQueryKey(serverId),
        (current) => mergeSession(current, session),
      );
      if (session.status === "completed") {
        void queryClient.invalidateQueries({
          queryKey: providerAuthProfilesServerQueryKey(serverId),
        });
      }
    });
  }, [client, isSupported, queryClient, serverId]);

  const startMutation = useMutation({
    mutationFn: async (options: { method: AccountLoginMethod; setDefault?: boolean }) => {
      const response = await requireClient(client).startAccountLogin({
        provider: requireProvider(provider),
        method: options.method,
        setDefault: options.setDefault,
      });
      return response.session;
    },
    onSuccess: invalidateSessions,
  });

  const cancelMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const response = await requireClient(client).cancelAccountLogin({ sessionId });
      return response.session;
    },
    onSuccess: invalidateSessions,
  });

  return {
    isSupported,
    methods: methodsQuery.data ?? [],
    sessions: sessionsQuery.data ?? [],
    isLoading: methodsQuery.isPending || sessionsQuery.isPending,
    isRefreshing:
      methodsQuery.isFetching ||
      sessionsQuery.isFetching ||
      startMutation.isPending ||
      cancelMutation.isPending,
    error: methodsQuery.error ?? sessionsQuery.error,
    start: startMutation.mutateAsync,
    cancel: cancelMutation.mutateAsync,
    refetch: async () => {
      await Promise.all([methodsQuery.refetch(), sessionsQuery.refetch()]);
    },
  };
}

function requireClient(client: DaemonClient | null): DaemonClient {
  if (!client) {
    throw new Error("Host is not connected");
  }
  return client;
}

function requireProvider(provider: AgentProvider | null | undefined): AgentProvider {
  if (!provider) {
    throw new Error("Provider is required");
  }
  return provider;
}

function isLoginInFlight(status: AccountLoginSession["status"]): boolean {
  return status === "starting" || status === "pending-user" || status === "importing";
}

function mergeSession(
  current: AccountLoginSession[] | undefined,
  session: AccountLoginSession,
): AccountLoginSession[] {
  const rest = (current ?? []).filter((entry) => entry.id !== session.id);
  return [session, ...rest].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}
