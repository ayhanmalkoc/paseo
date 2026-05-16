import { AlertCircle, Check, Pencil, RotateCw, Search, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  type PressableStateCallbackType,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { isWeb } from "@/constants/platform";
import { Fonts } from "@/constants/theme";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useAccountLogin } from "@/hooks/use-account-login";
import { useProviderAuthProfiles } from "@/hooks/use-provider-auth-profiles";
import {
  useProviderNativeConfig,
  useProviderNativeMcpServers,
  useProviderNativeConfigSupport,
  useSyncProviderNativeConfigFromSource,
} from "@/hooks/use-provider-native-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import {
  formatProviderAuthUsageSummary,
  formatProviderAuthUsageWarning,
} from "@/utils/provider-auth-usage";
import { formatTimeAgo } from "@/utils/time";
import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderAuthProfile,
} from "@server/server/agent/agent-sdk-types";
import type { ProviderProfileModel } from "@server/server/agent/provider-launch-config";
import type { McpServerConfig, ProviderNativeMcpServer } from "@server/shared/messages";

interface ProviderDiagnosticSheetProps {
  provider: string;
  visible: boolean;
  onClose: () => void;
  serverId: string;
}

function ModelRow({ model }: { model: AgentModelDefinition }) {
  return (
    <View style={MODEL_ROW_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {model.label}
        </Text>
        <Text style={sheetStyles.monoHint} numberOfLines={1} selectable>
          {model.id}
        </Text>
      </View>
    </View>
  );
}

function CustomModelRow(props: {
  model: ProviderProfileModel;
  deleting: boolean;
  onDelete: (modelId: string) => void;
}) {
  const { theme } = useUnistyles();
  const { model, deleting, onDelete } = props;
  const handleDelete = useCallback(() => onDelete(model.id), [model.id, onDelete]);
  const deleteButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      deleting ? sheetStyles.disabled : null,
    ],
    [deleting],
  );

  return (
    <View style={MODEL_ROW_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {model.label}
        </Text>
        <Text style={sheetStyles.monoHint} numberOfLines={1} selectable>
          {model.id}
        </Text>
      </View>
      <Pressable
        onPress={handleDelete}
        disabled={deleting}
        hitSlop={8}
        style={deleteButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${model.id}`}
      >
        <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />
      </Pressable>
    </View>
  );
}

function CustomModelsSection(props: {
  provider: string;
  serverId: string;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
}) {
  const { provider, serverId, refresh } = props;
  const { theme } = useUnistyles();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const providerConfig = config?.providers?.[provider];
  const additionalModels = useMemo(
    () => providerConfig?.additionalModels ?? [],
    [providerConfig?.additionalModels],
  );
  const trimmedInput = input.trim();
  const canAdd =
    trimmedInput.length > 0 && !additionalModels.some((model) => model.id === trimmedInput);

  const patchAdditionalModels = useCallback(
    async (nextModels: ProviderProfileModel[]) => {
      await patchConfig({
        providers: {
          [provider]: {
            additionalModels: nextModels,
          },
        },
      });
      await refresh([provider]);
    },
    [patchConfig, provider, refresh],
  );

  const handleAdd = useCallback(() => {
    if (!canAdd) {
      return;
    }

    setError(null);
    setSaving(true);
    void patchAdditionalModels([
      ...additionalModels,
      {
        id: trimmedInput,
        label: trimmedInput,
      },
    ])
      .then(() => setInput(""))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to save model");
      })
      .finally(() => setSaving(false));
  }, [additionalModels, canAdd, patchAdditionalModels, trimmedInput]);

  const handleDelete = useCallback(
    (modelId: string) => {
      setError(null);
      setDeletingModelId(modelId);
      void patchAdditionalModels(additionalModels.filter((model) => model.id !== modelId))
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Failed to delete model");
        })
        .finally(() => {
          setDeletingModelId((current) => (current === modelId ? null : current));
        });
    },
    [additionalModels, patchAdditionalModels],
  );

  return (
    <SettingsSection title="Custom models">
      <View style={settingsStyles.card}>
        <View style={INLINE_ROW_STYLE}>
          <AdaptiveTextInput
            value={input}
            onChangeText={setInput}
            onSubmitEditing={handleAdd}
            placeholder="Model ID"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            // @ts-expect-error - outlineStyle is web-only
            style={DIAGNOSTIC_INLINE_INPUT_STYLE}
          />
          <Button
            variant="default"
            size="sm"
            onPress={handleAdd}
            disabled={!canAdd || saving}
            accessibilityLabel="Add model"
          >
            {saving ? "Adding…" : "Add"}
          </Button>
        </View>
        {additionalModels.map((model) => (
          <CustomModelRow
            key={model.id}
            model={model}
            deleting={deletingModelId === model.id}
            onDelete={handleDelete}
          />
        ))}
      </View>
      {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
    </SettingsSection>
  );
}

function formatAuthProfileSubtitle(profile: ProviderAuthProfile): string {
  const parts = [
    profile.email,
    profile.plan,
    profile.authMode === "api-key" ? "API key" : profile.authMode,
    profile.status !== "ready" ? profile.status : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function formatAuthProfileTimeline(profile: ProviderAuthProfile): string {
  const parts = [
    formatTimestampLabel("Last used", profile.lastUsedAt),
    formatTimestampLabel("Usage updated", profile.usage?.refreshedAt),
  ].filter(Boolean);
  return parts.join(" · ");
}

function formatTimestampLabel(label: string, value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return `${label} ${formatTimeAgo(date)}`;
}

function shouldAutoRefreshUsage(profile: ProviderAuthProfile): boolean {
  if (profile.status !== "ready") {
    return false;
  }
  if (!profile.usage) {
    return true;
  }
  const refreshedAt = Date.parse(profile.usage.refreshedAt);
  if (!Number.isFinite(refreshedAt)) {
    return true;
  }
  return Date.now() - refreshedAt > AUTO_USAGE_REFRESH_MAX_AGE_MS;
}

function sortAuthProfiles(profiles: readonly ProviderAuthProfile[]): ProviderAuthProfile[] {
  return [...profiles].sort(compareAuthProfiles);
}

function compareAuthProfiles(left: ProviderAuthProfile, right: ProviderAuthProfile): number {
  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }

  const statusRankDelta = getAuthProfileStatusRank(left) - getAuthProfileStatusRank(right);
  if (statusRankDelta !== 0) {
    return statusRankDelta;
  }

  const usagePressureDelta = getUsagePressure(right) - getUsagePressure(left);
  if (usagePressureDelta !== 0) {
    return usagePressureDelta;
  }

  const recencyDelta = getAuthProfileRecency(right) - getAuthProfileRecency(left);
  if (recencyDelta !== 0) {
    return recencyDelta;
  }

  return formatAuthProfileSortLabel(left).localeCompare(formatAuthProfileSortLabel(right));
}

function getAuthProfileStatusRank(profile: ProviderAuthProfile): number {
  switch (profile.status) {
    case "ready":
      return 0;
    case "refreshing":
      return 1;
    case "needs-login":
      return 2;
    case "invalid":
      return 3;
    default:
      return 4;
  }
}

function getUsagePressure(profile: ProviderAuthProfile): number {
  const primary = profile.usage?.primaryUsedPercent;
  const secondary = profile.usage?.secondaryUsedPercent;
  return Math.max(
    typeof primary === "number" ? primary : -1,
    typeof secondary === "number" ? secondary : -1,
  );
}

function getAuthProfileRecency(profile: ProviderAuthProfile): number {
  return Math.max(
    Date.parse(profile.lastUsedAt ?? ""),
    Date.parse(profile.updatedAt),
    Date.parse(profile.createdAt),
    0,
  );
}

function formatAuthProfileSortLabel(profile: ProviderAuthProfile): string {
  return (profile.alias || profile.email || profile.accountName || profile.key).toLocaleLowerCase();
}

function AuthProfileRow(props: {
  profile: ProviderAuthProfile;
  busy: boolean;
  onRefresh: (profileKey: string) => void;
  onSetDefault: (profileKey: string) => void;
  onRemove: (profileKey: string) => void;
}) {
  const { theme } = useUnistyles();
  const { profile, busy, onRefresh, onSetDefault, onRemove } = props;
  const handleRefresh = useCallback(() => onRefresh(profile.key), [onRefresh, profile.key]);
  const handleSetDefault = useCallback(
    () => onSetDefault(profile.key),
    [onSetDefault, profile.key],
  );
  const handleRemove = useCallback(() => onRemove(profile.key), [onRemove, profile.key]);
  const title = profile.alias || profile.email || "Account";
  const subtitle = formatAuthProfileSubtitle(profile);
  const timeline = formatAuthProfileTimeline(profile);
  const usageSummary = formatProviderAuthUsageSummary(profile.usage);
  const usageWarning = formatProviderAuthUsageWarning(profile.usage);
  const usageRefreshError = formatUsageRefreshError(profile.usageRefreshError);

  return (
    <View style={profile.isDefault ? AUTH_PROFILE_DEFAULT_ROW_STYLE : AUTH_PROFILE_ROW_STYLE}>
      <View style={AUTH_PROFILE_CONTENT_STYLE}>
        <View style={sheetStyles.profileTitleRow}>
          <Text style={AUTH_PROFILE_TITLE_STYLE}>{title}</Text>
          {profile.isDefault ? (
            <View
              style={sheetStyles.defaultTitleBadge}
              accessibilityRole="image"
              accessibilityLabel="Default account"
            >
              <Check size={theme.iconSize.sm} color={theme.colors.accent} />
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Text style={sheetStyles.monoHint} selectable>
            {subtitle}
          </Text>
        ) : null}
        {usageSummary ? (
          <Text style={usageWarning ? sheetStyles.usageWarningText : sheetStyles.usageText}>
            {usageSummary}
          </Text>
        ) : null}
        {usageRefreshError ? (
          <Text style={sheetStyles.usageErrorText}>{usageRefreshError}</Text>
        ) : null}
        {timeline ? <Text style={sheetStyles.profileTimelineText}>{timeline}</Text> : null}
      </View>
      <View style={sheetStyles.profileActions}>
        {!profile.isDefault ? (
          <Button
            variant="ghost"
            size="xs"
            style={sheetStyles.profileActionButton}
            textStyle={sheetStyles.profileActionButtonText}
            onPress={handleSetDefault}
            disabled={busy}
            accessibilityLabel={`Use ${title} by default`}
          >
            Set default
          </Button>
        ) : (
          <Text style={sheetStyles.defaultBadge}>Default</Text>
        )}
        <Button
          variant="ghost"
          size="xs"
          style={sheetStyles.profileActionButton}
          textStyle={sheetStyles.profileActionButtonText}
          onPress={handleRefresh}
          disabled={busy}
          accessibilityLabel={`Refresh ${title}`}
        >
          Refresh
        </Button>
        <Button
          variant="ghost"
          size="xs"
          style={sheetStyles.profileActionButton}
          textStyle={sheetStyles.profileActionButtonText}
          onPress={handleRemove}
          disabled={busy}
          accessibilityLabel={`Remove ${title}`}
        >
          Remove
        </Button>
      </View>
    </View>
  );
}

function formatUsageRefreshError(error: ProviderAuthProfile["usageRefreshError"]): string | null {
  if (!error) {
    return null;
  }
  const occurredAt = Date.parse(error.occurredAt);
  const suffix = Number.isFinite(occurredAt) ? ` ${formatTimeAgo(new Date(occurredAt))}` : "";
  if (error.code === "auth-invalid") {
    return `Usage refresh failed${suffix}: sign in again.`;
  }
  return `Usage refresh failed${suffix}: ${error.message}`;
}

function parseNativeMcpConfig(value: string): McpServerConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Config JSON is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config must be a JSON object.");
  }
  const config = parsed as Partial<McpServerConfig>;
  if (config.type === "stdio") {
    if (typeof config.command !== "string" || config.command.trim().length === 0) {
      throw new Error("Stdio MCP config requires command.");
    }
    return config as McpServerConfig;
  }
  if (config.type === "http" || config.type === "sse") {
    if (typeof config.url !== "string" || config.url.trim().length === 0) {
      throw new Error(`${config.type.toUpperCase()} MCP config requires url.`);
    }
    return config as McpServerConfig;
  }
  throw new Error("Config type must be stdio, http, or sse.");
}

function formatNativeMcpConfigSummary(config: McpServerConfig): string {
  if (config.type === "stdio") {
    const args = config.args?.length ? ` · ${config.args.length} args` : "";
    const env = config.env && Object.keys(config.env).length > 0 ? " · env" : "";
    return `stdio · ${config.command}${args}${env}`;
  }
  return `${config.type} · ${config.url}`;
}

function compareProviderNativeMcpServers(
  left: ProviderNativeMcpServer,
  right: ProviderNativeMcpServer,
): number {
  return left.id.localeCompare(right.id);
}

function formatNativeMcpError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function ProviderAuthProfilesSection(props: {
  provider: string;
  providerLabel: string;
  serverId: string;
  visible: boolean;
  refreshNonce: number;
}) {
  const { provider, providerLabel, serverId, visible, refreshNonce } = props;
  const {
    profiles = [],
    isLoading,
    isRefreshing,
    isSupported,
    importCurrent,
    refreshProfile,
    setDefault,
    remove,
  } = useProviderAuthProfiles(serverId, provider as AgentProvider);
  const [error, setError] = useState<string | null>(null);
  const [loginSessionId, setLoginSessionId] = useState<string | null>(null);
  const [nativeConfigVisible, setNativeConfigVisible] = useState(false);
  const [nativeMcpVisible, setNativeMcpVisible] = useState(false);
  const autoRefreshedKeysRef = useRef<Set<string>>(new Set());
  const autoRefreshInFlightRef = useRef(false);
  const lastForcedRefreshNonceRef = useRef(0);
  const providerId = provider as AgentProvider;
  const accountLogin = useAccountLogin(serverId, providerId);
  const canEditNativeConfig = useProviderNativeConfigSupport(serverId, providerId);
  const nativeConfigSync = useSyncProviderNativeConfigFromSource(serverId, providerId);
  const loginSession = useMemo(
    () => accountLogin.sessions.find((session) => session.id === loginSessionId) ?? null,
    [accountLogin.sessions, loginSessionId],
  );
  const sortedProfiles = useMemo(() => sortAuthProfiles(profiles), [profiles]);
  const handleCloseNativeConfig = useCallback(() => setNativeConfigVisible(false), []);
  const handleCloseNativeMcp = useCallback(() => setNativeMcpVisible(false), []);
  const handleOpenNativeConfig = useCallback(() => setNativeConfigVisible(true), []);
  const handleOpenNativeMcp = useCallback(() => setNativeMcpVisible(true), []);

  const runAuthAction = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Account action failed");
    }
  }, []);

  const handleImportCurrent = useCallback(() => {
    void runAuthAction(() => importCurrent({ setDefault: true }));
  }, [importCurrent, runAuthAction]);
  const handleAddAccount = useCallback(() => {
    void runAuthAction(async () => {
      const session = await accountLogin.start({
        method: "chatgpt-device-code",
        setDefault: profiles.length === 0,
      });
      setLoginSessionId(session.id);
    });
  }, [accountLogin, profiles.length, runAuthAction]);
  const handleCloseLogin = useCallback(() => {
    if (loginSession && ["starting", "pending-user", "importing"].includes(loginSession.status)) {
      void accountLogin.cancel(loginSession.id).catch(() => undefined);
    }
    setLoginSessionId(null);
  }, [accountLogin, loginSession]);
  const handleRefresh = useCallback(
    (profileKey: string) => {
      void runAuthAction(() => refreshProfile(profileKey));
    },
    [refreshProfile, runAuthAction],
  );
  const handleSetDefault = useCallback(
    (profileKey: string) => {
      void runAuthAction(() => setDefault(profileKey));
    },
    [runAuthAction, setDefault],
  );
  const handleRemove = useCallback(
    (profileKey: string) => {
      void runAuthAction(() => remove(profileKey));
    },
    [remove, runAuthAction],
  );
  const handleSyncConfig = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: `Sync ${providerLabel} config?`,
        message: `This replaces the shared ${providerLabel} provider config with the current native ${providerLabel} config. Account auth and usage are not changed.`,
        confirmLabel: "Sync config",
      });
      if (!confirmed) {
        return;
      }
      await runAuthAction(() => nativeConfigSync.sync());
    })();
  }, [nativeConfigSync, providerLabel, runAuthAction]);

  const refreshProfiles = useCallback(
    async (
      profilesToRefresh: ReadonlyArray<ProviderAuthProfile>,
      options: { automatic: boolean },
    ) => {
      const failures: string[] = [];
      for (const profile of profilesToRefresh) {
        try {
          await refreshProfile(profile.key);
        } catch (err) {
          if (options.automatic) {
            autoRefreshedKeysRef.current.delete(profile.key);
            continue;
          }
          failures.push(err instanceof Error ? err.message : profile.alias);
        }
      }
      if (failures.length > 0) {
        throw new Error(failures[0] ?? "Account refresh failed");
      }
    },
    [refreshProfile],
  );

  useEffect(() => {
    if (!visible) {
      autoRefreshedKeysRef.current.clear();
      autoRefreshInFlightRef.current = false;
      return;
    }
    if (autoRefreshInFlightRef.current || isLoading || isRefreshing || profiles.length === 0) {
      return;
    }
    const staleProfiles = profiles.filter(
      (profile) =>
        shouldAutoRefreshUsage(profile) && !autoRefreshedKeysRef.current.has(profile.key),
    );
    if (staleProfiles.length === 0) {
      return;
    }
    autoRefreshInFlightRef.current = true;
    for (const profile of staleProfiles) {
      autoRefreshedKeysRef.current.add(profile.key);
    }
    void refreshProfiles(staleProfiles, { automatic: true }).finally(() => {
      autoRefreshInFlightRef.current = false;
    });
  }, [isLoading, isRefreshing, profiles, refreshProfiles, visible]);

  useEffect(() => {
    if (
      !visible ||
      refreshNonce === 0 ||
      refreshNonce === lastForcedRefreshNonceRef.current ||
      isLoading ||
      profiles.length === 0
    ) {
      return;
    }
    lastForcedRefreshNonceRef.current = refreshNonce;
    void runAuthAction(() => refreshProfiles(profiles, { automatic: false }));
  }, [isLoading, profiles, refreshNonce, refreshProfiles, runAuthAction, visible]);
  const importCurrentAction = useMemo(
    () => (
      <View style={sheetStyles.trailingActions}>
        {accountLogin.methods.includes("chatgpt-device-code") ? (
          <Button
            variant="ghost"
            size="xs"
            onPress={handleAddAccount}
            disabled={isRefreshing || accountLogin.isRefreshing}
            accessibilityLabel="Add provider account"
          >
            Add account
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          onPress={handleImportCurrent}
          disabled={isRefreshing}
          loading={isRefreshing && profiles.length === 0}
          accessibilityLabel="Import current provider account"
        >
          Import current account
        </Button>
      </View>
    ),
    [
      accountLogin.isRefreshing,
      accountLogin.methods,
      handleAddAccount,
      handleImportCurrent,
      isRefreshing,
      profiles.length,
    ],
  );

  const providerConfigAction = canEditNativeConfig ? (
    <SettingsSection title="Provider config">
      <View style={settingsStyles.card}>
        <View style={PROVIDER_CONFIG_ROW_STYLE}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{providerLabel} config</Text>
            <Text style={settingsStyles.rowHint}>
              Shared MCP, skills, plugins, hooks, and native provider settings.
            </Text>
          </View>
          <View style={sheetStyles.providerConfigActions}>
            {nativeConfigSync.isSupported ? (
              <Button
                variant="ghost"
                size="xs"
                style={sheetStyles.profileActionButton}
                textStyle={sheetStyles.profileActionButtonText}
                onPress={handleSyncConfig}
                disabled={isRefreshing || nativeConfigSync.isSyncing}
                loading={nativeConfigSync.isSyncing}
                accessibilityLabel={`Sync ${providerLabel} config from native provider`}
              >
                Sync config
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              style={sheetStyles.profileActionButton}
              textStyle={sheetStyles.profileActionButtonText}
              onPress={handleOpenNativeConfig}
              disabled={nativeConfigSync.isSyncing}
              accessibilityLabel={`Edit ${providerLabel} native config`}
            >
              Config
            </Button>
            <Button
              variant="ghost"
              size="xs"
              style={sheetStyles.profileActionButton}
              textStyle={sheetStyles.profileActionButtonText}
              onPress={handleOpenNativeMcp}
              disabled={nativeConfigSync.isSyncing}
              accessibilityLabel={`Manage ${providerLabel} MCP servers`}
            >
              MCP
            </Button>
          </View>
        </View>
      </View>
      {nativeConfigSync.error ? (
        <Text style={sheetStyles.errorText}>{nativeConfigSync.error}</Text>
      ) : null}
    </SettingsSection>
  ) : null;

  const accountsSection = isSupported ? (
    <SettingsSection title="Accounts" trailing={importCurrentAction}>
      <View style={settingsStyles.card}>
        {isLoading && profiles.length === 0 ? (
          <View style={sheetStyles.emptyRow}>
            <ActivityIndicator size="small" />
            <Text style={sheetStyles.mutedText}>Loading accounts…</Text>
          </View>
        ) : null}
        {!isLoading && profiles.length === 0 ? (
          <View style={sheetStyles.emptyRow}>
            <Text style={sheetStyles.mutedText}>
              No accounts yet. Add an account or import the current provider account.
            </Text>
          </View>
        ) : null}
        {sortedProfiles.map((profile) => (
          <AuthProfileRow
            key={profile.key}
            profile={profile}
            busy={isRefreshing || nativeConfigSync.isSyncing}
            onRefresh={handleRefresh}
            onSetDefault={handleSetDefault}
            onRemove={handleRemove}
          />
        ))}
      </View>
      {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
    </SettingsSection>
  ) : null;

  if (!providerConfigAction && !accountsSection) {
    return null;
  }

  return (
    <>
      {providerConfigAction}
      {accountsSection}
      {isSupported ? (
        <AccountLoginSheet
          session={loginSession}
          visible={!!loginSession}
          onClose={handleCloseLogin}
        />
      ) : null}
      {canEditNativeConfig ? (
        <>
          <ProviderNativeConfigSheet
            provider={providerId}
            providerLabel={providerLabel}
            serverId={serverId}
            visible={nativeConfigVisible}
            onClose={handleCloseNativeConfig}
          />
          <ProviderNativeMcpSheet
            provider={providerId}
            providerLabel={providerLabel}
            serverId={serverId}
            visible={nativeMcpVisible}
            onClose={handleCloseNativeMcp}
          />
        </>
      ) : null}
    </>
  );
}

function ProviderNativeConfigSheet(props: {
  provider: AgentProvider;
  providerLabel: string;
  serverId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { provider, providerLabel, serverId, visible, onClose } = props;
  const { theme } = useUnistyles();
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const { config, isLoading, isSaving, isSupported, error, save } = useProviderNativeConfig(
    serverId,
    provider,
  );

  useEffect(() => {
    if (!visible) {
      setDraft("");
      setLocalError(null);
      return;
    }
    if (config) {
      setDraft(config.content);
      setLocalError(null);
    }
  }, [config, visible]);

  const title = providerLabel;
  const handleSave = useCallback(async () => {
    setLocalError(null);
    try {
      await save(draft);
      onClose();
    } catch (saveError) {
      setLocalError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }, [draft, onClose, save]);

  const renderContent = () => {
    if (!isSupported) {
      return <Text style={sheetStyles.errorText}>Native config editing is not available.</Text>;
    }
    if (isLoading && !config) {
      return (
        <View style={sheetStyles.emptyRow}>
          <ActivityIndicator size="small" />
          <Text style={sheetStyles.mutedText}>Loading config…</Text>
        </View>
      );
    }
    return (
      <>
        <Text style={sheetStyles.monoHint} selectable>
          {config?.path ?? "config.toml"}
        </Text>
        <AdaptiveTextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="[mcp_servers.example]"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          textAlignVertical="top"
          // @ts-expect-error - outlineStyle is web-only
          style={NATIVE_CONFIG_INPUT_STYLE}
        />
        {error || localError ? (
          <Text style={sheetStyles.errorText}>{localError ?? error}</Text>
        ) : null}
        <View style={sheetStyles.nativeConfigActions}>
          <Button variant="secondary" onPress={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button variant="default" onPress={handleSave} loading={isSaving}>
            Save config
          </Button>
        </View>
      </>
    );
  };

  return (
    <AdaptiveModalSheet
      title={`${title} config`}
      visible={visible}
      onClose={onClose}
      snapPoints={NATIVE_CONFIG_SNAP_POINTS}
    >
      <View style={sheetStyles.nativeConfigSheetContent}>{renderContent()}</View>
    </AdaptiveModalSheet>
  );
}

function ProviderNativeMcpSheet(props: {
  provider: AgentProvider;
  providerLabel: string;
  serverId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { provider, providerLabel, serverId, visible, onClose } = props;
  const [editingServer, setEditingServer] = useState<ProviderNativeMcpServer | null>(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const { servers, isLoading, isSaving, isSupported, error, upsert, remove } =
    useProviderNativeMcpServers(serverId, provider);

  useEffect(() => {
    if (!visible) {
      setEditingServer(null);
      setEditorVisible(false);
      setLocalError(null);
    }
  }, [visible]);

  const title = providerLabel;
  const sortedServers = useMemo(
    () => [...servers].sort(compareProviderNativeMcpServers),
    [servers],
  );

  const handleAdd = useCallback(() => {
    setEditingServer(null);
    setEditorVisible(true);
  }, []);

  const handleEdit = useCallback((server: ProviderNativeMcpServer) => {
    setEditingServer(server);
    setEditorVisible(true);
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditingServer(null);
    setEditorVisible(false);
  }, []);

  const handleSubmit = useCallback(
    async (input: { id: string; config: McpServerConfig; enabled: boolean }) => {
      setLocalError(null);
      await upsert(input);
      handleCloseEditor();
    },
    [handleCloseEditor, upsert],
  );

  const handleToggle = useCallback(
    (server: ProviderNativeMcpServer, enabled: boolean) => {
      setLocalError(null);
      void upsert({ id: server.id, config: server.config, enabled }).catch((toggleError) => {
        setLocalError(formatNativeMcpError(toggleError));
      });
    },
    [upsert],
  );

  const handleRemove = useCallback(
    (server: ProviderNativeMcpServer) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: `Remove ${server.id}?`,
          message: "This removes the MCP server from the shared provider config.",
          confirmLabel: "Remove",
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        setLocalError(null);
        await remove(server.id);
      })().catch((removeError) => {
        setLocalError(formatNativeMcpError(removeError));
      });
    },
    [remove],
  );

  const trailing = useMemo(
    () => (
      <Button variant="ghost" size="sm" onPress={handleAdd} disabled={!isSupported || isSaving}>
        Add MCP
      </Button>
    ),
    [handleAdd, isSaving, isSupported],
  );

  function renderBody() {
    if (!isSupported) {
      return <Text style={sheetStyles.errorText}>Native MCP editing is not available.</Text>;
    }
    if (isLoading && sortedServers.length === 0) {
      return (
        <View style={sheetStyles.emptyRow}>
          <ActivityIndicator size="small" />
          <Text style={sheetStyles.mutedText}>Loading MCP servers…</Text>
        </View>
      );
    }
    if (sortedServers.length === 0) {
      return (
        <View style={sheetStyles.emptyRow}>
          <Text style={sheetStyles.mutedText}>No MCP servers in this provider config.</Text>
        </View>
      );
    }
    return sortedServers.map((server) => (
      <ProviderNativeMcpRow
        key={server.id}
        server={server}
        busy={isSaving}
        onToggle={handleToggle}
        onEdit={handleEdit}
        onRemove={handleRemove}
      />
    ));
  }

  return (
    <>
      <AdaptiveModalSheet
        title={`${title} MCP`}
        visible={visible}
        onClose={onClose}
        snapPoints={NATIVE_MCP_SNAP_POINTS}
      >
        <SettingsSection title="MCP Servers" trailing={trailing}>
          <View style={settingsStyles.card}>{renderBody()}</View>
          {error || localError ? (
            <Text style={sheetStyles.errorText}>{localError ?? error}</Text>
          ) : null}
        </SettingsSection>
      </AdaptiveModalSheet>
      <ProviderNativeMcpEditor
        visible={editorVisible}
        server={editingServer}
        isSaving={isSaving}
        onClose={handleCloseEditor}
        onSubmit={handleSubmit}
      />
    </>
  );
}

function ProviderNativeMcpRow(props: {
  server: ProviderNativeMcpServer;
  busy: boolean;
  onToggle: (server: ProviderNativeMcpServer, enabled: boolean) => void;
  onEdit: (server: ProviderNativeMcpServer) => void;
  onRemove: (server: ProviderNativeMcpServer) => void;
}) {
  const { server, busy, onToggle, onEdit, onRemove } = props;
  const { theme } = useUnistyles();
  const handleToggle = useCallback(
    (enabled: boolean) => onToggle(server, enabled),
    [onToggle, server],
  );
  const handleEdit = useCallback(() => onEdit(server), [onEdit, server]);
  const handleRemove = useCallback(() => onRemove(server), [onRemove, server]);

  return (
    <View style={MCP_SERVER_ROW_STYLE}>
      <View style={sheetStyles.mcpServerHeader}>
        <View style={sheetStyles.mcpServerContent}>
          <View style={sheetStyles.profileTitleRow}>
            <Text style={sheetStyles.mcpServerTitle} numberOfLines={1}>
              {server.id}
            </Text>
            <Text style={sheetStyles.nativeMcpBadge}>native</Text>
          </View>
          <Text style={sheetStyles.monoHint}>{formatNativeMcpConfigSummary(server.config)}</Text>
        </View>
        <Switch
          value={server.enabled}
          onValueChange={handleToggle}
          disabled={busy}
          accessibilityLabel={`${server.enabled ? "Disable" : "Enable"} ${server.id}`}
        />
      </View>
      <View style={sheetStyles.mcpServerActions}>
        <Pressable
          onPress={handleEdit}
          disabled={busy}
          hitSlop={8}
          style={sheetStyles.mcpIconButton}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${server.id} MCP config`}
        >
          <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        </Pressable>
        <Pressable
          onPress={handleRemove}
          disabled={busy}
          hitSlop={8}
          style={sheetStyles.mcpIconButton}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${server.id} MCP server`}
        >
          <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />
        </Pressable>
      </View>
    </View>
  );
}

function ProviderNativeMcpEditor(props: {
  visible: boolean;
  server: ProviderNativeMcpServer | null;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (input: { id: string; config: McpServerConfig; enabled: boolean }) => Promise<void>;
}) {
  const { visible, server, isSaving, onClose, onSubmit } = props;
  const [id, setId] = useState("");
  const [configJson, setConfigJson] = useState(DEFAULT_MCP_CONFIG_JSON);
  const [error, setError] = useState<string | null>(null);
  const isEditing = Boolean(server);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setId(server?.id ?? "");
    setConfigJson(server ? JSON.stringify(server.config, null, 2) : DEFAULT_MCP_CONFIG_JSON);
    setError(null);
  }, [server, visible]);

  const handleSave = useCallback(async () => {
    const nextId = id.trim();
    if (!nextId) {
      setError("MCP id is required.");
      return;
    }
    try {
      const config = parseNativeMcpConfig(configJson);
      setError(null);
      await onSubmit({ id: server?.id ?? nextId, config, enabled: server?.enabled ?? true });
    } catch (saveError) {
      setError(formatNativeMcpError(saveError));
    }
  }, [configJson, id, onSubmit, server]);

  return (
    <AdaptiveModalSheet
      title={isEditing ? "Edit MCP JSON" : "Add MCP"}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={620}
    >
      <View style={sheetStyles.nativeConfigSheetContent}>
        <View style={sheetStyles.fieldGroup}>
          <Text style={sheetStyles.fieldLabel}>ID</Text>
          <AdaptiveTextInput
            value={id}
            onChangeText={setId}
            editable={!isEditing}
            placeholder="context-mode"
            autoCapitalize="none"
            autoCorrect={false}
            // @ts-expect-error - outlineStyle is web-only
            style={MCP_TEXT_INPUT_STYLE}
          />
        </View>
        <View style={sheetStyles.fieldGroup}>
          <Text style={sheetStyles.fieldLabel}>Config JSON</Text>
          <AdaptiveTextInput
            value={configJson}
            onChangeText={setConfigJson}
            placeholder={DEFAULT_MCP_CONFIG_JSON}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            textAlignVertical="top"
            // @ts-expect-error - outlineStyle is web-only
            style={MCP_JSON_INPUT_STYLE}
          />
        </View>
        {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
        <View style={sheetStyles.nativeConfigActions}>
          <Button variant="secondary" onPress={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button variant="default" onPress={handleSave} loading={isSaving}>
            {isEditing ? "Save JSON" : "Save MCP"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function AccountLoginSheet(props: {
  session: ReturnType<typeof useAccountLogin>["sessions"][number] | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { session, visible, onClose } = props;
  const openVerificationUrl = useCallback(() => {
    if (session?.verificationUrl) {
      void Linking.openURL(session.verificationUrl);
    }
  }, [session?.verificationUrl]);

  return (
    <AdaptiveModalSheet
      title="Add Codex account"
      visible={visible}
      onClose={onClose}
      snapPoints={ACCOUNT_LOGIN_SNAP_POINTS}
    >
      <View style={sheetStyles.loginSheetContent}>
        <AccountLoginSheetContent
          session={session}
          onClose={onClose}
          onOpenVerificationUrl={openVerificationUrl}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

function AccountLoginSheetContent(props: {
  session: ReturnType<typeof useAccountLogin>["sessions"][number] | null;
  onClose: () => void;
  onOpenVerificationUrl: () => void;
}) {
  const { session, onClose, onOpenVerificationUrl } = props;
  switch (session?.status) {
    case "pending-user":
      return (
        <>
          <Text style={settingsStyles.rowTitle}>Device code</Text>
          <Text style={sheetStyles.mutedText}>Open the login page and enter this code.</Text>
          <Text style={sheetStyles.deviceCode} selectable>
            {session.userCode}
          </Text>
          {session.verificationUrl ? (
            <Button variant="default" onPress={onOpenVerificationUrl}>
              Open login page
            </Button>
          ) : null}
          <Text style={sheetStyles.monoHint} selectable>
            {session.verificationUrl}
          </Text>
        </>
      );
    case "importing":
      return (
        <View style={sheetStyles.emptyRow}>
          <ActivityIndicator size="small" />
          <Text style={sheetStyles.mutedText}>Importing account…</Text>
        </View>
      );
    case "completed":
      return (
        <>
          <Text style={settingsStyles.rowTitle}>Account added</Text>
          <Text style={sheetStyles.mutedText}>
            {session.account?.alias || session.account?.email || "Codex account"}
          </Text>
          <Button variant="default" onPress={onClose}>
            Done
          </Button>
        </>
      );
    case "failed":
      return (
        <>
          <Text style={sheetStyles.errorText}>{session.error ?? "Account login failed"}</Text>
          <Button variant="default" onPress={onClose}>
            Close
          </Button>
        </>
      );
    case "cancelled":
    case "expired":
      return (
        <>
          <Text style={settingsStyles.rowTitle}>
            {session.status === "expired" ? "Login expired" : "Login cancelled"}
          </Text>
          <Button variant="default" onPress={onClose}>
            Close
          </Button>
        </>
      );
    default:
      return (
        <View style={sheetStyles.emptyRow}>
          <ActivityIndicator size="small" />
          <Text style={sheetStyles.mutedText}>Starting login…</Text>
        </View>
      );
  }
}

function DiagnosticCodeBlock(props: {
  loading: boolean;
  diagnostic: string | null;
  foregroundMutedColor: string;
}) {
  if (props.loading && !props.diagnostic) {
    return (
      <View style={sheetStyles.codeBlockLoading}>
        <ActivityIndicator size="small" color={props.foregroundMutedColor} />
        <Text style={sheetStyles.mutedText}>Running diagnostic…</Text>
      </View>
    );
  }
  if (props.diagnostic) {
    return (
      <ScrollView
        style={sheetStyles.codeScroll}
        contentContainerStyle={sheetStyles.codeContent}
        showsVerticalScrollIndicator={false}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text style={sheetStyles.codeText} selectable>
            {props.diagnostic}
          </Text>
        </ScrollView>
      </ScrollView>
    );
  }
  return (
    <View style={sheetStyles.codeBlockLoading}>
      <Text style={sheetStyles.mutedText}>No diagnostic available</Text>
    </View>
  );
}

export function ProviderDiagnosticSheet({
  provider,
  visible,
  onClose,
  serverId,
}: ProviderDiagnosticSheetProps) {
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const { entries: snapshotEntries, refresh, isRefreshing } = useProvidersSnapshot(serverId);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [accountRefreshNonce, setAccountRefreshNonce] = useState(0);

  const providerLabel = resolveProviderLabel(provider, snapshotEntries);
  const providerEntry = useMemo(
    () => snapshotEntries?.find((entry) => entry.provider === provider),
    [snapshotEntries, provider],
  );
  const models = providerEntry?.models ?? EMPTY_PROVIDER_MODELS;
  const providerSnapshotRefreshing = providerEntry?.status === "loading";
  const providerErrorMessage =
    providerEntry?.status === "error" ? (providerEntry.error ?? "Unknown error") : null;
  const refreshInFlight = isRefreshing || providerSnapshotRefreshing || loading;

  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setClockTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, [visible]);
  const fetchedAtLabel = useMemo(() => {
    if (!providerEntry?.fetchedAt) return null;
    void clockTick;
    return formatTimeAgo(new Date(providerEntry.fetchedAt));
  }, [providerEntry?.fetchedAt, clockTick]);

  const q = query.trim().toLowerCase();
  const filteredModels = q
    ? models.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    : models;

  const fetchDiagnostic = useCallback(
    async (options?: { keepCurrent?: boolean }) => {
      if (!client || !provider) return;

      setLoading(true);
      if (!options?.keepCurrent) {
        setDiagnostic(null);
      }

      try {
        const result = await client.getProviderDiagnostic(provider);
        setDiagnostic(result.diagnostic);
      } catch (err) {
        setDiagnostic(err instanceof Error ? err.message : "Failed to fetch diagnostic");
      } finally {
        setLoading(false);
      }
    },
    [client, provider],
  );

  const refreshButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      refreshInFlight ? sheetStyles.disabled : null,
    ],
    [refreshInFlight],
  );

  const handleRefresh = useCallback(() => {
    if (!provider) {
      return;
    }
    setAccountRefreshNonce((value) => value + 1);
    void Promise.all([refresh([provider]), fetchDiagnostic()]).catch((err) => {
      setDiagnostic(err instanceof Error ? err.message : "Failed to refresh provider");
    });
  }, [fetchDiagnostic, provider, refresh]);

  const headerActions = useMemo(
    () => (
      <Pressable
        onPress={handleRefresh}
        disabled={refreshInFlight}
        hitSlop={8}
        style={refreshButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={
          refreshInFlight ? `Refreshing ${providerLabel}` : `Refresh ${providerLabel}`
        }
      >
        {refreshInFlight ? (
          <LoadingSpinner size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        ) : (
          <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        )}
      </Pressable>
    ),
    [
      handleRefresh,
      refreshInFlight,
      refreshButtonStyle,
      providerLabel,
      theme.iconSize.sm,
      theme.colors.foregroundMuted,
    ],
  );

  useEffect(() => {
    if (visible) {
      fetchDiagnostic();
    } else {
      setDiagnostic(null);
      setQuery("");
    }
  }, [visible, fetchDiagnostic]);

  const modelsTrailing = useMemo(() => {
    if (models.length === 0 && !fetchedAtLabel) return undefined;
    return (
      <View style={sheetStyles.modelsTrailing}>
        {models.length > 0 ? (
          <Text style={settingsStyles.sectionHeaderTitle}>{models.length}</Text>
        ) : null}
        {models.length > 0 && fetchedAtLabel ? (
          <Text style={settingsStyles.sectionHeaderTitle}>·</Text>
        ) : null}
        {fetchedAtLabel ? (
          <Text style={settingsStyles.sectionHeaderTitle}>Updated {fetchedAtLabel}</Text>
        ) : null}
      </View>
    );
  }, [models.length, fetchedAtLabel]);

  function renderModelsBody() {
    if (models.length === 0 && providerSnapshotRefreshing) {
      return (
        <View style={sheetStyles.emptyRow}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>Loading models…</Text>
        </View>
      );
    }
    if (models.length === 0 && providerErrorMessage) {
      return (
        <View style={sheetStyles.emptyRow}>
          <AlertCircle size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>{providerErrorMessage}</Text>
        </View>
      );
    }
    if (models.length === 0) {
      return (
        <View style={sheetStyles.emptyRow}>
          <Text style={sheetStyles.mutedText}>No models detected</Text>
        </View>
      );
    }
    if (filteredModels.length === 0) {
      return (
        <View style={sheetStyles.emptyRow}>
          <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>No models match your search</Text>
        </View>
      );
    }
    return filteredModels.map((model: AgentModelDefinition) => (
      <ModelRow key={model.id} model={model} />
    ));
  }

  return (
    <AdaptiveModalSheet
      title={providerLabel}
      visible={visible}
      onClose={onClose}
      snapPoints={DIAGNOSTIC_SHEET_SNAP_POINTS}
      headerActions={headerActions}
    >
      <SettingsSection title="Diagnostic">
        <View style={settingsStyles.card}>
          <DiagnosticCodeBlock
            loading={loading}
            diagnostic={diagnostic}
            foregroundMutedColor={theme.colors.foregroundMuted}
          />
        </View>
      </SettingsSection>

      <CustomModelsSection provider={provider} serverId={serverId} refresh={refresh} />

      <ProviderAuthProfilesSection
        provider={provider}
        providerLabel={providerLabel}
        serverId={serverId}
        visible={visible}
        refreshNonce={accountRefreshNonce}
      />

      <View>
        <View style={sheetStyles.modelsHeader}>
          <Text style={settingsStyles.sectionHeaderTitle}>Models</Text>
          {modelsTrailing}
        </View>
        <View style={settingsStyles.card}>
          <View style={INLINE_ROW_STYLE}>
            <Search size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            <AdaptiveTextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search models"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              // @ts-expect-error - outlineStyle is web-only
              style={DIAGNOSTIC_SEARCH_INPUT_STYLE}
            />
          </View>
          <ScrollView
            style={sheetStyles.modelsScroll}
            contentContainerStyle={sheetStyles.modelsScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {renderModelsBody()}
          </ScrollView>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const sheetStyles = StyleSheet.create((theme) => ({
  mutedText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  monoHint: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[1],
  },
  usageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: theme.fontSize.sm * 1.35,
    marginTop: theme.spacing[1],
  },
  usageWarningText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    lineHeight: theme.fontSize.sm * 1.35,
    marginTop: theme.spacing[1],
  },
  usageErrorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
    lineHeight: theme.fontSize.xs * 1.35,
    marginTop: theme.spacing[1],
  },
  profileTimelineText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
    marginTop: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  disabled: {
    opacity: 0.5,
  },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inlineInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  codeScroll: {
    maxHeight: 200,
  },
  codeContent: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  codeText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  codeBlockLoading: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modelsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  modelsTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  trailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  authProfileRow: {
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  defaultAuthProfileRow: {
    backgroundColor: theme.colors.surface2,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.accent,
  },
  profileContent: {
    minWidth: 0,
    marginRight: 0,
  },
  profileTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  profileTitle: {
    flexShrink: 1,
  },
  defaultTitleBadge: {
    alignItems: "center",
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  profileActions: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[1],
    flexShrink: 0,
    width: 96,
  },
  profileActionButton: {
    alignSelf: "stretch",
    justifyContent: "flex-end",
    minHeight: 24,
    paddingHorizontal: 0,
  },
  profileActionButtonText: {
    textAlign: "right",
  },
  defaultBadge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    minHeight: 24,
    paddingHorizontal: 0,
    textAlign: "right",
  },
  providerConfigRow: {
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  providerConfigActions: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[1],
    flexShrink: 0,
    width: 96,
  },
  loginSheetContent: {
    gap: theme.spacing[4],
  },
  nativeConfigSheetContent: {
    gap: theme.spacing[3],
  },
  nativeConfigInput: {
    minHeight: 260,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  mcpJsonInput: {
    minHeight: 220,
  },
  mcpTextInput: {
    minHeight: 44,
  },
  nativeConfigActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  fieldGroup: {
    gap: theme.spacing[2],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  mcpServerRow: {
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  mcpServerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  mcpServerContent: {
    flex: 1,
    minWidth: 0,
  },
  mcpServerTitle: {
    color: theme.colors.foreground,
    flexShrink: 1,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  nativeMcpBadge: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.sm,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    overflow: "hidden",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  mcpServerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  mcpIconButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 30,
    minWidth: 30,
  },
  deviceCode: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    letterSpacing: 0,
  },
  modelsScroll: {
    maxHeight: 360,
  },
  modelsScrollContent: {
    paddingBottom: 0,
  },
  emptyRow: {
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
}));

const DIAGNOSTIC_SHEET_SNAP_POINTS = ["50%", "85%"];
const ACCOUNT_LOGIN_SNAP_POINTS = ["45%", "70%"];
const NATIVE_CONFIG_SNAP_POINTS = ["65%", "90%"];
const NATIVE_MCP_SNAP_POINTS = ["55%", "85%"];
const AUTO_USAGE_REFRESH_MAX_AGE_MS = 5 * 60_000;
const EMPTY_PROVIDER_MODELS: AgentModelDefinition[] = [];
const DEFAULT_MCP_CONFIG_JSON = JSON.stringify(
  {
    type: "stdio",
    command: "npx",
    args: ["-y", "example-mcp-server"],
  },
  null,
  2,
);
const DIAGNOSTIC_SEARCH_INPUT_STYLE = [sheetStyles.inlineInput, isWeb && { outlineStyle: "none" }];
const DIAGNOSTIC_INLINE_INPUT_STYLE = [sheetStyles.inlineInput, isWeb && { outlineStyle: "none" }];
const NATIVE_CONFIG_INPUT_STYLE = [
  sheetStyles.nativeConfigInput,
  isWeb && { outlineStyle: "none" },
];
const MCP_TEXT_INPUT_STYLE = [
  sheetStyles.nativeConfigInput,
  sheetStyles.mcpTextInput,
  isWeb && { outlineStyle: "none" },
];
const MCP_JSON_INPUT_STYLE = [
  sheetStyles.nativeConfigInput,
  sheetStyles.mcpJsonInput,
  isWeb && { outlineStyle: "none" },
];
const MODEL_ROW_STYLE = [settingsStyles.row, settingsStyles.rowBorder];
const MCP_SERVER_ROW_STYLE = [
  settingsStyles.row,
  settingsStyles.rowBorder,
  sheetStyles.mcpServerRow,
];
const AUTH_PROFILE_ROW_STYLE = [
  settingsStyles.row,
  settingsStyles.rowBorder,
  sheetStyles.authProfileRow,
];
const AUTH_PROFILE_DEFAULT_ROW_STYLE = [
  settingsStyles.row,
  settingsStyles.rowBorder,
  sheetStyles.authProfileRow,
  sheetStyles.defaultAuthProfileRow,
];
const PROVIDER_CONFIG_ROW_STYLE = [settingsStyles.row, sheetStyles.providerConfigRow];
const AUTH_PROFILE_CONTENT_STYLE = [settingsStyles.rowContent, sheetStyles.profileContent];
const AUTH_PROFILE_TITLE_STYLE = [settingsStyles.rowTitle, sheetStyles.profileTitle];
const INLINE_ROW_STYLE = [settingsStyles.row, sheetStyles.inlineRow];
