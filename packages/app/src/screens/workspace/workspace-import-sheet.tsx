import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, type PressableStateCallbackType, ScrollView, Text, View } from "react-native";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient, FetchRecentProviderSessionEntry } from "@server/client/daemon-client";
import type {
  AgentProvider,
  ProviderAuthProfile,
  ProviderHomeRef,
} from "@server/server/agent/agent-sdk-types";
import { IMPORTABLE_PROVIDERS } from "@server/shared/importable-providers";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { getProviderIcon } from "@/components/provider-icons";
import { formatTimeAgo } from "@/utils/time";
import { isWeb } from "@/constants/platform";
import { useProviderAuthProfiles } from "@/hooks/use-provider-auth-profiles";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  formatProviderAuthUsageSummary,
  formatProviderAuthUsageWarning,
} from "@/utils/provider-auth-usage";

const IMPORTABLE_PROVIDER_IDS: Set<string> = new Set(IMPORTABLE_PROVIDERS);
const PER_PROVIDER_LIMIT = 15;
const IMPORT_SHEET_SNAP_POINTS = ["70%", "92%"];
const DISABLED_ACCESSIBILITY_STATE = { disabled: true };
const ALL_FILTER_VALUE = "__all__";
const SOURCE_ACCOUNT_VALUE = "__source_account__";
const PROVIDER_DEFAULT_ACCOUNT_VALUE = "__provider_default_account__";

type RecentProviderSessionsClient = Pick<
  DaemonClient,
  "fetchRecentProviderSessions" | "importAgent"
>;

interface WorkspaceImportSheetProps {
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  serverId: string | null;
  workspaceDirectory: string | null;
  onClose: () => void;
  onImportedAgent: (agentId: string) => void;
}

type RecentSessionsResponse = Awaited<
  ReturnType<RecentProviderSessionsClient["fetchRecentProviderSessions"]>
>;

interface SessionsQueryConfig {
  queryKey: ReadonlyArray<string | null>;
  enabled: boolean;
  queryFn: () => Promise<RecentSessionsResponse>;
}

interface SessionsQueryResult {
  data: RecentSessionsResponse | undefined;
  isError: boolean;
  isLoading: boolean;
  isPending: boolean;
}

function resolveProvidersToFetch(
  supportsSnapshot: boolean,
  snapshotEntries: ReadonlyArray<{ provider: string; enabled?: boolean }> | undefined,
): AgentProvider[] | null {
  // COMPAT(providersSnapshot): the import-recent-sessions feature ships alongside
  // providersSnapshot (v0.1.48, 2026-04-05). Daemons older than that lack both —
  // we render an "update host" empty state instead of degrading. Drop this gate
  // when the supported daemon floor is >= v0.1.48 (target: 2026-10-05).
  if (!supportsSnapshot) return null;
  if (!snapshotEntries) return null;
  return snapshotEntries
    .filter((entry) => IMPORTABLE_PROVIDER_IDS.has(entry.provider) && entry.enabled !== false)
    .map((entry) => entry.provider);
}

function buildProviderLabelMap(
  snapshotEntries: ReadonlyArray<{ provider: string; label?: string }> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!snapshotEntries) return map;
  for (const entry of snapshotEntries) {
    if (entry.label) {
      map.set(entry.provider, entry.label);
    }
  }
  return map;
}

function buildSessionsQueriesConfig(args: {
  providersToFetch: AgentProvider[] | null;
  sessionsQueryRoot: ReadonlyArray<string | null>;
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  workspaceDirectory: string | null;
}): SessionsQueryConfig[] {
  const { providersToFetch, sessionsQueryRoot, visible, client, workspaceDirectory } = args;
  if (providersToFetch === null) return [];
  const enabled = visible && Boolean(client && workspaceDirectory);
  return providersToFetch.map((provider) => ({
    queryKey: [...sessionsQueryRoot, provider],
    enabled,
    queryFn: async () => {
      if (!client || !workspaceDirectory) {
        throw new Error("Host is not connected");
      }
      return await client.fetchRecentProviderSessions({
        cwd: workspaceDirectory,
        providers: [provider],
        limit: PER_PROVIDER_LIMIT,
      });
    },
  }));
}

function aggregateSessionEntries(
  queries: ReadonlyArray<SessionsQueryResult>,
): FetchRecentProviderSessionEntry[] {
  const seen = new Set<string>();
  const collected: FetchRecentProviderSessionEntry[] = [];
  for (const query of queries) {
    if (!query.data) continue;
    for (const entry of query.data.entries) {
      const key = getProviderSessionEntryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
    }
  }
  collected.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
  return collected;
}

function sumFilteredAlreadyImportedCount(queries: ReadonlyArray<SessionsQueryResult>): number {
  let total = 0;
  for (const query of queries) {
    total += query.data?.filteredAlreadyImportedCount ?? 0;
  }
  return total;
}

function collectErroredProviderLabels(
  providersToFetch: AgentProvider[] | null,
  queries: ReadonlyArray<SessionsQueryResult>,
  providerLabelById: ReadonlyMap<string, string>,
): string[] {
  if (providersToFetch === null) return [];
  const labels: string[] = [];
  for (let index = 0; index < queries.length; index++) {
    if (queries[index]?.isError) {
      const provider = providersToFetch[index];
      labels.push(providerLabelById.get(provider) ?? provider);
    }
  }
  return labels;
}

function getSessionTitle(entry: FetchRecentProviderSessionEntry): string {
  const title = entry.title?.trim();
  if (title) {
    return title;
  }
  const firstPromptPreview = entry.firstPromptPreview?.trim();
  if (firstPromptPreview) {
    return firstPromptPreview;
  }
  return "Untitled session";
}

function getPromptPreview(entry: FetchRecentProviderSessionEntry): string {
  return entry.lastPromptPreview?.trim() || entry.firstPromptPreview?.trim() || "No prompt preview";
}

function getProviderSessionEntryKey(entry: FetchRecentProviderSessionEntry): string {
  let sourceKey = entry.source?.kind ?? "unknown-source";
  if (entry.source?.providerHomeRef) {
    sourceKey = `${entry.source.providerHomeRef.kind}:${
      entry.source.providerHomeRef.profileKey ?? entry.source.providerHomeRef.homePath ?? ""
    }`;
  } else if (entry.source?.kind === "auth-profile") {
    sourceKey = `auth-profile:${entry.source.authProfileKey ?? ""}`;
  }
  return `${entry.providerId}:${entry.providerHandleId}:${sourceKey}`;
}

function getSourceLabel(entry: FetchRecentProviderSessionEntry): string | null {
  const label = entry.source?.label?.trim();
  return label ? `Source: ${label}` : null;
}

interface SheetStatusMessagesProps {
  isClientReady: boolean;
  isSnapshotUnsupported: boolean;
  hasNoImportableProviders: boolean;
  isLoadingSessions: boolean;
  allQueriesErrored: boolean;
  erroredProviderLabels: ReadonlyArray<string>;
  importErrored: boolean;
  showEmptyState: boolean;
  allAlreadyImported: boolean;
}

function SheetStatusMessages({
  isClientReady,
  isSnapshotUnsupported,
  hasNoImportableProviders,
  isLoadingSessions,
  allQueriesErrored,
  erroredProviderLabels,
  importErrored,
  showEmptyState,
  allAlreadyImported,
}: SheetStatusMessagesProps) {
  const { theme } = useUnistyles();
  if (!isClientReady) {
    return <Text style={styles.statusText}>Connect to a workspace to import sessions</Text>;
  }
  if (isSnapshotUnsupported) {
    return <Text style={styles.statusText}>Update the host to import sessions.</Text>;
  }
  return (
    <>
      {hasNoImportableProviders ? (
        <Text style={styles.statusText}>No importable providers are enabled.</Text>
      ) : null}
      {isLoadingSessions ? (
        <View style={styles.statusRow}>
          <LoadingSpinner color={theme.colors.foregroundMuted} />
          <Text style={styles.statusText}>Loading recent sessions...</Text>
        </View>
      ) : null}
      {allQueriesErrored ? (
        <Text style={styles.statusText}>Could not load recent sessions.</Text>
      ) : null}
      {!allQueriesErrored && erroredProviderLabels.length > 0 ? (
        <Text style={styles.statusText}>
          Could not load sessions for {erroredProviderLabels.join(", ")}.
        </Text>
      ) : null}
      {importErrored ? (
        <Text style={styles.statusText}>
          Could not import the selected session. Try another account or source session.
        </Text>
      ) : null}
      {showEmptyState ? (
        <Text style={styles.statusText}>
          {allAlreadyImported
            ? "All recent sessions are already imported."
            : "No recent sessions to import."}
        </Text>
      ) : null}
    </>
  );
}

function buildProviderFilterOptions(
  providers: ReadonlyArray<string>,
  providerLabelById: ReadonlyMap<string, string>,
): SegmentedControlOption<string>[] {
  const options: SegmentedControlOption<string>[] = [
    { value: ALL_FILTER_VALUE, label: "All", testID: "workspace-import-filter-all" },
  ];
  for (const provider of providers) {
    const ProviderIcon = getProviderIcon(provider);
    options.push({
      value: provider,
      label: providerLabelById.get(provider) ?? provider,
      testID: `workspace-import-filter-${provider}`,
      icon: ({ color, size }) => <ProviderIcon color={color} size={size} />,
    });
  }
  return options;
}

function formatAuthProfileLabel(profile: ProviderAuthProfile): string {
  return (
    profile.email ||
    profile.accountName ||
    profile.alias ||
    (profile.authMode === "api-key" ? "Codex API key" : "Codex account")
  );
}

function findDefaultAuthProfile(
  provider: string,
  authProfilesByProvider: ReadonlyMap<string, ProviderAuthProfile[]>,
): ProviderAuthProfile | null {
  return authProfilesByProvider.get(provider)?.find((profile) => profile.isDefault) ?? null;
}

function groupAuthProfilesByProvider(
  profiles: ReadonlyArray<ProviderAuthProfile> | undefined,
): Map<string, ProviderAuthProfile[]> {
  const grouped = new Map<string, ProviderAuthProfile[]>();
  for (const profile of profiles ?? []) {
    const providerProfiles = grouped.get(profile.provider) ?? [];
    providerProfiles.push(profile);
    grouped.set(profile.provider, providerProfiles);
  }
  return grouped;
}

function getAccountSelectorProvider(input: {
  selectedProvider: string;
  visibleEntries: ReadonlyArray<FetchRecentProviderSessionEntry>;
}): string | null {
  if (input.selectedProvider !== ALL_FILTER_VALUE) {
    return input.selectedProvider;
  }
  const providers = new Set(input.visibleEntries.map((entry) => entry.providerId));
  return providers.size === 1 ? [...providers][0] : null;
}

function buildAccountOptions(
  provider: string,
  authProfilesByProvider: ReadonlyMap<string, ProviderAuthProfile[]>,
): SegmentedControlOption<string>[] {
  const defaultProfile = findDefaultAuthProfile(provider, authProfilesByProvider);
  const options: SegmentedControlOption<string>[] = [
    {
      value: SOURCE_ACCOUNT_VALUE,
      label: "Source account",
      testID: `workspace-import-account-${provider}-source`,
    },
  ];
  if (defaultProfile) {
    options.push({
      value: PROVIDER_DEFAULT_ACCOUNT_VALUE,
      label: "Provider default",
      testID: `workspace-import-account-${provider}-provider-default`,
    });
  }
  for (const profile of authProfilesByProvider.get(provider) ?? []) {
    options.push({
      value: profile.key,
      label: formatAuthProfileLabel(profile),
      disabled: profile.status !== "ready",
      testID: `workspace-import-account-${provider}-${profile.key}`,
    });
  }
  return options;
}

function resolveExplicitAccountImportHint(input: {
  selectedAccountValue: string;
  accountSelectorProvider: string | null;
}): string | null {
  if (input.selectedAccountValue === SOURCE_ACCOUNT_VALUE) {
    return null;
  }
  const isProviderDefault = input.selectedAccountValue === PROVIDER_DEFAULT_ACCOUNT_VALUE;
  if (input.accountSelectorProvider === "codex") {
    return isProviderDefault
      ? "This Codex session will be copied into the provider default account before opening."
      : "This Codex session will be copied into the selected account before opening.";
  }
  return isProviderDefault
    ? "This session will continue with the provider default account."
    : "This session will continue with the selected account.";
}

function ExplicitAccountImportHint({ hint }: { hint: string | null }) {
  if (!hint) {
    return null;
  }
  return <Text style={styles.accountHint}>{hint}</Text>;
}

function SelectedAccountUsageStatus({ profile }: { profile: ProviderAuthProfile | null }) {
  if (!profile) {
    return null;
  }
  const usageSummary = formatProviderAuthUsageSummary(profile.usage);
  if (!usageSummary) {
    return null;
  }
  const label = formatAuthProfileLabel(profile);
  const usageWarning = formatProviderAuthUsageWarning(profile.usage);
  return (
    <>
      <Text style={styles.accountUsage}>{`Selected: ${label} · ${usageSummary}`}</Text>
      {usageWarning ? <Text style={styles.accountWarning}>{usageWarning}</Text> : null}
    </>
  );
}

function findSelectedAccountProfile(input: {
  provider: string | null;
  selectedAccountValue: string;
  authProfilesByProvider: ReadonlyMap<string, ProviderAuthProfile[]>;
}): ProviderAuthProfile | null {
  if (!input.provider || input.selectedAccountValue === SOURCE_ACCOUNT_VALUE) {
    return null;
  }
  if (input.selectedAccountValue === PROVIDER_DEFAULT_ACCOUNT_VALUE) {
    return findDefaultAuthProfile(input.provider, input.authProfilesByProvider);
  }
  return (
    input.authProfilesByProvider
      .get(input.provider)
      ?.find((profile) => profile.key === input.selectedAccountValue) ?? null
  );
}

function resolveImportProviderHomeRef(input: {
  entry: FetchRecentProviderSessionEntry;
  selectedAccountByProvider: Readonly<Record<string, string>>;
  authProfilesByProvider: ReadonlyMap<string, ProviderAuthProfile[]>;
}): ProviderHomeRef | undefined {
  const selected = input.selectedAccountByProvider[input.entry.providerId];
  if (selected && selected !== SOURCE_ACCOUNT_VALUE) {
    if (selected === PROVIDER_DEFAULT_ACCOUNT_VALUE) {
      const defaultProfile = findDefaultAuthProfile(
        input.entry.providerId,
        input.authProfilesByProvider,
      );
      return defaultProfile
        ? (defaultProfile.providerHomeRef ?? {
            kind: "managed-profile",
            provider: input.entry.providerId,
            profileKey: defaultProfile.key,
          })
        : undefined;
    }
    const profile = input.authProfilesByProvider
      .get(input.entry.providerId)
      ?.find((candidate) => candidate.key === selected);
    return (
      profile?.providerHomeRef ?? {
        kind: "managed-profile",
        provider: input.entry.providerId,
        profileKey: selected,
      }
    );
  }
  if (input.entry.source?.providerHomeRef) {
    return input.entry.source.providerHomeRef;
  }
  const sourceAuthProfileKey = input.entry.source?.authProfileKey;
  return typeof sourceAuthProfileKey === "string" && sourceAuthProfileKey.length > 0
    ? {
        kind: "managed-profile",
        provider: input.entry.providerId,
        profileKey: sourceAuthProfileKey,
      }
    : undefined;
}

function resolveSelectedAccountValue(
  provider: string | null,
  selectedAccountByProvider: Readonly<Record<string, string>>,
): string {
  return provider
    ? (selectedAccountByProvider[provider] ?? SOURCE_ACCOUNT_VALUE)
    : SOURCE_ACCOUNT_VALUE;
}

function shouldShowAccountSelector(input: {
  isSupported: boolean;
  accountSelectorProvider: string | null;
  visibleEntries: ReadonlyArray<FetchRecentProviderSessionEntry>;
}): boolean {
  return (
    input.isSupported && input.accountSelectorProvider !== null && input.visibleEntries.length > 0
  );
}

function WorkspaceImportSheetRow({
  entry,
  disabled,
  importing,
  onImportSession,
}: {
  entry: FetchRecentProviderSessionEntry;
  disabled: boolean;
  importing: boolean;
  onImportSession: (entry: FetchRecentProviderSessionEntry) => void;
}) {
  const { theme } = useUnistyles();
  const title = getSessionTitle(entry);
  const promptPreview = getPromptPreview(entry);
  const sourceLabel = getSourceLabel(entry);
  const lastActivity = formatTimeAgo(new Date(entry.lastActivityAt));
  const ProviderIcon = getProviderIcon(entry.providerId);
  const accessibilityState = useMemo(
    () => (disabled ? DISABLED_ACCESSIBILITY_STATE : undefined),
    [disabled],
  );
  const handlePress = useCallback(() => {
    onImportSession(entry);
  }, [entry, onImportSession]);
  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  return (
    <Pressable
      disabled={disabled}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      style={pressableStyle}
      testID={`workspace-import-session-${entry.providerId}-${entry.providerHandleId}`}
    >
      <View style={styles.rowIconWrap}>
        <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.rowMeta}>{importing ? "Importing..." : lastActivity}</Text>
        </View>
        <Text style={styles.rowPreview} numberOfLines={2}>
          {promptPreview}
        </Text>
        {sourceLabel ? (
          <Text style={styles.rowSource} numberOfLines={1}>
            {sourceLabel}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function WorkspaceImportSheet({
  visible,
  client,
  serverId,
  workspaceDirectory,
  onClose,
  onImportedAgent,
}: WorkspaceImportSheetProps) {
  const queryClient = useQueryClient();

  const { entries: snapshotEntries, supportsSnapshot } = useProvidersSnapshot(serverId, {
    enabled: visible,
  });
  const providerAuthProfiles = useProviderAuthProfiles(serverId, null);

  const providersToFetch = useMemo(
    () => resolveProvidersToFetch(supportsSnapshot, snapshotEntries),
    [supportsSnapshot, snapshotEntries],
  );

  const providerLabelById = useMemo(
    () => buildProviderLabelMap(snapshotEntries),
    [snapshotEntries],
  );

  const sessionsQueryRoot = useMemo(
    () => ["recent-provider-sessions", workspaceDirectory] as const,
    [workspaceDirectory],
  );

  const queriesConfig = useMemo(
    () =>
      buildSessionsQueriesConfig({
        providersToFetch,
        sessionsQueryRoot,
        visible,
        client,
        workspaceDirectory,
      }),
    [providersToFetch, sessionsQueryRoot, visible, client, workspaceDirectory],
  );

  const queries = useQueries({ queries: queriesConfig });

  const aggregatedEntries = useMemo(() => aggregateSessionEntries(queries), [queries]);
  const totalAlreadyImportedCount = useMemo(
    () => sumFilteredAlreadyImportedCount(queries),
    [queries],
  );

  const filterProviders = useMemo(() => [...(providersToFetch ?? [])].sort(), [providersToFetch]);

  const [selectedProvider, setSelectedProvider] = useState<string>(ALL_FILTER_VALUE);

  useEffect(() => {
    if (
      !visible ||
      (selectedProvider !== ALL_FILTER_VALUE && !filterProviders.includes(selectedProvider))
    ) {
      setSelectedProvider(ALL_FILTER_VALUE);
    }
  }, [visible, filterProviders, selectedProvider]);

  const visibleEntries = useMemo(() => {
    if (selectedProvider === ALL_FILTER_VALUE) return aggregatedEntries;
    return aggregatedEntries.filter((entry) => entry.providerId === selectedProvider);
  }, [aggregatedEntries, selectedProvider]);

  const filterOptions = useMemo(
    () => buildProviderFilterOptions(filterProviders, providerLabelById),
    [filterProviders, providerLabelById],
  );
  const authProfilesByProvider = useMemo(
    () => groupAuthProfilesByProvider(providerAuthProfiles.profiles),
    [providerAuthProfiles.profiles],
  );
  const [selectedAccountByProvider, setSelectedAccountByProvider] = useState<
    Record<string, string>
  >({});
  const accountSelectorProvider = useMemo(
    () => getAccountSelectorProvider({ selectedProvider, visibleEntries }),
    [selectedProvider, visibleEntries],
  );
  const accountOptions = useMemo(
    () =>
      accountSelectorProvider
        ? buildAccountOptions(accountSelectorProvider, authProfilesByProvider)
        : [],
    [accountSelectorProvider, authProfilesByProvider],
  );
  const selectedAccountValue = resolveSelectedAccountValue(
    accountSelectorProvider,
    selectedAccountByProvider,
  );
  const explicitAccountImportHint = resolveExplicitAccountImportHint({
    selectedAccountValue,
    accountSelectorProvider,
  });
  const selectedAccountProfile = useMemo(
    () =>
      findSelectedAccountProfile({
        provider: accountSelectorProvider,
        selectedAccountValue,
        authProfilesByProvider,
      }),
    [accountSelectorProvider, authProfilesByProvider, selectedAccountValue],
  );
  const showAccountSelector = shouldShowAccountSelector({
    isSupported: providerAuthProfiles.isSupported,
    accountSelectorProvider,
    visibleEntries,
  });

  const importMutation = useMutation({
    mutationFn: async (entry: FetchRecentProviderSessionEntry) => {
      if (!client || !workspaceDirectory) {
        throw new Error("Host is not connected");
      }
      const providerHomeRef = resolveImportProviderHomeRef({
        entry,
        selectedAccountByProvider,
        authProfilesByProvider,
      });
      const agent = await client.importAgent({
        providerId: entry.providerId,
        providerHandleId: entry.providerHandleId,
        cwd: workspaceDirectory,
        ...(providerHomeRef ? { providerHomeRef } : {}),
        sessionBehavior: "continue",
      });
      return agent;
    },
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: sessionsQueryRoot });
      onClose();
      onImportedAgent(agent.id);
    },
  });

  const importingSessionKey =
    importMutation.isPending && importMutation.variables
      ? getProviderSessionEntryKey(importMutation.variables)
      : null;

  const handleImportSession = useCallback(
    (entry: FetchRecentProviderSessionEntry) => {
      importMutation.mutate(entry);
    },
    [importMutation],
  );
  const handleAccountSelect = useCallback(
    (value: string) => {
      if (!accountSelectorProvider) {
        return;
      }
      setSelectedAccountByProvider((current) => ({
        ...current,
        [accountSelectorProvider]: value,
      }));
    },
    [accountSelectorProvider],
  );

  const erroredProviderLabels = useMemo(
    () => collectErroredProviderLabels(providersToFetch, queries, providerLabelById),
    [queries, providersToFetch, providerLabelById],
  );

  const isSnapshotUnsupported = !supportsSnapshot;
  const isWaitingForSnapshot = supportsSnapshot && snapshotEntries === undefined;
  const hasNoImportableProviders = providersToFetch !== null && providersToFetch.length === 0;
  const isQueryingProviders = queries.length > 0;
  const isLoadingSessions =
    isWaitingForSnapshot ||
    (isQueryingProviders && queries.some((query) => query.isLoading || query.isPending));
  const allQueriesErrored = isQueryingProviders && queries.every((query) => query.isError);
  const allQueriesSettled =
    isQueryingProviders && queries.every((query) => !query.isLoading && !query.isPending);
  const showEmptyState =
    !isLoadingSessions &&
    !allQueriesErrored &&
    isQueryingProviders &&
    allQueriesSettled &&
    aggregatedEntries.length === 0;
  const allAlreadyImported = showEmptyState && totalAlreadyImportedCount > 0;
  const showFilter = filterProviders.length > 1;

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      title="Import session"
      testID="workspace-import-sheet"
      desktopMaxWidth={560}
      snapPoints={IMPORT_SHEET_SNAP_POINTS}
    >
      {showFilter ? (
        <ScrollView
          horizontal
          style={styles.horizontalScroller}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <SegmentedControl
            testID="workspace-import-filters"
            size="sm"
            constrainWidth={false}
            options={filterOptions}
            value={selectedProvider}
            onValueChange={setSelectedProvider}
          />
        </ScrollView>
      ) : null}
      {showAccountSelector ? (
        <View style={styles.accountSection}>
          <Text style={styles.accountLabel}>Continue with account</Text>
          <Text style={styles.accountHint}>
            Source account keeps the native provider session in the account that created it.
          </Text>
          <ExplicitAccountImportHint hint={explicitAccountImportHint} />
          <ScrollView
            horizontal
            style={styles.horizontalScroller}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.accountOptionsRow}
          >
            <SegmentedControl
              testID="workspace-import-account-selector"
              size="sm"
              constrainWidth={false}
              options={accountOptions}
              value={selectedAccountValue}
              onValueChange={handleAccountSelect}
            />
          </ScrollView>
          <SelectedAccountUsageStatus profile={selectedAccountProfile} />
        </View>
      ) : null}
      <SheetStatusMessages
        isClientReady={Boolean(client && workspaceDirectory)}
        isSnapshotUnsupported={isSnapshotUnsupported}
        hasNoImportableProviders={hasNoImportableProviders}
        isLoadingSessions={isLoadingSessions}
        allQueriesErrored={allQueriesErrored}
        erroredProviderLabels={erroredProviderLabels}
        importErrored={importMutation.isError}
        showEmptyState={showEmptyState}
        allAlreadyImported={allAlreadyImported}
      />
      {visibleEntries.length > 0 ? (
        <View style={styles.list}>
          {visibleEntries.map((entry) => (
            <WorkspaceImportSheetRow
              key={getProviderSessionEntryKey(entry)}
              entry={entry}
              disabled={importMutation.isPending}
              importing={importingSessionKey === getProviderSessionEntryKey(entry)}
              onImportSession={handleImportSession}
            />
          ))}
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  horizontalScroller: {
    width: "100%",
    maxWidth: "100%",
    flexGrow: 0,
    flexShrink: 1,
    ...(isWeb
      ? {
          overflowX: "auto",
          overflowY: "hidden",
          touchAction: "pan-x pan-y",
        }
      : null),
  },
  filterRow: {
    flexDirection: "row",
    paddingBottom: theme.spacing[2],
  },
  accountSection: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  accountLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  accountHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  accountUsage: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.35,
  },
  accountWarning: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.35,
  },
  accountOptionsRow: {
    flexDirection: "row",
  },
  list: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowIconWrap: {
    width: theme.iconSize.md,
    paddingTop: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowPreview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  rowSource: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
