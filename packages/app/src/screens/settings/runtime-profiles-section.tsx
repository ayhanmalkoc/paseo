/* eslint-disable react-perf/jsx-no-jsx-as-prop, react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, Text, View } from "react-native";
import type { PressableStateCallbackType, StyleProp, ViewStyle } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react-native";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { applyFeatureValues } from "@/hooks/feature-preferences";
import { useProviderAuthProfiles } from "@/hooks/use-provider-auth-profiles";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useRuntimeProfiles } from "@/hooks/use-runtime-profiles";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { formatProviderAuthUsageSummary } from "@/utils/provider-auth-usage";
import type {
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderAuthProfile,
  ProviderSnapshotEntry,
  RuntimeProfile,
  RuntimeProfileAccountSelection,
  RuntimeProfileConcurrencyPolicy,
  RuntimeProfilePatch,
  RuntimeProfileSessionBehavior,
} from "@server/server/agent/agent-sdk-types";

interface RuntimeProfileDraft {
  name: string;
  provider: AgentProvider;
  accountSelectionId: string;
  model: string;
  modeId: string;
  thinkingOptionId: string;
  concurrencyPolicy: RuntimeProfileConcurrencyPolicy;
  sessionBehavior: RuntimeProfileSessionBehavior;
  systemPrompt: string;
  instructionOverlay: string;
  featureValues: Record<string, unknown>;
  envOverlayJson: string;
  mcpServersJson: string;
}

interface SelectOption {
  id: string;
  label: string;
  description?: string;
}

const EMPTY_PROVIDER_ENTRIES: ProviderSnapshotEntry[] = [];
const EMPTY_MODELS: AgentModelDefinition[] = [];
const EMPTY_MODES: AgentMode[] = [];
const EMPTY_FEATURES: AgentFeature[] = [];
const PROFILE_EDITOR_SNAP_POINTS = ["72%", "94%"];
const ACCOUNT_SELECTION_PROVIDER_DEFAULT = "__provider-default__";
const ACCOUNT_SELECTION_NATIVE_DEFAULT = "__native-default__";
const CONCURRENCY_OPTIONS: SelectOption[] = [
  { id: "warn", label: "Warn", description: "Ask before reusing this profile in parallel" },
  { id: "allow", label: "Allow", description: "Allow parallel agents with this profile" },
  { id: "single-active", label: "Single active", description: "Prefer one active agent" },
];
const SESSION_BEHAVIOR_OPTIONS: SelectOption[] = [
  {
    id: "continue",
    label: "Continue conversation",
    description: "Resume the same provider session when switching to this profile",
  },
  {
    id: "fresh",
    label: "Start fresh",
    description: "Create a new provider session when switching to this profile",
  },
];
const BOOLEAN_FEATURE_OPTIONS: SelectOption[] = [
  { id: "false", label: "Off" },
  { id: "true", label: "On" },
];

export function RuntimeProfilesSection({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const runtimeProfiles = useRuntimeProfiles(serverId);
  const providersSnapshot = useProvidersSnapshot(serverId);
  const providerEntries = providersSnapshot.entries ?? EMPTY_PROVIDER_ENTRIES;
  const [editingProfile, setEditingProfile] = useState<RuntimeProfile | null>(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerOptions = useMemo(() => buildProviderOptions(providerEntries), [providerEntries]);
  const canCreate = runtimeProfiles.isSupported && providerOptions.length > 0;

  const handleCreate = useCallback(() => {
    setError(null);
    setEditingProfile(null);
    setEditorVisible(true);
  }, []);

  const handleEdit = useCallback((profile: RuntimeProfile) => {
    setError(null);
    setEditingProfile(profile);
    setEditorVisible(true);
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditorVisible(false);
  }, []);

  const handleDelete = useCallback(
    (profile: RuntimeProfile) => {
      void confirmDialog({
        title: "Delete profile",
        message: `Delete ${profile.name}? Existing agents keep their launch snapshot, but this profile can no longer be selected.`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        destructive: true,
      }).then((confirmed) => {
        if (!confirmed) return undefined;
        setError(null);
        void runtimeProfiles.deleteProfile(profile.id).catch((err) => {
          setError(err instanceof Error ? err.message : "Failed to delete profile");
        });
        return undefined;
      });
    },
    [runtimeProfiles],
  );

  const handleSave = useCallback(
    async (
      profileId: string | null,
      patch: RuntimeProfilePatch & { name: string; provider: AgentProvider },
    ) => {
      setError(null);
      if (profileId) {
        await runtimeProfiles.update({ profileId, patch });
      } else {
        await runtimeProfiles.create(patch);
      }
      setEditorVisible(false);
    },
    [runtimeProfiles],
  );

  const trailing = useMemo(
    () => (
      <Button
        variant="ghost"
        size="xs"
        leftIcon={<Plus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />}
        onPress={handleCreate}
        disabled={!canCreate || runtimeProfiles.isRefreshing}
        testID="runtime-profiles-create"
      >
        Add profile
      </Button>
    ),
    [
      canCreate,
      handleCreate,
      runtimeProfiles.isRefreshing,
      theme.colors.foregroundMuted,
      theme.iconSize.sm,
    ],
  );

  if (!runtimeProfiles.isSupported) {
    return null;
  }

  return (
    <SettingsSection title="Profiles" trailing={trailing} testID="host-page-runtime-profiles">
      <View style={settingsStyles.card}>
        {runtimeProfiles.isLoading && runtimeProfiles.profiles.length === 0 ? (
          <View style={styles.emptyRow}>
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            <Text style={styles.mutedText}>Loading profiles...</Text>
          </View>
        ) : null}
        {!runtimeProfiles.isLoading && runtimeProfiles.profiles.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.mutedText}>
              No runtime profiles yet. Create one to save a provider, account, model, and runtime
              preset.
            </Text>
          </View>
        ) : null}
        {runtimeProfiles.profiles.map((profile, index) => (
          <RuntimeProfileRow
            key={profile.id}
            profile={profile}
            showBorder={index > 0}
            providerLabel={resolveProviderLabel(profile.provider, providerEntries)}
            disabled={runtimeProfiles.isRefreshing}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}
      </View>
      {providersSnapshot.error ? (
        <Text style={styles.errorText}>{providersSnapshot.error}</Text>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <RuntimeProfileEditorSheet
        serverId={serverId}
        visible={editorVisible}
        profile={editingProfile}
        providerEntries={providerEntries}
        providerOptions={providerOptions}
        onClose={handleCloseEditor}
        onSave={handleSave}
      />
    </SettingsSection>
  );
}

function RuntimeProfileRow({
  profile,
  showBorder,
  providerLabel,
  disabled,
  onEdit,
  onDelete,
}: {
  profile: RuntimeProfile;
  showBorder: boolean;
  providerLabel: string;
  disabled: boolean;
  onEdit: (profile: RuntimeProfile) => void;
  onDelete: (profile: RuntimeProfile) => void;
}) {
  const { theme } = useUnistyles();
  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );
  const editIcon = useMemo(
    () => <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [theme.colors.foregroundMuted, theme.iconSize.sm],
  );
  const deleteIcon = useMemo(
    () => <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />,
    [theme.colors.destructive, theme.iconSize.sm],
  );
  const destructiveTextStyle = useMemo(
    () => ({ color: theme.colors.destructive }),
    [theme.colors.destructive],
  );
  const handleEdit = useCallback(() => onEdit(profile), [onEdit, profile]);
  const handleDelete = useCallback(() => onDelete(profile), [onDelete, profile]);

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {profile.name}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          {[
            providerLabel,
            formatAccountSelectionSummary(profile),
            profile.model,
            profile.modeId,
            profile.sessionBehavior === "fresh" ? "Start fresh" : "Continue conversation",
          ]
            .filter(Boolean)
            .join(" / ")}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={editIcon}
          onPress={handleEdit}
          disabled={disabled}
          accessibilityLabel={`Edit ${profile.name}`}
        />
        <Button
          variant="ghost"
          size="xs"
          leftIcon={deleteIcon}
          textStyle={destructiveTextStyle}
          onPress={handleDelete}
          disabled={disabled}
          accessibilityLabel={`Delete ${profile.name}`}
        />
      </View>
    </View>
  );
}

function RuntimeProfileEditorSheet({
  serverId,
  visible,
  profile,
  providerEntries,
  providerOptions,
  onClose,
  onSave,
}: {
  serverId: string;
  visible: boolean;
  profile: RuntimeProfile | null;
  providerEntries: ProviderSnapshotEntry[];
  providerOptions: SelectOption[];
  onClose: () => void;
  onSave: (
    profileId: string | null,
    patch: RuntimeProfilePatch & { name: string; provider: AgentProvider },
  ) => Promise<void>;
}) {
  const { theme } = useUnistyles();
  const [draft, setDraft] = useState<RuntimeProfileDraft>(() =>
    createDraft(profile, providerEntries),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authProfiles = useProviderAuthProfiles(serverId, draft.provider);

  useEffect(() => {
    if (visible) {
      setDraft(createDraft(profile, providerEntries));
      setError(null);
      setSaving(false);
    }
  }, [profile, providerEntries, visible]);

  const providerEntry = useMemo(
    () => providerEntries.find((entry) => entry.provider === draft.provider),
    [draft.provider, providerEntries],
  );
  const models = providerEntry?.models ?? EMPTY_MODELS;
  const modes = providerEntry?.modes ?? EMPTY_MODES;
  const selectedModel = models.find((model) => model.id === draft.model);
  const thinkingOptions = selectedModel?.thinkingOptions;
  const draftFeatures = useRuntimeProfileDraftFeatures({
    serverId,
    provider: draft.provider,
    modeId: draft.modeId,
    modelId: draft.model,
    thinkingOptionId: draft.thinkingOptionId,
    featureValues: draft.featureValues,
  });

  const accountOptions = useMemo(
    () => buildAccountOptions(authProfiles.profiles ?? []),
    [authProfiles.profiles],
  );
  const modelOptions = useMemo(() => buildModelOptions(models), [models]);
  const modeOptions = useMemo(() => buildModeOptions(modes), [modes]);
  const thinkingSelectOptions = useMemo(
    () => buildThinkingOptions(thinkingOptions),
    [thinkingOptions],
  );
  const selectedProviderLabel = resolveOptionLabel(providerOptions, draft.provider);

  const setField = useCallback(
    <K extends keyof RuntimeProfileDraft>(key: K, value: RuntimeProfileDraft[K]) => {
      setDraft((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [],
  );

  const handleProviderSelect = useCallback(
    (provider: string) => {
      const nextEntry = providerEntries.find((entry) => entry.provider === provider);
      const defaultModel = findDefaultModel(nextEntry?.models ?? EMPTY_MODELS);
      setDraft((current) => ({
        ...current,
        provider,
        accountSelectionId: ACCOUNT_SELECTION_PROVIDER_DEFAULT,
        model: defaultModel?.id ?? "",
        modeId: nextEntry?.defaultModeId ?? "",
        thinkingOptionId: defaultModel?.defaultThinkingOptionId ?? "",
      }));
    },
    [providerEntries],
  );

  const handleSave = useCallback(() => {
    if (saving) return;
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        const patch = buildPatch(draft);
        await onSave(profile?.id ?? null, patch);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save profile");
      } finally {
        setSaving(false);
      }
    })();
  }, [draft, onSave, profile?.id, saving]);

  const handleSetFeatureValue = useCallback((featureId: string, value: unknown) => {
    setDraft((current) => {
      const nextValues = {
        ...current.featureValues,
        [featureId]: value,
      };
      return {
        ...current,
        featureValues: nextValues,
      };
    });
  }, []);

  const handleClose = useCallback(() => {
    if (saving) return;
    onClose();
  }, [onClose, saving]);

  return (
    <AdaptiveModalSheet
      title={profile ? "Edit profile" : "Add profile"}
      visible={visible}
      onClose={handleClose}
      snapPoints={PROFILE_EDITOR_SNAP_POINTS}
      desktopMaxWidth={620}
      testID="runtime-profile-editor"
    >
      <SettingsSection title="Identity">
        <View style={styles.fieldStack}>
          <LabeledInput
            label="Name"
            value={draft.name}
            onChangeText={(value) => setField("name", value)}
            placeholder="Work account"
            editable={!saving}
          />
          <SelectField
            label="Provider"
            value={selectedProviderLabel}
            options={providerOptions}
            selectedId={draft.provider}
            onSelect={handleProviderSelect}
            disabled={saving || providerOptions.length === 0}
          />
          <SelectField
            label="Account for this profile"
            value={resolveOptionLabel(accountOptions, draft.accountSelectionId)}
            options={accountOptions}
            selectedId={draft.accountSelectionId}
            onSelect={(value) => setField("accountSelectionId", value)}
            disabled={saving || authProfiles.isLoading}
            hint="Provider default follows the provider account setting. Native default bypasses managed accounts."
            showSelectedDescription
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Runtime">
        <View style={styles.fieldStack}>
          <SelectField
            label="Model"
            value={resolveOptionLabel(modelOptions, draft.model)}
            options={modelOptions}
            selectedId={draft.model}
            onSelect={(value) => setField("model", value)}
            disabled={saving || models.length === 0}
          />
          <SelectField
            label="Mode"
            value={resolveOptionLabel(modeOptions, draft.modeId)}
            options={modeOptions}
            selectedId={draft.modeId}
            onSelect={(value) => setField("modeId", value)}
            disabled={saving || modes.length === 0}
          />
          <SelectField
            label="Thinking"
            value={resolveOptionLabel(thinkingSelectOptions, draft.thinkingOptionId)}
            options={thinkingSelectOptions}
            selectedId={draft.thinkingOptionId}
            onSelect={(value) => setField("thinkingOptionId", value)}
            disabled={saving || thinkingSelectOptions.length <= 1}
          />
          <SelectField
            label="Concurrency"
            value={resolveOptionLabel(CONCURRENCY_OPTIONS, draft.concurrencyPolicy)}
            options={CONCURRENCY_OPTIONS}
            selectedId={draft.concurrencyPolicy}
            onSelect={(value) =>
              setField("concurrencyPolicy", value as RuntimeProfileConcurrencyPolicy)
            }
            disabled={saving}
          />
          <SelectField
            label="Session behavior"
            value={resolveOptionLabel(SESSION_BEHAVIOR_OPTIONS, draft.sessionBehavior)}
            options={SESSION_BEHAVIOR_OPTIONS}
            selectedId={draft.sessionBehavior}
            onSelect={(value) =>
              setField("sessionBehavior", value as RuntimeProfileSessionBehavior)
            }
            disabled={saving}
            hint="Applies when switching an existing agent to this profile."
          />
        </View>
      </SettingsSection>

      <RuntimeProfileFeaturesSection
        features={draftFeatures.features}
        isLoading={draftFeatures.isLoading}
        error={draftFeatures.error}
        disabled={saving}
        onSetFeatureValue={handleSetFeatureValue}
      />

      <SettingsSection title="Instructions">
        <View style={styles.fieldStack}>
          <LabeledInput
            label="System prompt"
            value={draft.systemPrompt}
            onChangeText={(value) => setField("systemPrompt", value)}
            placeholder="Optional profile-level system prompt"
            editable={!saving}
            multiline
          />
          <LabeledInput
            label="Instruction overlay"
            value={draft.instructionOverlay}
            onChangeText={(value) => setField("instructionOverlay", value)}
            placeholder="Optional extra instructions"
            editable={!saving}
            multiline
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Advanced">
        <View style={styles.fieldStack}>
          <LabeledInput
            label="Environment JSON"
            value={draft.envOverlayJson}
            onChangeText={(value) => setField("envOverlayJson", value)}
            placeholder='{"NAME": "value"}'
            editable={!saving}
            multiline
            monospace
            hint="Applied to the provider process. CODEX_HOME and PASEO_AGENT_ID are reserved."
          />
          <LabeledInput
            label="MCP servers JSON"
            value={draft.mcpServersJson}
            onChangeText={(value) => setField("mcpServersJson", value)}
            placeholder='{"server": {"type": "stdio", "command": "tool"}}'
            editable={!saving}
            multiline
            monospace
            hint="Canonical MCP server map. Supports stdio, http, and sse entries."
          />
        </View>
      </SettingsSection>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.editorActions}>
        <Button
          variant="secondary"
          size="sm"
          style={FLEX_STYLE}
          onPress={handleClose}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          style={FLEX_STYLE}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </View>
      {providerOptions.length === 0 ? (
        <Text style={[styles.mutedText, { color: theme.colors.destructive }]}>
          No providers are available on this host yet.
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function LabeledInput({
  label,
  value,
  onChangeText,
  placeholder,
  editable,
  multiline,
  monospace,
  hint,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  editable: boolean;
  multiline?: boolean;
  monospace?: boolean;
  hint?: string;
}) {
  const { theme } = useUnistyles();
  const inputStyle = useMemo(
    () => [
      styles.input,
      multiline && styles.multilineInput,
      monospace && styles.monoInput,
      !editable && styles.disabled,
    ],
    [editable, monospace, multiline],
  );
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <AdaptiveTextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
        multiline={multiline}
        style={inputStyle}
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

function SelectField({
  label,
  value,
  options,
  selectedId,
  onSelect,
  disabled,
  hint,
  showSelectedDescription = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  disabled: boolean;
  hint?: string;
  showSelectedDescription?: boolean;
}) {
  const { theme } = useUnistyles();
  const selectedDescription = showSelectedDescription
    ? options.find((option) => option.id === selectedId)?.description
    : null;
  const triggerStyle = useCallback(
    ({
      pressed,
      hovered,
    }: PressableStateCallbackType & { hovered?: boolean }): StyleProp<ViewStyle> => [
      styles.selectTrigger,
      (pressed || hovered) && styles.selectTriggerActive,
      disabled && styles.disabled,
    ],
    [disabled],
  );

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`Select ${label}`}
        >
          <Text style={styles.selectText} numberOfLines={1}>
            {value}
          </Text>
          <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start">
          {options.map((option) => (
            <DropdownMenuItem
              key={option.id}
              selected={option.id === selectedId}
              description={option.description}
              onSelect={() => onSelect(option.id)}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selectedDescription ? (
        <Text style={styles.selectedDescription}>{selectedDescription}</Text>
      ) : null}
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

function FeatureValueField({
  feature,
  disabled,
  onSetFeatureValue,
}: {
  feature: AgentFeature;
  disabled: boolean;
  onSetFeatureValue: (featureId: string, value: unknown) => void;
}) {
  const handleToggleSelect = useCallback(
    (id: string) => {
      onSetFeatureValue(feature.id, id === "true");
    },
    [feature.id, onSetFeatureValue],
  );
  const handleSelectValue = useCallback(
    (id: string) => {
      onSetFeatureValue(feature.id, id || null);
    },
    [feature.id, onSetFeatureValue],
  );

  if (feature.type === "toggle") {
    return (
      <SelectField
        label={feature.label}
        value={feature.value ? "On" : "Off"}
        options={BOOLEAN_FEATURE_OPTIONS}
        selectedId={feature.value ? "true" : "false"}
        onSelect={handleToggleSelect}
        disabled={disabled}
      />
    );
  }

  const selectedId = feature.value ?? "";
  const selectedLabel =
    feature.options.find((option) => option.id === selectedId)?.label ?? "Default";
  return (
    <SelectField
      label={feature.label}
      value={selectedLabel}
      options={[{ id: "", label: "Default" }, ...feature.options]}
      selectedId={selectedId}
      onSelect={handleSelectValue}
      disabled={disabled}
    />
  );
}

function RuntimeProfileFeaturesSection({
  features,
  isLoading,
  error,
  disabled,
  onSetFeatureValue,
}: {
  features: AgentFeature[];
  isLoading: boolean;
  error: string | null;
  disabled: boolean;
  onSetFeatureValue: (featureId: string, value: unknown) => void;
}) {
  const { theme } = useUnistyles();
  return (
    <SettingsSection title="Features">
      <View style={styles.fieldStack}>
        {isLoading ? (
          <View style={styles.inlineStatus}>
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            <Text style={styles.mutedText}>Loading features...</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {!isLoading && features.length === 0 ? (
          <Text style={styles.mutedText}>No provider features are available.</Text>
        ) : null}
        {features.map((feature) => (
          <FeatureValueField
            key={feature.id}
            feature={feature}
            disabled={disabled}
            onSetFeatureValue={onSetFeatureValue}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function useRuntimeProfileDraftFeatures(input: {
  serverId: string;
  provider: AgentProvider;
  modeId: string;
  modelId: string;
  thinkingOptionId: string;
  featureValues: Record<string, unknown>;
}) {
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const draftConfig = useMemo(() => {
    const provider = input.provider.trim();
    if (!provider) {
      return null;
    }
    return {
      provider,
      cwd: ".",
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.modelId ? { model: input.modelId } : {}),
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    };
  }, [input.modeId, input.modelId, input.provider, input.thinkingOptionId]);

  const featuresQuery = useQuery({
    queryKey: [
      "runtimeProfileDraftFeatures",
      input.serverId,
      draftConfig?.provider ?? null,
      draftConfig?.cwd ?? null,
      draftConfig?.modeId ?? null,
      draftConfig?.model ?? null,
      draftConfig?.thinkingOptionId ?? null,
    ],
    enabled: Boolean(client && isConnected && draftConfig),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!client || !draftConfig) {
        throw new Error("Host is not connected");
      }
      const payload = await client.listProviderFeatures(draftConfig);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.features ?? EMPTY_FEATURES;
    },
  });

  const baseFeatures = featuresQuery.data ?? EMPTY_FEATURES;
  const features = useMemo(
    () => applyFeatureValues(baseFeatures, input.featureValues),
    [baseFeatures, input.featureValues],
  );

  return {
    features,
    isLoading: featuresQuery.isLoading,
    error: featuresQuery.error instanceof Error ? featuresQuery.error.message : null,
  };
}

function buildProviderOptions(entries: ProviderSnapshotEntry[]): SelectOption[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      id: entry.provider,
      label: entry.label ?? entry.provider,
      description: entry.status === "ready" ? entry.description : entry.status,
    }));
}

function buildAccountOptions(accounts: ProviderAuthProfile[]): SelectOption[] {
  return [
    {
      id: ACCOUNT_SELECTION_PROVIDER_DEFAULT,
      label: "Provider default",
      description: "Use the provider account selected as default",
    },
    {
      id: ACCOUNT_SELECTION_NATIVE_DEFAULT,
      label: "Native default",
      description: "Use the provider's native account outside managed accounts",
    },
    ...accounts.map((account) => ({
      id: account.key,
      label: account.alias || account.email || account.accountName || account.key,
      description: [
        formatProviderAuthUsageSummary(account.usage),
        account.email,
        account.plan,
        account.status !== "ready" ? account.status : null,
      ]
        .filter(Boolean)
        .join(" / "),
    })),
  ];
}

function buildModelOptions(models: AgentModelDefinition[]): SelectOption[] {
  return [
    { id: "", label: "Provider default" },
    ...models.map((model) => ({
      id: model.id,
      label: model.label,
      description: model.id,
    })),
  ];
}

function buildModeOptions(modes: AgentMode[]): SelectOption[] {
  return [
    { id: "", label: "Provider default" },
    ...modes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
    })),
  ];
}

function buildThinkingOptions(options: AgentModelDefinition["thinkingOptions"]): SelectOption[] {
  return [
    { id: "", label: "Model default" },
    ...(options ?? []).map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
    })),
  ];
}

function resolveOptionLabel(options: SelectOption[], selectedId: string): string {
  return options.find((option) => option.id === selectedId)?.label ?? "Unavailable";
}

// eslint-disable-next-line complexity
function createDraft(
  profile: RuntimeProfile | null,
  providerEntries: ProviderSnapshotEntry[],
): RuntimeProfileDraft {
  const defaultProvider =
    profile?.provider ?? providerEntries.find((entry) => entry.enabled)?.provider ?? "";
  const providerEntry = providerEntries.find((entry) => entry.provider === defaultProvider);
  const defaultModel = findDefaultModel(providerEntry?.models ?? EMPTY_MODELS);
  return {
    name: profile?.name ?? (providerEntry?.label ? `${providerEntry.label} profile` : ""),
    provider: defaultProvider,
    accountSelectionId: getAccountSelectionId(profile),
    model: profile?.model ?? defaultModel?.id ?? "",
    modeId: profile?.modeId ?? providerEntry?.defaultModeId ?? "",
    thinkingOptionId: profile?.thinkingOptionId ?? defaultModel?.defaultThinkingOptionId ?? "",
    concurrencyPolicy: profile?.concurrencyPolicy ?? "warn",
    sessionBehavior: profile?.sessionBehavior ?? "continue",
    systemPrompt: profile?.systemPrompt ?? "",
    instructionOverlay: profile?.instructionOverlay ?? "",
    featureValues: profile?.featureValues ?? {},
    envOverlayJson: formatJson(profile?.envOverlay),
    mcpServersJson: formatJson(profile?.mcpServers),
  };
}

function findDefaultModel(models: AgentModelDefinition[]): AgentModelDefinition | undefined {
  return models.find((model) => model.isDefault) ?? models[0];
}

function formatAccountSelectionSummary(profile: RuntimeProfile): string {
  const selection = profile.accountSelection;
  if (selection?.kind === "inherit-provider-default") {
    return "Provider default account";
  }
  if (selection?.kind === "native-default") {
    return "Native default account";
  }
  if (selection?.kind === "managed-account") {
    return (
      selection.providerHomeRef.label ?? selection.providerHomeRef.profileKey ?? "Managed account"
    );
  }
  if (profile.providerHomeRef?.kind === "native-default") {
    return "Native default account";
  }
  return profile.accountKey ?? "";
}

function getAccountSelectionId(profile: RuntimeProfile | null): string {
  const selection = profile?.accountSelection;
  if (selection?.kind === "inherit-provider-default") {
    return ACCOUNT_SELECTION_PROVIDER_DEFAULT;
  }
  if (selection?.kind === "native-default") {
    return ACCOUNT_SELECTION_NATIVE_DEFAULT;
  }
  if (selection?.kind === "managed-account") {
    return selection.providerHomeRef.kind === "managed-profile"
      ? (selection.providerHomeRef.profileKey ?? "")
      : ACCOUNT_SELECTION_NATIVE_DEFAULT;
  }
  if (profile?.providerHomeRef?.kind === "native-default") {
    return ACCOUNT_SELECTION_NATIVE_DEFAULT;
  }
  if (profile?.providerHomeRef?.kind === "managed-profile") {
    return profile.providerHomeRef.profileKey ?? "";
  }
  if (profile?.accountKey) {
    return profile.accountKey;
  }
  return profile ? ACCOUNT_SELECTION_NATIVE_DEFAULT : ACCOUNT_SELECTION_PROVIDER_DEFAULT;
}

function buildAccountSelection(
  accountSelectionId: string,
  provider: AgentProvider,
): RuntimeProfileAccountSelection {
  if (accountSelectionId === ACCOUNT_SELECTION_NATIVE_DEFAULT) {
    return { kind: "native-default" };
  }
  if (accountSelectionId && accountSelectionId !== ACCOUNT_SELECTION_PROVIDER_DEFAULT) {
    return {
      kind: "managed-account",
      providerHomeRef: {
        kind: "managed-profile",
        provider,
        profileKey: accountSelectionId,
      },
    };
  }
  return { kind: "inherit-provider-default" };
}

function buildCompatProviderHomeRef(
  accountSelectionId: string,
  provider: AgentProvider,
): RuntimeProfile["providerHomeRef"] {
  const selection = buildAccountSelection(accountSelectionId, provider);
  if (selection.kind === "native-default") {
    return { kind: "native-default", provider };
  }
  if (selection.kind === "managed-account") {
    return selection.providerHomeRef;
  }
  return null;
}

function buildCompatAccountKey(accountSelectionId: string): string | null {
  return accountSelectionId &&
    accountSelectionId !== ACCOUNT_SELECTION_PROVIDER_DEFAULT &&
    accountSelectionId !== ACCOUNT_SELECTION_NATIVE_DEFAULT
    ? accountSelectionId
    : null;
}

function buildPatch(
  draft: RuntimeProfileDraft,
): RuntimeProfilePatch & { name: string; provider: AgentProvider } {
  const name = draft.name.trim();
  const provider = draft.provider.trim();
  if (!name) {
    throw new Error("Profile name is required");
  }
  if (!provider) {
    throw new Error("Provider is required");
  }
  return {
    name,
    provider,
    accountSelection: buildAccountSelection(draft.accountSelectionId, provider),
    providerHomeRef: buildCompatProviderHomeRef(draft.accountSelectionId, provider),
    accountKey: buildCompatAccountKey(draft.accountSelectionId),
    model: normalizeNullableText(draft.model),
    modeId: normalizeNullableText(draft.modeId),
    thinkingOptionId: normalizeNullableText(draft.thinkingOptionId),
    concurrencyPolicy: draft.concurrencyPolicy,
    sessionBehavior: draft.sessionBehavior,
    systemPrompt: normalizeNullableText(draft.systemPrompt),
    instructionOverlay: normalizeNullableText(draft.instructionOverlay),
    featureValues: draft.featureValues,
    envOverlay: parseStringObjectJson("Environment JSON", draft.envOverlayJson),
    mcpServers: parseMcpServersJson(draft.mcpServersJson),
  };
}

function normalizeNullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseObjectJson(label: string, value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseStringObjectJson(label: string, value: string): Record<string, string> {
  const parsed = parseObjectJson(label, value);
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string") {
      throw new Error(`${label} value for ${key} must be a string`);
    }
  }
  return parsed as Record<string, string>;
}

function parseMcpServersJson(value: string): NonNullable<RuntimeProfile["mcpServers"]> {
  return parseObjectJson("MCP servers JSON", value) as NonNullable<RuntimeProfile["mcpServers"]>;
}

function formatJson(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    return "";
  }
  if (Object.keys(value).length === 0) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

const styles = StyleSheet.create((theme) => ({
  emptyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[2],
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  fieldStack: {
    gap: theme.spacing[3],
  },
  inlineStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  field: {
    gap: theme.spacing[1],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  fieldHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  input: {
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  multilineInput: {
    minHeight: 92,
    textAlignVertical: "top",
  },
  monoInput: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
  },
  selectTrigger: {
    minHeight: 42,
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  selectTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  selectText: {
    color: theme.colors.foreground,
    flex: 1,
    fontSize: theme.fontSize.sm,
  },
  selectedDescription: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.35,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  editorActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));

const FLEX_STYLE = { flex: 1 };
