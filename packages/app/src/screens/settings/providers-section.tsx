import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProviderAuthProfiles } from "@/hooks/use-provider-auth-profiles";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import { AddProviderModal } from "@/components/add-provider-modal";
import { getProviderIcon } from "@/components/provider-icons";
import { ProviderDiagnosticSheet } from "@/components/provider-diagnostic-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/screens/settings/settings-section";
import type { ProviderAuthProfile } from "@server/server/agent/agent-sdk-types";
import { ChevronRight, Plus, RotateCw } from "lucide-react-native";

type ProviderDefinition = ReturnType<typeof buildProviderDefinitions>[number];
type ProviderEntry = NonNullable<ReturnType<typeof useProvidersSnapshot>["entries"]>[number];

type StatusTone = "success" | "warning" | "danger" | "muted" | "loading";

interface ProviderStatus {
  tone: StatusTone;
  label: string;
  modelCount: number | null;
}

function getProviderStatus(status: string, enabled: boolean, modelCount: number): ProviderStatus {
  if (!enabled) return { tone: "muted", label: "Disabled", modelCount: null };
  if (status === "loading") return { tone: "loading", label: "Loading", modelCount: null };
  if (status === "error") return { tone: "danger", label: "Error", modelCount: null };
  if (status === "ready") {
    return {
      tone: "success",
      label: "Available",
      modelCount: modelCount > 0 ? modelCount : null,
    };
  }
  return { tone: "warning", label: "Not installed", modelCount: null };
}

interface ProviderRowProps {
  def: ProviderDefinition;
  entry: ProviderEntry;
  accountSummary: ProviderAccountSummary | null;
  enabled: boolean;
  isToggling: boolean;
  isFirst: boolean;
  onPress: (providerId: string) => void;
  onToggleEnabled: (providerId: string, enabled: boolean) => void;
}

function ProviderRow({
  def,
  entry,
  accountSummary,
  enabled,
  isToggling,
  isFirst,
  onPress,
  onToggleEnabled,
}: ProviderRowProps) {
  const { theme } = useUnistyles();
  const ProviderIcon = getProviderIcon(def.id);
  const providerError =
    enabled &&
    entry.status === "error" &&
    typeof entry.error === "string" &&
    entry.error.trim().length > 0
      ? entry.error.trim()
      : null;
  const modelCount = entry.models?.length ?? 0;
  const providerStatus = getProviderStatus(entry.status, enabled, modelCount);

  const handlePress = useCallback(() => {
    onPress(def.id);
  }, [def.id, onPress]);
  const handleToggleValueChange = useCallback(
    (value: boolean) => {
      onToggleEnabled(def.id, value);
    },
    [def.id, onToggleEnabled],
  );
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      !isFirst && settingsStyles.rowBorder,
      styles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${def.label} provider details`}
    >
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <>
          <View style={styles.rowContent}>
            <ChevronRight
              size={theme.iconSize.sm}
              color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
            <ProviderIcon size={theme.iconSize.md} color={theme.colors.foreground} />
            <View style={styles.textColumn}>
              <View style={styles.titleRow}>
                <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                  {def.label}
                </Text>
                <Text style={styles.separator}>·</Text>
                <StatusIndicator status={providerStatus} />
              </View>
              {providerError ? (
                <Text style={styles.errorText} numberOfLines={3}>
                  {providerError}
                </Text>
              ) : null}
              {accountSummary ? (
                <View style={styles.accountSummaryRow}>
                  <Text style={styles.accountSummaryText} numberOfLines={1}>
                    {accountSummary.label}
                  </Text>
                  {accountSummary.warning ? (
                    <>
                      <Text style={styles.separator}>·</Text>
                      <Text style={styles.accountSummaryWarningText} numberOfLines={1}>
                        {accountSummary.warning}
                      </Text>
                    </>
                  ) : null}
                </View>
              ) : null}
            </View>
          </View>
          <Switch
            value={enabled}
            onValueChange={handleToggleValueChange}
            disabled={isToggling}
            accessibilityLabel={`Enable ${def.label}`}
          />
        </>
      )}
    </Pressable>
  );
}

function getDotColor(tone: StatusTone, theme: ReturnType<typeof useUnistyles>["theme"]): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

function StatusIndicator({ status }: { status: ProviderStatus }) {
  const { theme } = useUnistyles();
  const dotStyle = useMemo(
    () => [styles.statusDot, { backgroundColor: getDotColor(status.tone, theme) }],
    [status.tone, theme],
  );

  return (
    <View style={styles.statusRow}>
      {status.tone === "loading" ? (
        <LoadingSpinner size={10} color={theme.colors.foregroundMuted} />
      ) : (
        <View style={dotStyle} />
      )}
      <Text style={styles.statusLabel}>{status.label}</Text>
      {status.modelCount !== null ? (
        <>
          <Text style={styles.separator}>·</Text>
          <Text style={styles.statusLabel}>
            {status.modelCount === 1 ? "1 model" : `${status.modelCount} models`}
          </Text>
        </>
      ) : null}
    </View>
  );
}

export interface ProvidersSectionProps {
  serverId: string;
}

export function ProvidersSection({ serverId }: ProvidersSectionProps) {
  const { theme } = useUnistyles();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { entries, isLoading, isRefreshing, refresh } = useProvidersSnapshot(serverId);
  const { profiles: providerAuthProfiles } = useProviderAuthProfiles(serverId, null);
  const { patchConfig } = useDaemonConfig(serverId);
  const [diagnosticProvider, setDiagnosticProvider] = useState<string | null>(null);
  const [isAddProviderOpen, setIsAddProviderOpen] = useState(false);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  const providerDefinitions = useMemo(() => buildProviderDefinitions(entries), [entries]);
  const accountSummaries = useMemo(
    () => buildProviderAccountSummaries(providerAuthProfiles),
    [providerAuthProfiles],
  );
  const providerRefreshInFlight =
    isRefreshing || (entries?.some((entry) => entry.status === "loading") ?? false);
  const hasServer = serverId.length > 0;

  const handleRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  const handleCloseDiagnostic = useCallback(() => setDiagnosticProvider(null), []);
  const handleOpenAddProvider = useCallback(() => setIsAddProviderOpen(true), []);
  const handleCloseAddProvider = useCallback(() => setIsAddProviderOpen(false), []);
  const handleToggleEnabled = useCallback(
    async (providerId: string, enabled: boolean) => {
      setPendingProviderId(providerId);
      try {
        await patchConfig({ providers: { [providerId]: { enabled } } });
      } catch (error) {
        Alert.alert(
          "Unable to update provider",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setPendingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig],
  );

  const headerActions = useMemo(
    () =>
      hasServer && isConnected ? (
        <View style={styles.headerActions}>
          <Pressable
            onPress={handleOpenAddProvider}
            hitSlop={8}
            style={settingsStyles.sectionHeaderLink}
            accessibilityRole="button"
            accessibilityLabel="Add provider"
            testID="add-provider-button"
          >
            <Plus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            <Text style={settingsStyles.sectionHeaderLinkText}>Add provider</Text>
          </Pressable>
          <Pressable
            onPress={handleRefresh}
            disabled={providerRefreshInFlight}
            hitSlop={8}
            style={settingsStyles.sectionHeaderLink}
            accessibilityRole="button"
            accessibilityLabel={
              providerRefreshInFlight ? "Refreshing providers" : "Refresh providers"
            }
          >
            {providerRefreshInFlight ? (
              <LoadingSpinner size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            ) : (
              <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
        </View>
      ) : undefined,
    [
      hasServer,
      isConnected,
      handleOpenAddProvider,
      handleRefresh,
      providerRefreshInFlight,
      theme.iconSize.sm,
      theme.colors.foregroundMuted,
    ],
  );

  return (
    <>
      <SettingsSection
        title="Providers"
        trailing={headerActions}
        testID="host-page-providers-card"
        style={styles.sectionSpacing}
      >
        {!hasServer || !isConnected ? (
          <View style={EMPTY_CARD_STYLE}>
            <Text style={styles.emptyText}>Connect to this host to see providers</Text>
          </View>
        ) : null}
        {hasServer && isConnected && isLoading ? (
          <View style={EMPTY_CARD_STYLE}>
            <Text style={styles.emptyText}>Loading...</Text>
          </View>
        ) : null}
        {hasServer && isConnected && !isLoading && providerDefinitions.length > 0 ? (
          <View style={settingsStyles.card}>
            {providerDefinitions.map((def, index) => {
              const entry = entries?.find((candidate) => candidate.provider === def.id);
              if (!entry) return null;
              return (
                <ProviderRow
                  key={def.id}
                  def={def}
                  entry={entry}
                  accountSummary={accountSummaries.get(def.id) ?? null}
                  enabled={entry.enabled ?? true}
                  isToggling={pendingProviderId === def.id}
                  isFirst={index === 0}
                  onPress={setDiagnosticProvider}
                  onToggleEnabled={handleToggleEnabled}
                />
              );
            })}
          </View>
        ) : null}
      </SettingsSection>

      {diagnosticProvider ? (
        <ProviderDiagnosticSheet
          provider={diagnosticProvider}
          visible
          onClose={handleCloseDiagnostic}
          serverId={serverId}
        />
      ) : null}
      {hasServer && isConnected && isAddProviderOpen ? (
        <AddProviderModal serverId={serverId} visible onClose={handleCloseAddProvider} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionSpacing: {
    marginBottom: theme.spacing[4],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  row: {
    gap: theme.spacing[3],
    minHeight: 56,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  rowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  separator: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  accountSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    marginTop: theme.spacing[1],
  },
  accountSummaryText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  accountSummaryWarningText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
}));

const EMPTY_CARD_STYLE = [settingsStyles.card, styles.emptyCard];

interface ProviderAccountSummary {
  label: string;
  warning: string | null;
}

function buildProviderAccountSummaries(
  profiles: readonly ProviderAuthProfile[] | undefined,
): Map<string, ProviderAccountSummary> {
  const summaries = new Map<string, ProviderAccountSummary>();
  if (!profiles || profiles.length === 0) {
    return summaries;
  }
  const profilesByProvider = new Map<string, ProviderAuthProfile[]>();
  for (const profile of profiles) {
    const providerProfiles = profilesByProvider.get(profile.provider) ?? [];
    providerProfiles.push(profile);
    profilesByProvider.set(profile.provider, providerProfiles);
  }
  for (const [provider, providerProfiles] of profilesByProvider) {
    const defaultProfile = providerProfiles.find((profile) => profile.isDefault);
    const defaultLabel = defaultProfile ? formatProviderAccountLabel(defaultProfile) : null;
    const accountCount = providerProfiles.length;
    const limitedCount = providerProfiles.filter(
      (profile) => resolveUsageLimitState(profile) === "limited",
    ).length;
    const nearLimitCount = providerProfiles.filter(
      (profile) => resolveUsageLimitState(profile) === "near-limit",
    ).length;
    let warning: string | null = null;
    if (limitedCount > 0) {
      warning = `${limitedCount} limited`;
    } else if (nearLimitCount > 0) {
      warning = `${nearLimitCount} near limit`;
    }
    summaries.set(provider, {
      label: [
        defaultLabel ? `Default: ${defaultLabel}` : null,
        `${accountCount} ${accountCount === 1 ? "account" : "accounts"}`,
      ]
        .filter(Boolean)
        .join(" · "),
      warning,
    });
  }
  return summaries;
}

function formatProviderAccountLabel(profile: ProviderAuthProfile): string {
  return profile.alias || profile.email || profile.accountName || "Account";
}

function resolveUsageLimitState(
  profile: ProviderAuthProfile,
): "limited" | "near-limit" | "ok" | null {
  if (!profile.usage) {
    return null;
  }
  if (profile.usage.limitState === "limited" || profile.usage.limitState === "near-limit") {
    return profile.usage.limitState;
  }
  const usedPercent = Math.max(
    typeof profile.usage.primaryUsedPercent === "number" ? profile.usage.primaryUsedPercent : -1,
    typeof profile.usage.secondaryUsedPercent === "number"
      ? profile.usage.secondaryUsedPercent
      : -1,
  );
  if (usedPercent < 0) {
    return null;
  }
  if (usedPercent >= 100) {
    return "limited";
  }
  if (usedPercent >= 85) {
    return "near-limit";
  }
  return "ok";
}
