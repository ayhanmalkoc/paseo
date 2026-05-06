import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import type { AgentProvider, ProviderAuthProfile } from "@server/server/agent/agent-sdk-types";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function providerAuthProfilesQueryKey(
  serverId: string | null,
  provider?: AgentProvider | null,
) {
  return ["providerAuthProfiles", serverId, provider ?? "__all__"] as const;
}

export interface UseProviderAuthProfilesResult {
  profiles: ProviderAuthProfile[] | undefined;
  isLoading: boolean;
  isRefreshing: boolean;
  isSupported: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  importCurrent: (options?: {
    alias?: string;
    setDefault?: boolean;
  }) => Promise<ProviderAuthProfile>;
  remove: (profileKey: string) => Promise<void>;
  setDefault: (profileKey: string | null) => Promise<void>;
  refreshProfile: (profileKey: string) => Promise<ProviderAuthProfile>;
}

export function useProviderAuthProfiles(
  serverId: string | null,
  provider?: AgentProvider | null,
): UseProviderAuthProfilesResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryClient = useQueryClient();
  const isSupported = useSessionStore(
    useCallback(
      (state) =>
        serverId
          ? state.sessions[serverId]?.serverInfo?.features?.providerAuthProfiles === true
          : false,
      [serverId],
    ),
  );
  const queryKey = useMemo(
    () => providerAuthProfilesQueryKey(serverId, provider),
    [serverId, provider],
  );

  const query = useQuery({
    queryKey,
    enabled: Boolean(client && serverId && isSupported),
    queryFn: async () => {
      const response = await requireClient(client).listProviderAuthProfiles({
        provider: provider ?? undefined,
      });
      return response.profiles;
    },
    staleTime: 15_000,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const importMutation = useMutation({
    mutationFn: async (options?: { alias?: string; setDefault?: boolean }) => {
      if (!provider) {
        throw new Error("Provider is required");
      }
      const response = await requireClient(client).importProviderAuthProfile({
        provider,
        source: "current",
        alias: options?.alias,
        setDefault: options?.setDefault,
      });
      return response.profile;
    },
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: async (profileKey: string) => {
      if (!provider) {
        throw new Error("Provider is required");
      }
      await requireClient(client).removeProviderAuthProfile({ provider, profileKey });
    },
    onSuccess: invalidate,
  });

  const setDefaultMutation = useMutation({
    mutationFn: async (profileKey: string | null) => {
      if (!provider) {
        throw new Error("Provider is required");
      }
      await requireClient(client).setDefaultProviderAuthProfile({ provider, profileKey });
    },
    onSuccess: invalidate,
  });

  const refreshMutation = useMutation({
    mutationFn: async (profileKey: string) => {
      if (!provider) {
        throw new Error("Provider is required");
      }
      const response = await requireClient(client).refreshProviderAuthProfile({
        provider,
        profileKey,
      });
      return response.profile;
    },
    onSuccess: invalidate,
  });

  return {
    profiles: query.data,
    isLoading: query.isPending,
    isRefreshing:
      query.isFetching ||
      importMutation.isPending ||
      removeMutation.isPending ||
      setDefaultMutation.isPending ||
      refreshMutation.isPending,
    isSupported,
    error: query.error,
    refetch: async () => {
      await query.refetch();
    },
    importCurrent: importMutation.mutateAsync,
    remove: removeMutation.mutateAsync,
    setDefault: setDefaultMutation.mutateAsync,
    refreshProfile: refreshMutation.mutateAsync,
  };
}

function requireClient(client: DaemonClient | null): DaemonClient {
  if (!client) {
    throw new Error("Host is not connected");
  }
  return client;
}
