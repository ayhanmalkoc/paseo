import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import type {
  McpServerConfig,
  ProviderNativeConfigSnapshot,
  ProviderNativeMcpServer,
} from "@server/shared/messages";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function providerNativeConfigQueryKey(
  serverId: string | null,
  provider?: AgentProvider | null,
) {
  return ["providerNativeConfig", serverId, provider ?? "__none__"] as const;
}

export function providerNativeMcpServersQueryKey(
  serverId: string | null,
  provider?: AgentProvider | null,
) {
  return ["providerNativeMcpServers", serverId, provider ?? "__none__"] as const;
}

export function isProviderNativeConfigSupported(
  features:
    | {
        providerNativeConfig?: boolean;
        providerNativeConfigProviders?: readonly AgentProvider[];
        providerNativeConfigSourceSync?: boolean;
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

export function isProviderNativeConfigSourceSyncSupported(
  features:
    | {
        providerNativeConfig?: boolean;
        providerNativeConfigProviders?: readonly AgentProvider[];
        providerNativeConfigSourceSync?: boolean;
      }
    | null
    | undefined,
  provider?: AgentProvider | null,
): boolean {
  return (
    features?.providerNativeConfigSourceSync === true &&
    isProviderNativeConfigSupported(features, provider)
  );
}

export function useProviderNativeConfigSourceSyncSupport(
  serverId: string | null,
  provider?: AgentProvider | null,
): boolean {
  return useSessionStore(
    useCallback(
      (state) =>
        serverId
          ? isProviderNativeConfigSourceSyncSupported(
              state.sessions[serverId]?.serverInfo?.features,
              provider,
            )
          : false,
      [provider, serverId],
    ),
  );
}

export function useProviderNativeConfig(serverId: string | null, provider?: AgentProvider | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryClient = useQueryClient();
  const isSupported = useProviderNativeConfigSupport(serverId, provider);
  const queryKey = useMemo(
    () => providerNativeConfigQueryKey(serverId, provider),
    [provider, serverId],
  );

  const query = useQuery({
    queryKey,
    enabled: Boolean(client && serverId && provider && isSupported),
    queryFn: async () => {
      const response = await requireClient(client).readProviderNativeConfig({
        provider: requireProvider(provider),
      });
      return response.config;
    },
    staleTime: 5_000,
  });

  const saveMutation = useMutation({
    mutationFn: async (content: string) => {
      const response = await requireClient(client).writeProviderNativeConfig({
        provider: requireProvider(provider),
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

export function useSyncProviderNativeConfigFromSource(
  serverId: string | null,
  provider?: AgentProvider | null,
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryClient = useQueryClient();
  const isSupported = useProviderNativeConfigSourceSyncSupport(serverId, provider);

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await requireClient(client).syncProviderNativeConfigFromSource({
        provider: requireProvider(provider),
      });
      return response.config;
    },
    onSuccess: async (config) => {
      const configQueryKey = providerNativeConfigQueryKey(serverId, provider);
      const mcpQueryKey = providerNativeMcpServersQueryKey(serverId, provider);
      queryClient.setQueryData<ProviderNativeConfigSnapshot>(configQueryKey, config);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: configQueryKey }),
        queryClient.invalidateQueries({ queryKey: mcpQueryKey }),
      ]);
    },
  });

  return {
    sync: syncMutation.mutateAsync,
    isSyncing: syncMutation.isPending,
    isSupported,
    error: formatError(syncMutation.error),
  };
}

export function useProviderNativeMcpServers(
  serverId: string | null,
  provider?: AgentProvider | null,
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryClient = useQueryClient();
  const isSupported = useProviderNativeConfigSupport(serverId, provider);
  const queryKey = useMemo(
    () => providerNativeMcpServersQueryKey(serverId, provider),
    [provider, serverId],
  );
  const configQueryKey = useMemo(
    () => providerNativeConfigQueryKey(serverId, provider),
    [provider, serverId],
  );

  const query = useQuery({
    queryKey,
    enabled: Boolean(client && serverId && provider && isSupported),
    queryFn: async () => {
      const response = await requireClient(client).listProviderNativeMcpServers({
        provider: requireProvider(provider),
      });
      return response.servers;
    },
    staleTime: 5_000,
  });

  const upsertMutation = useMutation({
    mutationFn: async (input: { id: string; config: McpServerConfig; enabled?: boolean }) => {
      const response = await requireClient(client).upsertProviderNativeMcpServer({
        provider: requireProvider(provider),
        id: input.id,
        config: input.config,
        enabled: input.enabled,
      });
      return response.server;
    },
    onSuccess: async (server: ProviderNativeMcpServer) => {
      queryClient.setQueryData<ProviderNativeMcpServer[]>(queryKey, (servers) => {
        const nextServers = servers ? [...servers] : [];
        const index = nextServers.findIndex((candidate) => candidate.id === server.id);
        if (index >= 0) {
          nextServers[index] = server;
        } else {
          nextServers.push(server);
        }
        return nextServers.sort(compareProviderNativeMcpServers);
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: configQueryKey }),
      ]);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      await requireClient(client).removeProviderNativeMcpServer({
        provider: requireProvider(provider),
        id,
      });
      return id;
    },
    onSuccess: async (id: string) => {
      queryClient.setQueryData<ProviderNativeMcpServer[]>(queryKey, (servers) =>
        (servers ?? []).filter((server) => server.id !== id),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: configQueryKey }),
      ]);
    },
  });

  return {
    servers: query.data ?? [],
    isLoading: query.isPending,
    isRefreshing: query.isFetching || upsertMutation.isPending || removeMutation.isPending,
    isSaving: upsertMutation.isPending || removeMutation.isPending,
    isSupported,
    error: formatError(query.error ?? upsertMutation.error ?? removeMutation.error),
    upsert: upsertMutation.mutateAsync,
    remove: removeMutation.mutateAsync,
    refetch: async () => {
      await query.refetch();
    },
  };
}

function compareProviderNativeMcpServers(
  left: ProviderNativeMcpServer,
  right: ProviderNativeMcpServer,
): number {
  return left.id.localeCompare(right.id);
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

function formatError(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
