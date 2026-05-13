import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Download, Plus, RefreshCw, Trash2 } from "lucide-react-native";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import type {
  McpRegistryEntry,
  McpRegistryEntryInput,
  McpRegistryScope,
  McpResolutionStep,
  McpServerConfig,
} from "@server/shared/messages";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useMcpRegistry, toMcpRegistryEntryInput } from "@/hooks/use-mcp-registry";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

type ScopeKind = McpRegistryScope["kind"];

const SCOPE_OPTIONS: Array<{ id: ScopeKind; label: string }> = [
  { id: "global", label: "Global" },
  { id: "provider", label: "Provider" },
  { id: "account", label: "Account" },
  { id: "runtimeProfile", label: "Profile" },
];

const DEFAULT_PROVIDER: AgentProvider = "codex";
const DEFAULT_CONFIG_JSON = `{
  "type": "stdio",
  "command": "context-mode",
  "args": []
}`;

export function McpRegistrySection({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const registry = useMcpRegistry(serverId);
  const providersSnapshot = useProvidersSnapshot(serverId, { enabled: registry.isSupported });
  const [isEditorVisible, setIsEditorVisible] = useState(false);
  const [previewProvider, setPreviewProvider] = useState<AgentProvider>(DEFAULT_PROVIDER);
  const [previewSteps, setPreviewSteps] = useState<McpResolutionStep[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const providerOptions = useMemo(() => {
    const ids = new Set<AgentProvider>();
    ids.add(DEFAULT_PROVIDER);
    for (const entry of providersSnapshot.entries ?? []) {
      if (entry.provider) {
        ids.add(entry.provider);
      }
    }
    return Array.from(ids);
  }, [providersSnapshot.entries]);

  const entries = useMemo(() => [...registry.entries].sort(compareMcpEntries), [registry.entries]);

  const loadPreview = useCallback(async () => {
    if (!registry.isSupported || !previewProvider) {
      return;
    }
    try {
      setIsPreviewLoading(true);
      setPreviewError(null);
      const response = await registry.explain({
        provider: previewProvider,
        includeSystem: true,
      });
      setPreviewSteps(response.steps);
    } catch (error) {
      setPreviewError(formatError(error));
      setPreviewSteps([]);
    } finally {
      setIsPreviewLoading(false);
    }
  }, [previewProvider, registry]);

  useEffect(() => {
    if (!registry.isSupported) {
      return;
    }
    void loadPreview();
  }, [loadPreview, registry.isSupported]);

  const handleCreate = useCallback(() => {
    setIsEditorVisible(true);
  }, []);

  const handleCloseEditor = useCallback(() => {
    setIsEditorVisible(false);
  }, []);

  const handleSelectPreviewProvider = useCallback((provider: AgentProvider) => {
    setPreviewProvider(provider);
  }, []);

  const handleSave = useCallback(
    async (entry: McpRegistryEntryInput) => {
      await registry.upsert(entry);
      setIsEditorVisible(false);
      await loadPreview();
    },
    [loadPreview, registry],
  );

  const handleToggle = useCallback(
    async (entry: McpRegistryEntry, enabled: boolean) => {
      await registry.upsert(toMcpRegistryEntryInput(entry, { enabled }));
      await loadPreview();
    },
    [loadPreview, registry],
  );

  const handleRemove = useCallback(
    async (entry: McpRegistryEntry) => {
      const confirmed = await confirmDialog({
        title: "Remove MCP entry",
        message: `Remove ${entry.id} from ${formatScope(entry.scope)}?`,
        confirmLabel: "Remove",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await registry.remove({ id: entry.id, scope: entry.scope });
      await loadPreview();
    },
    [loadPreview, registry],
  );

  const handleImportCodex = useCallback(async () => {
    try {
      const response = await registry.importNative({ provider: DEFAULT_PROVIDER });
      await loadPreview();
      Alert.alert(
        "Native MCP imported",
        `Imported ${response.entries.length} Codex MCP entr${
          response.entries.length === 1 ? "y" : "ies"
        }. Skipped ${response.skipped.length}.`,
      );
    } catch (error) {
      Alert.alert("Import failed", formatError(error));
    }
  }, [loadPreview, registry]);

  const trailing = useMemo(
    () => (
      <View style={styles.headerActions}>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={Download}
          onPress={handleImportCodex}
          disabled={registry.isRefreshing}
          testID="mcp-registry-import-codex"
        >
          Import Codex
        </Button>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={Plus}
          onPress={handleCreate}
          disabled={registry.isRefreshing}
          testID="mcp-registry-create"
        >
          Add MCP
        </Button>
      </View>
    ),
    [handleCreate, handleImportCodex, registry.isRefreshing],
  );

  if (!registry.isSupported) {
    return null;
  }

  return (
    <SettingsSection title="MCP" trailing={trailing} testID="host-page-mcp-registry">
      <View style={settingsStyles.card}>
        {registry.isLoading && entries.length === 0 ? (
          <View style={styles.emptyRow}>
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            <Text style={styles.mutedText}>Loading MCP registry...</Text>
          </View>
        ) : null}
        {!registry.isLoading && entries.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.mutedText}>
              No registry entries yet. Add one or import native Codex MCP servers.
            </Text>
          </View>
        ) : null}
        {entries.map((entry, index) => (
          <McpRegistryEntryRow
            key={`${formatScopeKey(entry.scope)}:${entry.id}`}
            entry={entry}
            showBorder={index > 0}
            disabled={registry.isRefreshing}
            onToggle={handleToggle}
            onRemove={handleRemove}
          />
        ))}
      </View>
      {registry.error ? <Text style={styles.errorText}>{registry.error}</Text> : null}

      <View style={styles.previewHeader}>
        <Text style={styles.previewTitle}>Resolved preview</Text>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={RefreshCw}
          onPress={loadPreview}
          disabled={registry.isRefreshing || isPreviewLoading}
          loading={isPreviewLoading}
          testID="mcp-registry-preview-refresh"
        >
          Refresh
        </Button>
      </View>
      <View style={styles.providerChips}>
        {providerOptions.map((provider) => (
          <PreviewProviderButton
            key={provider}
            provider={provider}
            selectedProvider={previewProvider}
            disabled={isPreviewLoading}
            onSelect={handleSelectPreviewProvider}
          />
        ))}
      </View>
      <View style={settingsStyles.card}>
        {isPreviewLoading && previewSteps.length === 0 ? (
          <View style={styles.emptyRow}>
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            <Text style={styles.mutedText}>Resolving MCP servers...</Text>
          </View>
        ) : null}
        {!isPreviewLoading && previewSteps.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.mutedText}>No MCP servers resolved for {previewProvider}.</Text>
          </View>
        ) : null}
        {previewSteps.map((step, index) => (
          <McpPreviewRow key={formatResolutionStepKey(step)} step={step} showBorder={index > 0} />
        ))}
      </View>
      {previewError ? <Text style={styles.errorText}>{previewError}</Text> : null}
      {providersSnapshot.error ? (
        <Text style={styles.errorText}>{providersSnapshot.error}</Text>
      ) : null}

      <McpRegistryEditor
        visible={isEditorVisible}
        defaultProvider={previewProvider}
        isSaving={registry.isRefreshing}
        onClose={handleCloseEditor}
        onSubmit={handleSave}
      />
    </SettingsSection>
  );
}

function McpRegistryEntryRow({
  entry,
  showBorder,
  disabled,
  onToggle,
  onRemove,
}: {
  entry: McpRegistryEntry;
  showBorder: boolean;
  disabled: boolean;
  onToggle: (entry: McpRegistryEntry, enabled: boolean) => void;
  onRemove: (entry: McpRegistryEntry) => void;
}) {
  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );
  const handleEnabledChange = useCallback(
    (enabled: boolean) => onToggle(entry, enabled),
    [entry, onToggle],
  );
  const handleRemovePress = useCallback(() => onRemove(entry), [entry, onRemove]);
  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <View style={styles.titleLine}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {entry.id}
          </Text>
          <Text style={styles.sourcePill}>{formatEntrySource(entry)}</Text>
        </View>
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          {formatScope(entry.scope)} · {formatMcpConfigSummary(entry.config)}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Switch
          value={entry.enabled}
          onValueChange={handleEnabledChange}
          disabled={disabled}
          accessibilityLabel={`${entry.id} enabled`}
          testID={`mcp-registry-toggle-${entry.id}`}
        />
        <Button
          variant="ghost"
          size="xs"
          leftIcon={Trash2}
          onPress={handleRemovePress}
          disabled={disabled}
          testID={`mcp-registry-remove-${entry.id}`}
        >
          Remove
        </Button>
      </View>
    </View>
  );
}

function McpPreviewRow({ step, showBorder }: { step: McpResolutionStep; showBorder: boolean }) {
  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );
  const sourcePillStyle = useMemo(
    () => [styles.sourcePill, getActionToneStyle(step.action)],
    [step.action],
  );
  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <View style={styles.titleLine}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {step.id}
          </Text>
          <Text style={sourcePillStyle}>{step.action}</Text>
        </View>
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          {formatResolvedSource(step.source)}
          {step.reason ? ` · ${step.reason}` : ""}
        </Text>
      </View>
    </View>
  );
}

function McpRegistryEditor({
  visible,
  defaultProvider,
  isSaving,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  defaultProvider: AgentProvider;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (entry: McpRegistryEntryInput) => Promise<void>;
}) {
  const [id, setId] = useState("");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("global");
  const [provider, setProvider] = useState(defaultProvider);
  const [accountKey, setAccountKey] = useState("");
  const [profileId, setProfileId] = useState("");
  const [configJson, setConfigJson] = useState(DEFAULT_CONFIG_JSON);
  const [error, setError] = useState<string | null>(null);
  const jsonInputStyle = useMemo(() => [styles.textInput, styles.jsonInput], []);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setId("");
    setScopeKind("global");
    setProvider(defaultProvider);
    setAccountKey("");
    setProfileId("");
    setConfigJson(DEFAULT_CONFIG_JSON);
    setError(null);
  }, [defaultProvider, visible]);

  const handleSave = useCallback(async () => {
    const nextId = id.trim();
    if (!nextId) {
      setError("MCP id is required.");
      return;
    }
    try {
      const scope = buildScope({
        kind: scopeKind,
        provider: provider.trim(),
        accountKey: accountKey.trim(),
        profileId: profileId.trim(),
      });
      const config = parseMcpConfig(configJson);
      setError(null);
      await onSubmit({
        id: nextId,
        scope,
        config,
        enabled: true,
        source: "user",
      });
    } catch (saveError) {
      setError(formatError(saveError));
    }
  }, [accountKey, configJson, id, onSubmit, profileId, provider, scopeKind]);

  return (
    <AdaptiveModalSheet
      title="Add MCP"
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={620}
      testID="mcp-registry-editor"
    >
      <View style={styles.editorBody}>
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>ID</Text>
          <AdaptiveTextInput
            value={id}
            onChangeText={setId}
            placeholder="context-mode"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.textInput}
            testID="mcp-registry-editor-id"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Scope</Text>
          <View style={styles.scopeButtons}>
            {SCOPE_OPTIONS.map((option) => (
              <ScopeOptionButton
                key={option.id}
                option={option}
                selected={scopeKind === option.id}
                onSelect={setScopeKind}
              />
            ))}
          </View>
        </View>

        {scopeKind === "provider" || scopeKind === "account" ? (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Provider</Text>
            <AdaptiveTextInput
              value={provider}
              onChangeText={setProvider}
              placeholder="codex"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.textInput}
              testID="mcp-registry-editor-provider"
            />
          </View>
        ) : null}

        {scopeKind === "account" ? (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Account key</Text>
            <AdaptiveTextInput
              value={accountKey}
              onChangeText={setAccountKey}
              placeholder="kolektifhubdigital"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.textInput}
              testID="mcp-registry-editor-account-key"
            />
          </View>
        ) : null}

        {scopeKind === "runtimeProfile" ? (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Profile ID</Text>
            <AdaptiveTextInput
              value={profileId}
              onChangeText={setProfileId}
              placeholder="profile id"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.textInput}
              testID="mcp-registry-editor-profile-id"
            />
          </View>
        ) : null}

        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Config JSON</Text>
          <AdaptiveTextInput
            value={configJson}
            onChangeText={setConfigJson}
            multiline
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
            style={jsonInputStyle}
            testID="mcp-registry-editor-config"
          />
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.editorActions}>
          <Button variant="ghost" onPress={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onPress={handleSave} disabled={isSaving} loading={isSaving}>
            Save MCP
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function PreviewProviderButton({
  provider,
  selectedProvider,
  disabled,
  onSelect,
}: {
  provider: AgentProvider;
  selectedProvider: AgentProvider;
  disabled: boolean;
  onSelect: (provider: AgentProvider) => void;
}) {
  const handlePress = useCallback(() => onSelect(provider), [onSelect, provider]);
  return (
    <Button
      variant={selectedProvider === provider ? "secondary" : "ghost"}
      size="xs"
      onPress={handlePress}
      disabled={disabled}
      testID={`mcp-registry-preview-provider-${provider}`}
    >
      {provider}
    </Button>
  );
}

function ScopeOptionButton({
  option,
  selected,
  onSelect,
}: {
  option: { id: ScopeKind; label: string };
  selected: boolean;
  onSelect: (scope: ScopeKind) => void;
}) {
  const handlePress = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  return (
    <Button
      variant={selected ? "secondary" : "outline"}
      size="xs"
      onPress={handlePress}
      testID={`mcp-registry-editor-scope-${option.id}`}
    >
      {option.label}
    </Button>
  );
}

function buildScope(input: {
  kind: ScopeKind;
  provider: string;
  accountKey: string;
  profileId: string;
}): McpRegistryScope {
  if (input.kind === "global") {
    return { kind: "global" };
  }
  if (input.kind === "provider") {
    if (!input.provider) {
      throw new Error("Provider is required.");
    }
    return { kind: "provider", provider: input.provider };
  }
  if (input.kind === "account") {
    if (!input.provider) {
      throw new Error("Provider is required.");
    }
    if (!input.accountKey) {
      throw new Error("Account key is required.");
    }
    return { kind: "account", provider: input.provider, accountKey: input.accountKey };
  }
  if (!input.profileId) {
    throw new Error("Profile ID is required.");
  }
  return { kind: "runtimeProfile", profileId: input.profileId };
}

function parseMcpConfig(value: string): McpServerConfig {
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

function compareMcpEntries(left: McpRegistryEntry, right: McpRegistryEntry): number {
  const scopeCompare = getScopeRank(left.scope) - getScopeRank(right.scope);
  if (scopeCompare !== 0) {
    return scopeCompare;
  }
  return left.id.localeCompare(right.id);
}

function getScopeRank(scope: McpRegistryScope): number {
  if (scope.kind === "global") return 0;
  if (scope.kind === "provider") return 1;
  if (scope.kind === "account") return 2;
  return 3;
}

function formatScope(scope: McpRegistryScope): string {
  if (scope.kind === "global") {
    return "global";
  }
  if (scope.kind === "provider") {
    return `provider:${scope.provider}`;
  }
  if (scope.kind === "account") {
    return `account:${scope.provider}:${scope.accountKey}`;
  }
  return `profile:${scope.profileId}`;
}

function formatScopeKey(scope: McpRegistryScope): string {
  if (scope.kind === "global") {
    return "global";
  }
  if (scope.kind === "provider") {
    return `provider:${scope.provider}`;
  }
  if (scope.kind === "account") {
    return `account:${scope.provider}:${scope.accountKey}`;
  }
  return `runtimeProfile:${scope.profileId}`;
}

function formatMcpConfigSummary(config: McpServerConfig): string {
  if (config.type === "stdio") {
    const args = config.args?.length ? ` · ${config.args.length} args` : "";
    const env = config.env && Object.keys(config.env).length > 0 ? " · env" : "";
    return `stdio · ${config.command}${args}${env}`;
  }
  return `${config.type} · ${config.url}`;
}

function formatEntrySource(entry: McpRegistryEntry): string {
  return entry.source === "native-import" ? "native" : "user";
}

function formatResolvedSource(source: McpResolutionStep["source"]): string {
  const parts: string[] = [source.scope, source.source];
  if (source.provider) {
    parts.push(source.provider);
  }
  if (source.accountKey) {
    parts.push(source.accountKey);
  }
  if (source.runtimeProfileId) {
    parts.push(source.runtimeProfileId);
  }
  if (source.protected) {
    parts.push("protected");
  }
  return parts.join(" · ");
}

function formatResolutionStepKey(step: McpResolutionStep): string {
  const overriddenBy = step.overriddenBy ? formatResolvedSource(step.overriddenBy) : "";
  return [step.id, step.action, formatResolvedSource(step.source), overriddenBy].join(":");
}

function getActionToneStyle(action: McpResolutionStep["action"]) {
  if (action === "selected") {
    return styles.selectedPill;
  }
  if (action === "overridden") {
    return styles.warningPill;
  }
  return styles.mutedPill;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const styles = StyleSheet.create((theme) => ({
  headerActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  emptyRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginLeft: theme.spacing[1],
    marginTop: theme.spacing[2],
  },
  titleLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  sourcePill: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.sm,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    overflow: "hidden",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  selectedPill: {
    backgroundColor: "rgba(34, 197, 94, 0.12)",
    color: theme.colors.palette.green[400],
  },
  warningPill: {
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    color: theme.colors.palette.amber[500],
  },
  mutedPill: {
    color: theme.colors.foregroundMuted,
  },
  rowActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  previewHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: theme.spacing[4],
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  previewTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  providerChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  editorBody: {
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  fieldGroup: {
    gap: theme.spacing[2],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  textInput: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    minHeight: 40,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  jsonInput: {
    minHeight: 160,
  },
  scopeButtons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  editorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
