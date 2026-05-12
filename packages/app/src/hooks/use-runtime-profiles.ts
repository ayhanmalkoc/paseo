import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import type {
  AgentProvider,
  RuntimeProfile,
  RuntimeProfilePatch,
} from "@server/server/agent/agent-sdk-types";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function runtimeProfilesQueryKey(serverId: string | null, provider?: AgentProvider | null) {
  return ["runtimeProfiles", serverId, provider ?? "__all__"] as const;
}

export function runtimeProfilesServerQueryKey(serverId: string | null) {
  return ["runtimeProfiles", serverId] as const;
}

export function useRuntimeProfiles(serverId: string | null, provider?: AgentProvider | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryClient = useQueryClient();
  const isSupported = useSessionStore(
    useCallback(
      (state) =>
        serverId ? state.sessions[serverId]?.serverInfo?.features?.runtimeProfiles === true : false,
      [serverId],
    ),
  );
  const queryKey = useMemo(() => runtimeProfilesQueryKey(serverId, provider), [provider, serverId]);

  const query = useQuery({
    queryKey,
    enabled: Boolean(client && serverId && isSupported),
    queryFn: async () => {
      const response = await requireClient(client).listRuntimeProfiles({
        provider: provider ?? undefined,
      });
      return response.profiles;
    },
    staleTime: 10_000,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: runtimeProfilesServerQueryKey(serverId) });
  }, [queryClient, serverId]);

  const createMutation = useMutation({
    mutationFn: async (
      profile: RuntimeProfilePatch & { name: string; provider: AgentProvider },
    ) => {
      const response = await requireClient(client).createRuntimeProfile({ profile });
      return response.profile;
    },
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: { profileId: string; patch: RuntimeProfilePatch }) => {
      const response = await requireClient(client).updateRuntimeProfile(input);
      return response.profile;
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (profileId: string) => {
      await requireClient(client).deleteRuntimeProfile({ profileId });
    },
    onSuccess: invalidate,
  });

  useEffect(() => {
    if (!client || !serverId || !isSupported) {
      return;
    }
    return client.on("runtime_profiles_update", () => {
      void invalidate();
    });
  }, [client, invalidate, isSupported, serverId]);

  return {
    profiles: query.data ?? [],
    isLoading: query.isPending,
    isRefreshing:
      query.isFetching ||
      createMutation.isPending ||
      updateMutation.isPending ||
      deleteMutation.isPending,
    isSupported,
    error: query.error,
    create: createMutation.mutateAsync,
    update: updateMutation.mutateAsync,
    deleteProfile: deleteMutation.mutateAsync,
    refetch: async () => {
      await query.refetch();
    },
  };
}

function requireClient(client: DaemonClient | null): DaemonClient {
  if (!client) {
    throw new Error("Host is not connected");
  }
  return client;
}

export function resolveRuntimeProfileSummary(profile: RuntimeProfile): string {
  return [
    profile.provider,
    formatRuntimeProfileAccountSelection(profile),
    profile.model,
    profile.modeId,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatRuntimeProfileAccountSelection(profile: RuntimeProfile): string {
  if (profile.accountSelection?.kind === "inherit-provider-default") {
    return "provider default account";
  }
  if (profile.accountSelection?.kind === "native-default") {
    return "native default account";
  }
  if (profile.accountSelection?.kind === "managed-account") {
    return (
      profile.accountSelection.providerHomeRef.label ??
      profile.accountSelection.providerHomeRef.profileKey ??
      ""
    );
  }
  return profile.accountKey ?? "";
}
