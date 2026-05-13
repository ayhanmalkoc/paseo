import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import type {
  McpRegistryEntry,
  McpRegistryEntryInput,
  McpRegistryScope,
  McpServerConfig,
} from "@server/shared/messages";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function mcpRegistryQueryKey(serverId: string | null) {
  return ["mcpRegistry", serverId] as const;
}

interface ExplainMcpRegistryInput {
  provider: AgentProvider;
  accountKey?: string;
  runtimeProfileId?: string;
  sessionMcpServers?: Record<string, McpServerConfig>;
  includeSystem?: boolean;
}

export function useMcpRegistry(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryClient = useQueryClient();
  const isSupported = useSessionStore(
    useCallback(
      (state) =>
        serverId ? state.sessions[serverId]?.serverInfo?.features?.mcpRegistry === true : false,
      [serverId],
    ),
  );
  const queryKey = useMemo(() => mcpRegistryQueryKey(serverId), [serverId]);

  const query = useQuery({
    queryKey,
    enabled: Boolean(client && serverId && isSupported),
    queryFn: async () => {
      const response = await requireClient(client).listMcpRegistryEntries();
      return response.entries;
    },
    staleTime: 10_000,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const upsertMutation = useMutation({
    mutationFn: async (entry: McpRegistryEntryInput) => {
      const response = await requireClient(client).upsertMcpRegistryEntry({ entry });
      return response.entry;
    },
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: async (input: { id: string; scope: McpRegistryScope }) => {
      return requireClient(client).removeMcpRegistryEntry(input);
    },
    onSuccess: invalidate,
  });

  const importMutation = useMutation({
    mutationFn: async (input: { provider: AgentProvider; path?: string }) => {
      return requireClient(client).importMcpRegistryEntries({
        provider: input.provider,
        source: "native",
        path: input.path,
      });
    },
    onSuccess: invalidate,
  });

  const explain = useCallback(
    async (input: ExplainMcpRegistryInput) => {
      return requireClient(client).explainMcpRegistry(input);
    },
    [client],
  );

  return {
    entries: query.data ?? [],
    isLoading: query.isPending,
    isRefreshing:
      query.isFetching ||
      upsertMutation.isPending ||
      removeMutation.isPending ||
      importMutation.isPending,
    isSupported,
    error: formatError(query.error),
    upsert: upsertMutation.mutateAsync,
    remove: removeMutation.mutateAsync,
    importNative: importMutation.mutateAsync,
    explain,
    refetch: async () => {
      await query.refetch();
    },
  };
}

export function toMcpRegistryEntryInput(
  entry: McpRegistryEntry,
  patch: Partial<Pick<McpRegistryEntryInput, "enabled" | "config">> = {},
): McpRegistryEntryInput {
  return {
    id: entry.id,
    scope: entry.scope,
    config: patch.config ?? entry.config,
    enabled: patch.enabled ?? entry.enabled,
    source: entry.source,
    importedFrom: entry.importedFrom,
  };
}

function requireClient(client: DaemonClient | null): DaemonClient {
  if (!client) {
    throw new Error("Host is not connected");
  }
  return client;
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
