import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Download, Pencil, Plus, Trash2 } from "lucide-react-native";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import type {
  McpRegistryEntry,
  McpRegistryEntryInput,
  McpRegistryScope,
  McpServerConfig,
} from "@server/shared/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useMcpRegistry, toMcpRegistryEntryInput } from "@/hooks/use-mcp-registry";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

const DEFAULT_PROVIDER: AgentProvider = "codex";
const GLOBAL_SCOPE: McpRegistryScope = { kind: "global" };
const DEFAULT_CONFIG_JSON = `{
  "type": "stdio",
  "command": "context-mode",
  "args": []
}`;

export function McpRegistrySection({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const registry = useMcpRegistry(serverId);
  const daemonConfig = useDaemonConfig(serverId);
  const [editingEntry, setEditingEntry] = useState<McpRegistryEntry | null>(null);
  const [isEditorVisible, setIsEditorVisible] = useState(false);

  const entries = useMemo(() => [...registry.entries].sort(compareMcpEntries), [registry.entries]);
  const isPaseoToolsEnabled = daemonConfig.config?.mcp.injectIntoAgents !== false;
  const isSystemRowDisabled = daemonConfig.isLoading || registry.isRefreshing;
  const emptyExternalRowStyle = useMemo(() => [styles.emptyRow, settingsStyles.rowBorder], []);

  const handleCreate = useCallback(() => {
    setEditingEntry(null);
    setIsEditorVisible(true);
  }, []);

  const handleEdit = useCallback((entry: McpRegistryEntry) => {
    setEditingEntry(entry);
    setIsEditorVisible(true);
  }, []);

  const handleCloseEditor = useCallback(() => {
    setIsEditorVisible(false);
  }, []);

  const handleSave = useCallback(
    async (entry: McpRegistryEntryInput) => {
      await registry.upsert(entry);
      setIsEditorVisible(false);
    },
    [registry],
  );

  const handleToggle = useCallback(
    async (entry: McpRegistryEntry, enabled: boolean) => {
      await registry.upsert(toMcpRegistryEntryInput(entry, { enabled }));
    },
    [registry],
  );

  const handleRemove = useCallback(
    async (entry: McpRegistryEntry) => {
      const confirmed = await confirmDialog({
        title: "Remove MCP server",
        message: `Remove ${entry.id}?`,
        confirmLabel: "Remove",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await registry.remove({ id: entry.id, scope: entry.scope });
    },
    [registry],
  );

  const handleTogglePaseoTools = useCallback(
    (enabled: boolean) => {
      void daemonConfig.patchConfig({
        mcp: {
          injectIntoAgents: enabled,
        },
      });
    },
    [daemonConfig],
  );

  const handleImportCodex = useCallback(async () => {
    try {
      const response = await registry.importNative({ provider: DEFAULT_PROVIDER });
      Alert.alert(
        "Native MCP imported",
        `Imported ${response.entries.length} Codex MCP entr${
          response.entries.length === 1 ? "y" : "ies"
        }. Skipped ${response.skipped.length}.`,
      );
    } catch (error) {
      Alert.alert("Import failed", formatError(error));
    }
  }, [registry]);

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
          Import from Codex
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
    <SettingsSection title="MCP Servers" trailing={trailing} testID="host-page-mcp-registry">
      <View style={settingsStyles.card}>
        <McpSystemToolsRow
          enabled={isPaseoToolsEnabled}
          disabled={isSystemRowDisabled}
          onToggle={handleTogglePaseoTools}
        />
        {registry.isLoading && entries.length === 0 ? (
          <View style={styles.emptyRow}>
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            <Text style={styles.mutedText}>Loading MCP servers...</Text>
          </View>
        ) : null}
        {!registry.isLoading && entries.length === 0 ? (
          <View style={emptyExternalRowStyle}>
            <Text style={styles.mutedText}>
              No external MCP servers yet. Add one or import native Codex MCP servers.
            </Text>
          </View>
        ) : null}
        {entries.map((entry) => (
          <McpRegistryEntryRow
            key={`${formatScopeKey(entry.scope)}:${entry.id}`}
            entry={entry}
            showBorder
            disabled={registry.isRefreshing}
            onEdit={handleEdit}
            onToggle={handleToggle}
            onRemove={handleRemove}
          />
        ))}
      </View>
      {registry.error ? <Text style={styles.errorText}>{registry.error}</Text> : null}

      <McpRegistryEditor
        visible={isEditorVisible}
        entry={editingEntry}
        isSaving={registry.isRefreshing}
        onClose={handleCloseEditor}
        onSubmit={handleSave}
      />
    </SettingsSection>
  );
}

function McpSystemToolsRow({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <View style={settingsStyles.row} testID="mcp-registry-system-paseo-tools">
      <View style={settingsStyles.rowContent}>
        <View style={styles.titleLine}>
          <Text style={styles.rowTitleText} numberOfLines={1}>
            Paseo tools
          </Text>
          <Text style={styles.sourcePill}>system</Text>
          <Text style={styles.sourcePill}>managed</Text>
        </View>
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          system · Paseo agent control tools
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Switch
          value={enabled}
          onValueChange={onToggle}
          disabled={disabled}
          accessibilityLabel="Paseo tools enabled"
          testID="mcp-registry-toggle-paseo-tools"
        />
      </View>
    </View>
  );
}

function McpRegistryEntryRow({
  entry,
  showBorder,
  disabled,
  onEdit,
  onToggle,
  onRemove,
}: {
  entry: McpRegistryEntry;
  showBorder: boolean;
  disabled: boolean;
  onEdit: (entry: McpRegistryEntry) => void;
  onToggle: (entry: McpRegistryEntry, enabled: boolean) => void;
  onRemove: (entry: McpRegistryEntry) => void;
}) {
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const rowStyle = useMemo(
    () => [
      settingsStyles.row,
      showBorder && settingsStyles.rowBorder,
      isCompact && styles.entryRowCompact,
    ],
    [isCompact, showBorder],
  );
  const rowContentStyle = useMemo(
    () => [settingsStyles.rowContent, isCompact && styles.rowContentCompact],
    [isCompact],
  );
  const rowActionsStyle = useMemo(
    () => [styles.rowActions, isCompact && styles.rowActionsCompact],
    [isCompact],
  );
  const handleEditPress = useCallback(() => onEdit(entry), [entry, onEdit]);
  const handleEnabledChange = useCallback(
    (enabled: boolean) => onToggle(entry, enabled),
    [entry, onToggle],
  );
  const handleRemovePress = useCallback(() => onRemove(entry), [entry, onRemove]);
  const editIcon = useMemo(
    () => <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [theme.colors.foregroundMuted, theme.iconSize.sm],
  );
  const removeIcon = useMemo(
    () => <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />,
    [theme.colors.destructive, theme.iconSize.sm],
  );

  const rowContent = (
    <View style={rowContentStyle}>
      <View style={styles.titleLine}>
        <Text style={styles.rowTitleText} numberOfLines={1}>
          {entry.id}
        </Text>
        <Text style={styles.sourcePill}>{formatEntrySource(entry)}</Text>
      </View>
      <Text style={settingsStyles.rowHint} numberOfLines={2}>
        {formatMcpConfigSummary(entry.config)}
      </Text>
    </View>
  );

  const enabledSwitch = (
    <Switch
      value={entry.enabled}
      onValueChange={handleEnabledChange}
      disabled={disabled}
      accessibilityLabel={`${entry.id} enabled`}
      testID={`mcp-registry-toggle-${entry.id}`}
    />
  );

  const rowActions = (
    <>
      <Button
        variant="ghost"
        size="xs"
        leftIcon={Pencil}
        onPress={handleEditPress}
        disabled={disabled}
        testID={`mcp-registry-edit-${entry.id}`}
      >
        Edit JSON
      </Button>
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
    </>
  );

  const iconRowActions = (
    <View style={styles.iconActionsCompact}>
      <Button
        variant="ghost"
        size="xs"
        leftIcon={editIcon}
        onPress={handleEditPress}
        disabled={disabled}
        accessibilityLabel={`Edit ${entry.id} MCP server`}
        testID={`mcp-registry-edit-${entry.id}`}
      />
      <Button
        variant="ghost"
        size="xs"
        leftIcon={removeIcon}
        onPress={handleRemovePress}
        disabled={disabled}
        accessibilityLabel={`Remove ${entry.id} MCP server`}
        testID={`mcp-registry-remove-${entry.id}`}
      />
    </View>
  );

  if (isCompact) {
    return (
      <View style={rowStyle}>
        <View style={styles.entryHeaderCompact}>
          {rowContent}
          <View style={styles.entryControlsCompact}>
            {enabledSwitch}
            {iconRowActions}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={rowStyle}>
      {rowContent}
      <View style={rowActionsStyle}>
        {enabledSwitch}
        {rowActions}
      </View>
    </View>
  );
}

function McpRegistryEditor({
  visible,
  entry,
  isSaving,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  entry: McpRegistryEntry | null;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (entry: McpRegistryEntryInput) => Promise<void>;
}) {
  const [id, setId] = useState("");
  const [configJson, setConfigJson] = useState(DEFAULT_CONFIG_JSON);
  const [error, setError] = useState<string | null>(null);
  const jsonInputStyle = useMemo(() => [styles.textInput, styles.jsonInput], []);
  const isEditing = entry !== null;

  useEffect(() => {
    if (!visible) {
      return;
    }
    setId(entry?.id ?? "");
    setConfigJson(entry ? JSON.stringify(entry.config, null, 2) : DEFAULT_CONFIG_JSON);
    setError(null);
  }, [entry, visible]);

  const handleSave = useCallback(async () => {
    const nextId = id.trim();
    if (!nextId) {
      setError("MCP id is required.");
      return;
    }
    try {
      const config = parseMcpConfig(configJson);
      setError(null);
      await onSubmit({
        id: entry?.id ?? nextId,
        scope: entry?.scope ?? GLOBAL_SCOPE,
        config,
        enabled: entry?.enabled ?? true,
        source: entry?.source ?? "user",
        importedFrom: entry?.importedFrom,
      });
    } catch (saveError) {
      setError(formatError(saveError));
    }
  }, [configJson, entry, id, onSubmit]);

  return (
    <AdaptiveModalSheet
      title={isEditing ? "Edit MCP JSON" : "Add MCP"}
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
            editable={!isEditing}
            placeholder="context-mode"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.textInput}
            testID="mcp-registry-editor-id"
          />
        </View>

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
            {isEditing ? "Save JSON" : "Save MCP"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
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
  return left.id.localeCompare(right.id);
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
  rowTitleText: {
    color: theme.colors.foreground,
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    minWidth: 0,
  },
  sourcePill: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.25,
    overflow: "hidden",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  entryRowCompact: {
    alignItems: "stretch",
    flexDirection: "column",
    gap: theme.spacing[3],
  },
  entryHeaderCompact: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: theme.spacing[3],
    justifyContent: "space-between",
  },
  entryControlsCompact: {
    alignItems: "flex-end",
    flexShrink: 0,
    marginLeft: theme.spacing[2],
    gap: theme.spacing[2],
  },
  rowContentCompact: {
    marginRight: 0,
  },
  iconActionsCompact: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  rowActions: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    justifyContent: "flex-end",
  },
  rowActionsCompact: {
    alignSelf: "stretch",
    justifyContent: "flex-start",
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
    minHeight: 220,
  },
  editorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
