import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import type { ProviderNativeConfigSnapshot } from "@server/shared/messages";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function providerNativeConfigQueryKey(
  serverId: string | null,
  provider?: AgentProvider | null,
  profileKey?: string | null,
) {
  return [
    "providerNativeConfig",
    serverId,
    provider ?? "__none__",
    profileKey ?? "__none__",
  ] as const;
}

export function isProviderNativeConfigSupported(
  features:
    | {
        providerNativeConfig?: boolean;
        providerNativeConfigProviders?: readonly AgentProvider[];
      }
    | null
    | undefined,
  provider?: AgentProvider | null,
): boolean {
  if (features?.providerNativeConfig !== true) {
    return false;
  }
  if (!provider || !features.providerNativeConfigProviders) {
    return true;
  }
  return features.providerNativeConfigProviders.includes(provider);
}

export function useProviderNativeConfigSupport(
  serverId: string | null,
  provider?: AgentProvider | null,
): boolean {
  return useSessionStore(
    useCallback(
      (state) =>
        serverId
          ? isProviderNativeConfigSupported(
              state.sessions[serverId]?.serverInfo?.features,
              provider,
            )
          : false,
      [provider, serverId],
    ),
  );
}

export function useProviderNativeConfig(
  serverId: string | null,
  provider?: AgentProvider | null,
  profileKey?: string | null,
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryClient = useQueryClient();
  const isSupported = useProviderNativeConfigSupport(serverId, provider);
  const queryKey = useMemo(
    () => providerNativeConfigQueryKey(serverId, provider, profileKey),
    [profileKey, provider, serverId],
  );

  const query = useQuery({
    queryKey,
    enabled: Boolean(client && serverId && provider && profileKey && isSupported),
    queryFn: async () => {
      const response = await requireClient(client).readProviderNativeConfig({
        provider: requireProvider(provider),
        profileKey: requireProfileKey(profileKey),
      });
      return response.config;
    },
    staleTime: 5_000,
  });

  const saveMutation = useMutation({
    mutationFn: async (content: string) => {
      const response = await requireClient(client).writeProviderNativeConfig({
        provider: requireProvider(provider),
        profileKey: requireProfileKey(profileKey),
        content,
      });
      return response.config;
    },
    onSuccess: async (config: ProviderNativeConfigSnapshot) => {
      queryClient.setQueryData(queryKey, config);
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    config: query.data,
    isLoading: query.isPending,
    isRefreshing: query.isFetching || saveMutation.isPending,
    isSaving: saveMutation.isPending,
    isSupported,
    error: formatError(query.error ?? saveMutation.error),
    save: saveMutation.mutateAsync,
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

function requireProvider(provider?: AgentProvider | null): AgentProvider {
  if (!provider) {
    throw new Error("Provider is required");
  }
  return provider;
}

function requireProfileKey(profileKey?: string | null): string {
  if (!profileKey) {
    throw new Error("Account is required");
  }
  return profileKey;
}

function formatError(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
