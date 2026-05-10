import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import {
  View,
  Text,
  Pressable,
  Keyboard,
  ActivityIndicator,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  Brain,
  ChevronDown,
  ListTodo,
  Pencil,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  User,
  Zap,
} from "lucide-react-native";
import { router } from "expo-router";
import { getProviderIcon } from "@/components/provider-icons";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { useSessionStore } from "@/stores/session-store";
import { useProviderAuthProfiles } from "@/hooks/use-provider-auth-profiles";
import { useRuntimeProfiles } from "@/hooks/use-runtime-profiles";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveProviderDefinition } from "@/utils/provider-definitions";
import {
  buildFavoriteModelKey,
  mergeProviderPreferences,
  toggleFavoriteModel,
  useFormPreferences,
} from "@/hooks/use-form-preferences";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type {
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentProfileSnapshot,
  AgentProvider,
  ProviderAuthProfile,
  RuntimeLaunchWarning,
  RuntimeProfile,
} from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import { getModeVisuals, type AgentModeColorTier } from "@server/server/agent/provider-manifest";
import {
  getFeatureHighlightColor,
  getFeatureTooltip,
  resolveAgentStatusBarSurface,
  resolveAgentModelSelection,
  shouldSplitAgentStatusBarControls,
} from "@/components/agent-status-bar.utils";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb as platformIsWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { buildSettingsHostRoute } from "@/utils/host-routes";

interface StatusOption {
  id: string;
  label: string;
}

interface PendingAuthProfileRestart {
  key: string | null;
  label: string;
}

interface PendingRuntimeProfileRestart {
  id: string | null;
  label: string;
  warnings?: RuntimeLaunchWarning[];
}

interface AuthProfileRestartClient {
  restartAgentWithAuthProfile(agentId: string, authProfileKey: string | null): Promise<void>;
}

interface RuntimeProfileRestartClient {
  restartAgentWithRuntimeProfile(
    agentId: string,
    runtimeProfileId: string | null,
    profileOverrides?: unknown,
    options?: { acceptRuntimeWarnings?: boolean },
  ): Promise<unknown>;
}

type RuntimeProfileRestartPhase = "idle" | "restarting" | "waiting" | "failed";

interface RuntimeProfileRestartProgress {
  phase: RuntimeProfileRestartPhase;
  label: string;
  error?: string;
}

type StatusSelector =
  | "provider"
  | "mode"
  | "model"
  | "thinking"
  | "auth-profile"
  | "runtime-profile"
  | `feature-${string}`;

interface ControlledAgentStatusBarProps {
  provider: string;
  providerOptions?: StatusOption[];
  selectedProviderId?: string;
  onSelectProvider?: (providerId: string) => void;
  modeOptions?: StatusOption[];
  selectedModeId?: string;
  onSelectMode?: (modeId: string) => void;
  modelOptions?: StatusOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  authProfiles?: ProviderAuthProfile[];
  selectedAuthProfileKey?: string;
  onSelectAuthProfile?: (authProfileKey: string) => void;
  isAuthProfilesLoading?: boolean;
  runtimeProfiles?: RuntimeProfile[];
  selectedRuntimeProfileId?: string;
  selectedRuntimeProfileVersion?: number;
  onSelectRuntimeProfile?: (runtimeProfileId: string) => void;
  isRuntimeProfilesLoading?: boolean;
  allowAdHocRuntimeProfile?: boolean;
  thinkingOptions?: StatusOption[];
  selectedThinkingOptionId?: string;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  disabled?: boolean;
  isModelLoading?: boolean;
  providerDefinitions: AgentProviderDefinition[];
  allProviderModels?: Map<string, AgentModelDefinition[]>;
  canSelectModelProvider?: (providerId: string) => boolean;
  favoriteKeys?: Set<string>;
  onToggleFavoriteModel?: (provider: string, modelId: string) => void;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onEditRuntimeProfiles?: () => void;
}

export interface DraftAgentStatusBarProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider | null;
  onSelectProvider: (provider: AgentProvider) => void;
  modeOptions: AgentMode[];
  selectedMode: string;
  onSelectMode: (modeId: string) => void;
  models: AgentModelDefinition[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  authProfiles?: ProviderAuthProfile[];
  selectedAuthProfileKey?: string;
  onSelectAuthProfile?: (authProfileKey: string) => void;
  isAuthProfilesLoading?: boolean;
  runtimeProfiles?: RuntimeProfile[];
  selectedRuntimeProfileId?: string;
  onSelectRuntimeProfile?: (runtimeProfileId: string) => void;
  isRuntimeProfilesLoading?: boolean;
  allowAdHocRuntimeProfile?: boolean;
  isModelLoading: boolean;
  allProviderModels: Map<string, AgentModelDefinition[]>;
  isAllModelsLoading: boolean;
  onSelectProviderAndModel: (provider: AgentProvider, modelId: string) => void;
  thinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  selectedThinkingOptionId: string;
  onSelectThinkingOption: (thinkingOptionId: string) => void;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onEditRuntimeProfiles?: () => void;
  disabled?: boolean;
}

interface AgentStatusBarProps {
  agentId: string;
  serverId: string;
  onDropdownClose?: () => void;
}

function findOptionLabel(
  options: StatusOption[] | undefined,
  selectedId: string | undefined,
  fallback: string,
) {
  if (!options || options.length === 0) {
    return fallback;
  }
  const selected = options.find((option) => option.id === selectedId);
  return selected?.label ?? fallback;
}

const FEATURE_ICONS: Record<string, typeof Zap> = {
  "list-todo": ListTodo,
  zap: Zap,
};

function getFeatureIcon(icon?: string) {
  return (icon && FEATURE_ICONS[icon]) || Settings2;
}

function getFeatureIconColor(
  featureId: string,
  enabled: boolean,
  palette: {
    blue: { 400: string };
    yellow: { 400: string };
  },
  foregroundMuted: string,
): string {
  if (!enabled) {
    return foregroundMuted;
  }

  switch (getFeatureHighlightColor(featureId)) {
    case "blue":
      return palette.blue[400];
    case "yellow":
      return palette.yellow[400];
    default:
      return foregroundMuted;
  }
}

const MODE_ICONS = {
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
} as const;

const EMPTY_AUTH_PROFILES: ProviderAuthProfile[] = [];
const EMPTY_RUNTIME_PROFILES: RuntimeProfile[] = [];
const CUSTOM_SETTINGS_LABEL = "Custom settings";

function alwaysTrue() {
  return true;
}

function resolveHasAnyControl({
  providerOptions,
  modeOptions,
  canSelectModel,
  hasAuthProfileControl,
  hasRuntimeProfileControl,
  thinkingOptions,
  features,
}: {
  providerOptions: StatusOption[] | undefined;
  modeOptions: StatusOption[] | undefined;
  canSelectModel: boolean;
  hasAuthProfileControl: boolean;
  hasRuntimeProfileControl: boolean;
  thinkingOptions: StatusOption[] | undefined;
  features: AgentFeature[] | undefined;
}) {
  return (
    Boolean(providerOptions?.length) ||
    Boolean(modeOptions?.length) ||
    canSelectModel ||
    hasAuthProfileControl ||
    hasRuntimeProfileControl ||
    Boolean(thinkingOptions?.length) ||
    Boolean(features?.length)
  );
}

function toComboboxOptions(options: StatusOption[] | undefined): ComboboxOption[] {
  return (options ?? []).map((o) => ({ id: o.id, label: o.label }));
}

function formatAuthProfileLabel(profile: ProviderAuthProfile): string {
  return (
    profile.email ||
    profile.accountName ||
    profile.alias ||
    (profile.authMode === "api-key" ? "Codex API key" : "Codex account")
  );
}

function normalizeAuthProfileSelection(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRuntimeProfileSelection(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveAuthProfileRestartLabel(
  authProfiles: ProviderAuthProfile[],
  authProfileKey: string | null,
): string {
  if (!authProfileKey) {
    return "Default account";
  }
  const profile = authProfiles.find((candidate) => candidate.key === authProfileKey);
  return profile ? formatAuthProfileLabel(profile) : "Selected account";
}

function resolveRuntimeProfileRestartLabel(
  runtimeProfiles: RuntimeProfile[],
  runtimeProfileId: string | null,
): string {
  if (!runtimeProfileId) {
    return CUSTOM_SETTINGS_LABEL;
  }
  const profile = runtimeProfiles.find((candidate) => candidate.id === runtimeProfileId);
  return profile?.name ?? "Selected profile";
}

function resolveDisplayAuthProfile(input: {
  authProfiles: ProviderAuthProfile[];
  selectedAuthProfileKey: string | undefined;
  isLoading: boolean;
}): string {
  if (input.isLoading && input.authProfiles.length === 0) {
    return "Loading accounts...";
  }
  if (!input.selectedAuthProfileKey) {
    const defaultProfile = input.authProfiles.find((profile) => profile.isDefault);
    return defaultProfile ? formatAuthProfileLabel(defaultProfile) : "Default account";
  }
  const selected = input.authProfiles.find(
    (profile) => profile.key === input.selectedAuthProfileKey,
  );
  return selected ? formatAuthProfileLabel(selected) : "Default account";
}

function resolveAuthProfileControlState(input: {
  authProfiles: ProviderAuthProfile[];
  selectedAuthProfileKey: string | undefined;
  isLoading: boolean;
  onSelectAuthProfile?: (authProfileKey: string) => void;
}) {
  return {
    hasControl: input.isLoading || input.authProfiles.length > 0,
    canSelect: Boolean(input.onSelectAuthProfile && input.authProfiles.length > 0),
    display: resolveDisplayAuthProfile({
      authProfiles: input.authProfiles,
      selectedAuthProfileKey: input.selectedAuthProfileKey,
      isLoading: input.isLoading,
    }),
  };
}

function resolveRuntimeProfileControlState(input: {
  runtimeProfiles: RuntimeProfile[];
  selectedRuntimeProfileId: string | undefined;
  isLoading: boolean;
  onSelectRuntimeProfile?: (runtimeProfileId: string) => void;
  allowAdHoc: boolean;
}) {
  const selected = input.runtimeProfiles.find(
    (profile) => profile.id === input.selectedRuntimeProfileId,
  );
  let display = CUSTOM_SETTINGS_LABEL;
  if (input.isLoading) {
    display = "Loading profiles...";
  } else if (selected) {
    display = selected.name;
  } else if (input.allowAdHoc) {
    display = CUSTOM_SETTINGS_LABEL;
  }
  return {
    hasControl:
      input.isLoading ||
      input.runtimeProfiles.length > 0 ||
      Boolean(input.selectedRuntimeProfileId),
    canSelect: Boolean(
      input.onSelectRuntimeProfile && (input.allowAdHoc || input.runtimeProfiles.length > 0),
    ),
    display,
  };
}

function findRuntimeProfile(
  runtimeProfiles: RuntimeProfile[],
  selectedRuntimeProfileId: string | undefined,
): RuntimeProfile | null {
  if (!selectedRuntimeProfileId) {
    return null;
  }
  return runtimeProfiles.find((profile) => profile.id === selectedRuntimeProfileId) ?? null;
}

function resolveProviderLabelFromDefinitions(
  provider: string,
  providerDefinitions: AgentProviderDefinition[],
): string {
  return providerDefinitions.find((definition) => definition.id === provider)?.label ?? provider;
}

function resolveAuthProfileDisplayByKey(
  authProfiles: ProviderAuthProfile[],
  accountKey: string | null | undefined,
): string {
  if (!accountKey) {
    return "Default account";
  }
  const profile = authProfiles.find((candidate) => candidate.key === accountKey);
  return profile ? formatAuthProfileLabel(profile) : accountKey;
}

function formatRuntimeProfileValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "Not set";
  }
  if (typeof value === "boolean") {
    return value ? "On" : "Off";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}

function getRuntimeLaunchWarnings(error: unknown): RuntimeLaunchWarning[] | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const warnings = (error as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return null;
  }
  return warnings.filter((warning): warning is RuntimeLaunchWarning => {
    return (
      warning !== null &&
      typeof warning === "object" &&
      typeof (warning as RuntimeLaunchWarning).message === "string"
    );
  });
}

function resolveHasPreferencesControl(input: {
  hasRuntimeProfileControl: boolean;
  hasAuthProfileControl: boolean;
  canSelectThinking: boolean;
  canSelectMode: boolean;
  features?: AgentFeature[];
}) {
  return Boolean(
    input.hasRuntimeProfileControl ||
    input.hasAuthProfileControl ||
    input.canSelectThinking ||
    input.canSelectMode ||
    input.features?.length,
  );
}

function resolveAgentStatusBarDisabled(input: {
  client: unknown;
  isAuthProfileRestarting: boolean;
  isRuntimeProfileRestarting: boolean;
}) {
  return !input.client || input.isAuthProfileRestarting || input.isRuntimeProfileRestarting;
}

function resolveStatusSelectability(input: {
  onSelectProvider?: (providerId: string) => void;
  providerOptions?: StatusOption[];
  onSelectMode?: (modeId: string) => void;
  modeOptions?: StatusOption[];
  onSelectModel?: (modelId: string) => void;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  thinkingOptions?: StatusOption[];
}) {
  return {
    provider: Boolean(
      input.onSelectProvider && input.providerOptions && input.providerOptions.length > 0,
    ),
    mode: Boolean(input.onSelectMode && input.modeOptions && input.modeOptions.length > 0),
    model: Boolean(input.onSelectModel),
    thinking: Boolean(
      input.onSelectThinkingOption && input.thinkingOptions && input.thinkingOptions.length > 0,
    ),
  };
}

function buildFallbackAllProviderModels(
  provider: string,
  modelOptions: StatusOption[] | undefined,
): Map<string, AgentModelDefinition[]> {
  const map = new Map<string, AgentModelDefinition[]>();
  if (!modelOptions || modelOptions.length === 0) {
    return map;
  }
  map.set(
    provider,
    modelOptions.map((option) => ({
      provider: provider,
      id: option.id,
      label: option.label,
    })),
  );
  return map;
}

function makeBadgePressableStyle(
  baseStyle: StyleProp<ViewStyle>,
  disabledStyle: StyleProp<ViewStyle>,
  disabled: boolean,
  isOpen: boolean,
) {
  return ({ pressed, hovered }: PressableStateCallbackType) => [
    baseStyle,
    hovered && styles.modeBadgeHovered,
    (pressed || isOpen) && styles.modeBadgePressed,
    disabled && disabledStyle,
  ];
}

function makeSheetPressableStyle(isDisabled: boolean) {
  return ({ pressed }: PressableStateCallbackType) => [
    styles.sheetSelect,
    pressed && styles.sheetSelectPressed,
    isDisabled && styles.disabledSheetSelect,
  ];
}

function makePrefsButtonStyle({ pressed }: PressableStateCallbackType) {
  return [styles.prefsButton, pressed && styles.prefsButtonPressed];
}

function makeProfileEditButtonStyle({ pressed }: PressableStateCallbackType) {
  return [styles.profileEditButton, pressed && styles.prefsButtonPressed];
}

function makeProfileApplyButtonStyle({ pressed }: PressableStateCallbackType) {
  return [styles.profileApplyButton, pressed && styles.restartConfirmPrimaryButtonPressed];
}

function pickSheetModel({
  nextProviderId,
  modelId,
  currentProvider,
  onSelectProviderAndModel,
  onSelectProvider,
  onSelectModel,
}: {
  nextProviderId: string;
  modelId: string;
  currentProvider: string;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  onSelectProvider?: (providerId: string) => void;
  onSelectModel?: (modelId: string) => void;
}) {
  if (onSelectProviderAndModel) {
    onSelectProviderAndModel(nextProviderId, modelId);
    return;
  }
  if (nextProviderId !== currentProvider) {
    onSelectProvider?.(nextProviderId);
  }
  onSelectModel?.(modelId);
}

function resolveModeVisualsForProvider(
  provider: string,
  selectedModeId: string | undefined,
  providerDefinitions: AgentProviderDefinition[],
  palette: Parameters<typeof getModeIconColor>[1],
) {
  const modeVisuals = selectedModeId
    ? getModeVisuals(provider, selectedModeId, providerDefinitions)
    : undefined;
  const icon = modeVisuals?.icon ? MODE_ICONS[modeVisuals.icon] : null;
  const color = getModeIconColor(modeVisuals?.colorTier, palette);
  return { icon, color };
}

function resolveProviderIcon(provider: string) {
  if (provider.trim().length === 0) {
    return null;
  }
  return getProviderIcon(provider);
}

type AgentStatusBarSlice = {
  provider: AgentProvider;
  cwd: string | null;
  currentModeId: string | null | undefined;
  runtimeModelId: string | null;
  model: string | null | undefined;
  authProfileKey: string | null | undefined;
  profileSnapshot: AgentProfileSnapshot | undefined;
  features: AgentFeature[] | undefined;
  thinkingOptionId: string | null | undefined;
  lastUsage: unknown;
} | null;

function selectAgentStatusBarSlice(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string,
): AgentStatusBarSlice {
  const currentAgent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
  if (!currentAgent) {
    return null;
  }
  return {
    provider: currentAgent.provider,
    cwd: currentAgent.cwd,
    currentModeId: currentAgent.currentModeId,
    runtimeModelId: currentAgent.runtimeInfo?.model ?? null,
    model: currentAgent.model,
    authProfileKey: currentAgent.authProfileKey,
    profileSnapshot: currentAgent.profileSnapshot,
    features: currentAgent.features,
    thinkingOptionId: currentAgent.thinkingOptionId,
    lastUsage: currentAgent.lastUsage,
  };
}

function resolveSnapshotSelectedEntry(
  snapshotEntries: ReturnType<typeof useProvidersSnapshot>["entries"],
  agentProvider: string | undefined,
) {
  if (!snapshotEntries || !agentProvider) {
    return null;
  }
  return snapshotEntries.find((e) => e.provider === agentProvider) ?? null;
}

function useAgentStatusBarAuthProfileState(serverId: string, agent: AgentStatusBarSlice) {
  const providerAuthProfiles = useProviderAuthProfiles(serverId, agent?.provider);

  return {
    authProfiles: providerAuthProfiles.profiles ?? EMPTY_AUTH_PROFILES,
    selectedAuthProfileKey: agent?.authProfileKey ?? undefined,
    isAuthProfilesLoading: providerAuthProfiles.isLoading,
  };
}

function useAgentStatusBarRuntimeProfileState(serverId: string, agent: AgentStatusBarSlice) {
  const runtimeProfiles = useRuntimeProfiles(serverId, agent?.provider);

  return {
    runtimeProfiles: runtimeProfiles.profiles ?? EMPTY_RUNTIME_PROFILES,
    selectedRuntimeProfileId: agent?.profileSnapshot?.sourceProfileId ?? undefined,
    selectedRuntimeProfileVersion: agent?.profileSnapshot?.sourceProfileVersion,
    isRuntimeProfilesLoading: runtimeProfiles.isLoading,
  };
}

function buildAgentProviderDefinitions(
  agentProvider: string | undefined,
  snapshotEntries: ReturnType<typeof useProvidersSnapshot>["entries"],
): AgentProviderDefinition[] {
  const definition = agentProvider
    ? resolveProviderDefinition(agentProvider, snapshotEntries)
    : undefined;
  return definition ? [definition] : [];
}

function buildAgentProviderModels(
  agentProvider: string | undefined,
  models: AgentModelDefinition[] | null,
): Map<string, AgentModelDefinition[]> {
  const map = new Map<string, AgentModelDefinition[]>();
  if (agentProvider && models) {
    map.set(agentProvider, models);
  }
  return map;
}

function compareAvailableModes(a: AgentMode[], b: AgentMode[]): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function resolveAgentDisplayMode(
  availableModes: AgentMode[],
  currentModeId: string | null | undefined,
): string {
  const found = availableModes.find((mode) => mode.id === currentModeId);
  return found?.label || currentModeId || "default";
}

function buildOpenChangeHandler(
  selector: StatusSelector,
  setOpenSelector: (next: StatusSelector | null) => void,
  onDropdownClose?: () => void,
) {
  return (nextOpen: boolean) => {
    setOpenSelector(nextOpen ? selector : null);
    if (!nextOpen) {
      onDropdownClose?.();
    }
  };
}

function SheetModelTriggerView({
  selectedModelLabel,
  style,
  ProviderIcon,
}: {
  selectedModelLabel: string;
  style: StyleProp<ViewStyle>;
  ProviderIcon: ReturnType<typeof getProviderIcon> | null;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={style} pointerEvents="none" testID="agent-preferences-model">
      {ProviderIcon ? (
        <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      ) : null}
      <Text style={styles.sheetSelectText}>{selectedModelLabel}</Text>
      <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
    </View>
  );
}

function SheetPreferencesTriggerContent({
  displayRuntimeProfile,
}: {
  displayRuntimeProfile: string;
}) {
  const { theme } = useUnistyles();

  return (
    <>
      <Settings2 size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      <Text style={styles.prefsButtonText} numberOfLines={1}>
        {displayRuntimeProfile || CUSTOM_SETTINGS_LABEL}
      </Text>
      <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
    </>
  );
}

function getModeIconColor(
  colorTier: AgentModeColorTier | undefined,
  palette: {
    blue: { 500: string };
    green: { 500: string };
    red: { 500: string };
    purple: { 500: string };
  },
): string {
  switch (colorTier) {
    case "safe":
      return palette.green[500];
    case "moderate":
      return palette.blue[500];
    case "dangerous":
      return palette.red[500];
    case "planning":
      return palette.purple[500];
    default:
      return palette.blue[500];
  }
}

function ControlledStatusBar({
  provider,
  providerOptions,
  selectedProviderId,
  onSelectProvider,
  modeOptions,
  selectedModeId,
  onSelectMode,
  modelOptions,
  selectedModelId,
  onSelectModel,
  onSelectProviderAndModel,
  authProfiles = EMPTY_AUTH_PROFILES,
  selectedAuthProfileKey,
  onSelectAuthProfile,
  isAuthProfilesLoading = false,
  runtimeProfiles = EMPTY_RUNTIME_PROFILES,
  selectedRuntimeProfileId,
  selectedRuntimeProfileVersion,
  onSelectRuntimeProfile,
  isRuntimeProfilesLoading = false,
  allowAdHocRuntimeProfile = true,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  disabled = false,
  isModelLoading = false,
  providerDefinitions,
  allProviderModels,
  canSelectModelProvider,
  favoriteKeys = new Set<string>(),
  onToggleFavoriteModel,
  features,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
  onEditRuntimeProfiles,
}: ControlledAgentStatusBarProps) {
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [openSelector, setOpenSelector] = useState<StatusSelector | null>(null);

  const providerAnchorRef = useRef<View>(null);
  const modeAnchorRef = useRef<View>(null);
  const _modelAnchorRef = useRef<View>(null);
  const thinkingAnchorRef = useRef<View>(null);

  const selectability = resolveStatusSelectability({
    onSelectProvider,
    providerOptions,
    onSelectMode,
    modeOptions,
    onSelectModel,
    onSelectThinkingOption,
    thinkingOptions,
  });
  const canSelectProvider = selectability.provider;
  const canSelectMode = selectability.mode;
  const canSelectModel = selectability.model;
  const authProfileControl = resolveAuthProfileControlState({
    authProfiles,
    selectedAuthProfileKey,
    isLoading: isAuthProfilesLoading,
    onSelectAuthProfile,
  });
  const hasAuthProfileControl = authProfileControl.hasControl;
  const canSelectAuthProfile = authProfileControl.canSelect;
  const runtimeProfileControl = resolveRuntimeProfileControlState({
    runtimeProfiles,
    selectedRuntimeProfileId,
    isLoading: isRuntimeProfilesLoading,
    onSelectRuntimeProfile,
    allowAdHoc: allowAdHocRuntimeProfile,
  });
  const hasRuntimeProfileControl = runtimeProfileControl.hasControl;
  const canSelectRuntimeProfile = runtimeProfileControl.canSelect;
  const canSelectThinking = selectability.thinking;

  const displayProvider = findOptionLabel(providerOptions, selectedProviderId, "Provider");
  const displayMode = findOptionLabel(modeOptions, selectedModeId, "Default");
  const displayAuthProfile = authProfileControl.display;
  const displayRuntimeProfile = runtimeProfileControl.display;
  const displayThinking = findOptionLabel(
    thinkingOptions,
    selectedThinkingOptionId,
    thinkingOptions?.[0]?.label ?? "Unknown",
  );

  const { icon: ModeIconComponent, color: modeIconColor } = resolveModeVisualsForProvider(
    provider,
    selectedModeId,
    providerDefinitions,
    theme.colors.palette,
  );
  const ProviderIcon = resolveProviderIcon(provider);

  const hasAnyControl = resolveHasAnyControl({
    providerOptions,
    modeOptions,
    canSelectModel,
    hasAuthProfileControl,
    hasRuntimeProfileControl,
    thinkingOptions,
    features,
  });

  const modelDisabled = disabled;

  const comboboxProviderOptions = useMemo<ComboboxOption[]>(
    () => toComboboxOptions(providerOptions),
    [providerOptions],
  );
  const comboboxModeOptions = useMemo<ComboboxOption[]>(
    () => toComboboxOptions(modeOptions),
    [modeOptions],
  );
  const fallbackAllProviderModels = useMemo(
    () => buildFallbackAllProviderModels(provider, modelOptions),
    [modelOptions, provider],
  );
  const effectiveProviderDefinitions = providerDefinitions;
  const effectiveAllProviderModels = allProviderModels ?? fallbackAllProviderModels;
  const canSelectProviderInModelMenu = canSelectModelProvider ?? alwaysTrue;
  const comboboxThinkingOptions = useMemo<ComboboxOption[]>(
    () => toComboboxOptions(thinkingOptions),
    [thinkingOptions],
  );

  const renderModeOption = useCallback(
    (args: { option: ComboboxOption; selected: boolean; active: boolean; onPress: () => void }) => (
      <ModeComboboxOption
        option={args.option}
        selected={args.selected}
        active={args.active}
        onPress={args.onPress}
        provider={provider}
        providerDefinitions={providerDefinitions}
        iconColor={theme.colors.foreground}
      />
    ),
    [provider, providerDefinitions, theme.colors.foreground],
  );

  const handleOpenChange = useCallback(
    (selector: StatusSelector) =>
      buildOpenChangeHandler(selector, setOpenSelector, onDropdownClose),
    [onDropdownClose],
  );

  const handleProviderPress = useCallback(() => {
    handleOpenChange("provider")(openSelector !== "provider");
  }, [handleOpenChange, openSelector]);

  const handleThinkingPress = useCallback(() => {
    handleOpenChange("thinking")(openSelector !== "thinking");
  }, [handleOpenChange, openSelector]);

  const handleModePress = useCallback(() => {
    handleOpenChange("mode")(openSelector !== "mode");
  }, [handleOpenChange, openSelector]);

  const handleProviderOpenChange = useMemo(() => handleOpenChange("provider"), [handleOpenChange]);
  const handleThinkingOpenChange = useMemo(() => handleOpenChange("thinking"), [handleOpenChange]);
  const handleAuthProfileOpenChange = useMemo(
    () => handleOpenChange("auth-profile"),
    [handleOpenChange],
  );
  const handleRuntimeProfileOpenChange = useMemo(
    () => handleOpenChange("runtime-profile"),
    [handleOpenChange],
  );
  const handleModeOpenChange = useMemo(() => handleOpenChange("mode"), [handleOpenChange]);

  const handleProviderSelect = useCallback(
    (id: string) => onSelectProvider?.(id),
    [onSelectProvider],
  );
  const handleThinkingSelect = useCallback(
    (id: string) => onSelectThinkingOption?.(id),
    [onSelectThinkingOption],
  );
  const handleAuthProfileSelect = useCallback(
    (id: string) => {
      setOpenSelector(null);
      setPrefsOpen(false);
      onSelectAuthProfile?.(id);
    },
    [onSelectAuthProfile],
  );
  const handleRuntimeProfileSelect = useCallback(
    (id: string) => {
      setOpenSelector(null);
      setPrefsOpen(false);
      onSelectRuntimeProfile?.(id);
    },
    [onSelectRuntimeProfile],
  );
  const handleModeSelect = useCallback((id: string) => onSelectMode?.(id), [onSelectMode]);

  const providerPressableStyle = useMemo(
    () =>
      makeBadgePressableStyle(
        styles.modeBadge,
        styles.disabledBadge,
        disabled || !canSelectProvider,
        openSelector === "provider",
      ),
    [canSelectProvider, disabled, openSelector],
  );

  const thinkingPressableStyle = useMemo(
    () =>
      makeBadgePressableStyle(
        styles.modeBadge,
        styles.disabledBadge,
        disabled || !canSelectThinking,
        openSelector === "thinking",
      ),
    [canSelectThinking, disabled, openSelector],
  );

  const authProfilePressableStyle = useMemo(
    () =>
      makeBadgePressableStyle(
        styles.modeBadge,
        styles.disabledBadge,
        disabled || !canSelectAuthProfile,
        openSelector === "auth-profile",
      ),
    [canSelectAuthProfile, disabled, openSelector],
  );

  const modePressableStyle = useMemo(
    () =>
      makeBadgePressableStyle(
        styles.modeIconBadge,
        styles.disabledBadge,
        disabled || !canSelectMode,
        openSelector === "mode",
      ),
    [canSelectMode, disabled, openSelector],
  );

  const desktopRuntimeProfilePressableStyle = useMemo(
    () =>
      makeBadgePressableStyle(
        styles.modeBadge,
        styles.disabledBadge,
        disabled || !canSelectRuntimeProfile,
        openSelector === "runtime-profile",
      ),
    [canSelectRuntimeProfile, disabled, openSelector],
  );

  const handleOpenPrefs = useCallback(() => {
    Keyboard.dismiss();
    setPrefsOpen(true);
  }, []);

  const handleClosePrefs = useCallback(() => {
    setPrefsOpen(false);
  }, []);

  const handleEditRuntimeProfiles = useCallback(() => {
    setPrefsOpen(false);
    setOpenSelector(null);
    onEditRuntimeProfiles?.();
  }, [onEditRuntimeProfiles]);

  const prefsButtonStyle = makePrefsButtonStyle;

  const handleSheetModelSelect = useCallback(
    (nextProviderId: string, modelId: string) => {
      pickSheetModel({
        nextProviderId,
        modelId,
        currentProvider: provider,
        onSelectProviderAndModel,
        onSelectProvider,
        onSelectModel,
      });
    },
    [onSelectModel, onSelectProvider, onSelectProviderAndModel, provider],
  );

  const sheetThinkingPressableStyle = useMemo(
    () => makeSheetPressableStyle(disabled || !canSelectThinking),
    [canSelectThinking, disabled],
  );

  const sheetAuthProfilePressableStyle = useMemo(
    () => makeSheetPressableStyle(disabled || !canSelectAuthProfile),
    [canSelectAuthProfile, disabled],
  );

  const sheetRuntimeProfilePressableStyle = useMemo(
    () => makeSheetPressableStyle(disabled || !canSelectRuntimeProfile),
    [canSelectRuntimeProfile, disabled],
  );

  const sheetModePressableStyle = useMemo(
    () => makeSheetPressableStyle(disabled || !canSelectMode),
    [canSelectMode, disabled],
  );

  const sheetSelectStyle = useMemo(
    () => [styles.sheetSelect, modelDisabled && styles.disabledSheetSelect],
    [modelDisabled],
  );
  const renderSheetModelTrigger = useCallback(
    ({ selectedModelLabel }: { selectedModelLabel: string }) => (
      <SheetModelTriggerView
        selectedModelLabel={selectedModelLabel}
        style={sheetSelectStyle}
        ProviderIcon={ProviderIcon}
      />
    ),
    [ProviderIcon, sheetSelectStyle],
  );

  if (!hasAnyControl) {
    return null;
  }

  const statusBarSurface = resolveAgentStatusBarSurface({
    isWeb: platformIsWeb,
    isCompact,
  });
  const splitSheetControls = shouldSplitAgentStatusBarControls({
    isWeb: platformIsWeb,
    isCompact,
  });
  const hasPreferencesControl = resolveHasPreferencesControl({
    hasRuntimeProfileControl,
    hasAuthProfileControl,
    canSelectThinking,
    canSelectMode,
    features,
  });

  return (
    <View style={styles.container}>
      {statusBarSurface === "desktop" ? (
        <DesktopStatusBarContent
          provider={provider}
          providerOptions={providerOptions}
          selectedProviderId={selectedProviderId}
          modeOptions={modeOptions}
          selectedModeId={selectedModeId}
          modelOptions={modelOptions}
          selectedModelId={selectedModelId}
          authProfiles={authProfiles}
          selectedAuthProfileKey={selectedAuthProfileKey}
          hasAuthProfileControl={hasAuthProfileControl}
          canSelectAuthProfile={canSelectAuthProfile}
          isAuthProfilesLoading={isAuthProfilesLoading}
          runtimeProfiles={runtimeProfiles}
          selectedRuntimeProfileId={selectedRuntimeProfileId}
          selectedRuntimeProfileVersion={selectedRuntimeProfileVersion}
          hasRuntimeProfileControl={hasRuntimeProfileControl}
          canSelectRuntimeProfile={canSelectRuntimeProfile}
          allowAdHocRuntimeProfile={allowAdHocRuntimeProfile}
          isRuntimeProfilesLoading={isRuntimeProfilesLoading}
          thinkingOptions={thinkingOptions}
          selectedThinkingOptionId={selectedThinkingOptionId}
          features={features}
          onSetFeature={onSetFeature}
          onToggleFavoriteModel={onToggleFavoriteModel}
          onDropdownClose={onDropdownClose}
          onModelSelectorOpen={onModelSelectorOpen}
          providerDefinitions={providerDefinitions}
          favoriteKeys={favoriteKeys}
          disabled={disabled}
          isModelLoading={isModelLoading}
          canSelectProvider={canSelectProvider}
          canSelectMode={canSelectMode}
          canSelectModel={canSelectModel}
          canSelectThinking={canSelectThinking}
          canSelectProviderInModelMenu={canSelectProviderInModelMenu}
          modelDisabled={modelDisabled}
          effectiveProviderDefinitions={effectiveProviderDefinitions}
          effectiveAllProviderModels={effectiveAllProviderModels}
          comboboxProviderOptions={comboboxProviderOptions}
          comboboxModeOptions={comboboxModeOptions}
          comboboxThinkingOptions={comboboxThinkingOptions}
          displayProvider={displayProvider}
          displayAuthProfile={displayAuthProfile}
          displayRuntimeProfile={displayRuntimeProfile}
          displayThinking={displayThinking}
          ModeIconComponent={ModeIconComponent}
          modeIconColor={modeIconColor}
          openSelector={openSelector}
          providerAnchorRef={providerAnchorRef}
          thinkingAnchorRef={thinkingAnchorRef}
          modeAnchorRef={modeAnchorRef}
          providerPressableStyle={providerPressableStyle}
          thinkingPressableStyle={thinkingPressableStyle}
          authProfilePressableStyle={authProfilePressableStyle}
          desktopRuntimeProfilePressableStyle={desktopRuntimeProfilePressableStyle}
          modePressableStyle={modePressableStyle}
          handleProviderPress={handleProviderPress}
          handleThinkingPress={handleThinkingPress}
          handleModePress={handleModePress}
          handleProviderSelect={handleProviderSelect}
          handleThinkingSelect={handleThinkingSelect}
          handleRuntimeProfileSelect={handleRuntimeProfileSelect}
          handleAuthProfileSelect={handleAuthProfileSelect}
          handleModeSelect={handleModeSelect}
          handleProviderOpenChange={handleProviderOpenChange}
          handleThinkingOpenChange={handleThinkingOpenChange}
          handleRuntimeProfileOpenChange={handleRuntimeProfileOpenChange}
          handleAuthProfileOpenChange={handleAuthProfileOpenChange}
          handleModeOpenChange={handleModeOpenChange}
          handleOpenChange={handleOpenChange}
          prefsOpen={prefsOpen}
          handleOpenPrefs={handleOpenPrefs}
          handleClosePrefs={handleClosePrefs}
          sheetThinkingPressableStyle={sheetThinkingPressableStyle}
          sheetRuntimeProfilePressableStyle={sheetRuntimeProfilePressableStyle}
          sheetAuthProfilePressableStyle={sheetAuthProfilePressableStyle}
          sheetModePressableStyle={sheetModePressableStyle}
          handleSheetModelSelect={handleSheetModelSelect}
          renderSheetModelTrigger={renderSheetModelTrigger}
          ProviderIcon={ProviderIcon}
          hasPreferencesControl={hasPreferencesControl}
          onEditRuntimeProfiles={handleEditRuntimeProfiles}
          renderModeOption={renderModeOption}
        />
      ) : (
        <SheetStatusBarContent
          provider={provider}
          modeOptions={modeOptions}
          selectedModeId={selectedModeId}
          selectedModelId={selectedModelId}
          authProfiles={authProfiles}
          selectedAuthProfileKey={selectedAuthProfileKey}
          hasAuthProfileControl={hasAuthProfileControl}
          canSelectAuthProfile={canSelectAuthProfile}
          isAuthProfilesLoading={isAuthProfilesLoading}
          runtimeProfiles={runtimeProfiles}
          selectedRuntimeProfileId={selectedRuntimeProfileId}
          selectedRuntimeProfileVersion={selectedRuntimeProfileVersion}
          hasRuntimeProfileControl={hasRuntimeProfileControl}
          canSelectRuntimeProfile={canSelectRuntimeProfile}
          allowAdHocRuntimeProfile={allowAdHocRuntimeProfile}
          isRuntimeProfilesLoading={isRuntimeProfilesLoading}
          thinkingOptions={thinkingOptions}
          selectedThinkingOptionId={selectedThinkingOptionId}
          features={features}
          onSetFeature={onSetFeature}
          onSelectMode={onSelectMode}
          onSelectThinkingOption={onSelectThinkingOption}
          onToggleFavoriteModel={onToggleFavoriteModel}
          onDropdownClose={onDropdownClose}
          onModelSelectorOpen={onModelSelectorOpen}
          providerDefinitions={providerDefinitions}
          favoriteKeys={favoriteKeys}
          disabled={disabled}
          isModelLoading={isModelLoading}
          canSelectMode={canSelectMode}
          canSelectModel={canSelectModel}
          canSelectThinking={canSelectThinking}
          canSelectProviderInModelMenu={canSelectProviderInModelMenu}
          modelDisabled={modelDisabled}
          effectiveProviderDefinitions={effectiveProviderDefinitions}
          effectiveAllProviderModels={effectiveAllProviderModels}
          displayMode={displayMode}
          displayAuthProfile={displayAuthProfile}
          displayRuntimeProfile={displayRuntimeProfile}
          displayThinking={displayThinking}
          ModeIconComponent={ModeIconComponent}
          modeIconColor={modeIconColor}
          openSelector={openSelector}
          ProviderIcon={ProviderIcon}
          prefsOpen={prefsOpen}
          handleOpenPrefs={handleOpenPrefs}
          handleClosePrefs={handleClosePrefs}
          prefsButtonStyle={prefsButtonStyle}
          splitControls={splitSheetControls}
          hasPreferencesControl={hasPreferencesControl}
          sheetThinkingPressableStyle={sheetThinkingPressableStyle}
          sheetRuntimeProfilePressableStyle={sheetRuntimeProfilePressableStyle}
          sheetAuthProfilePressableStyle={sheetAuthProfilePressableStyle}
          sheetModePressableStyle={sheetModePressableStyle}
          handleSheetModelSelect={handleSheetModelSelect}
          handleThinkingOpenChange={handleThinkingOpenChange}
          handleRuntimeProfileOpenChange={handleRuntimeProfileOpenChange}
          handleAuthProfileOpenChange={handleAuthProfileOpenChange}
          handleModeOpenChange={handleModeOpenChange}
          handleRuntimeProfileSelect={handleRuntimeProfileSelect}
          handleAuthProfileSelect={handleAuthProfileSelect}
          handleOpenChange={handleOpenChange}
          renderSheetModelTrigger={renderSheetModelTrigger}
          onEditRuntimeProfiles={handleEditRuntimeProfiles}
        />
      )}
    </View>
  );
}

interface DesktopStatusBarContentProps {
  provider: string;
  providerOptions?: StatusOption[];
  selectedProviderId?: string;
  modeOptions?: StatusOption[];
  selectedModeId?: string;
  modelOptions?: StatusOption[];
  selectedModelId?: string;
  authProfiles: ProviderAuthProfile[];
  selectedAuthProfileKey?: string;
  hasAuthProfileControl: boolean;
  canSelectAuthProfile: boolean;
  isAuthProfilesLoading: boolean;
  runtimeProfiles: RuntimeProfile[];
  selectedRuntimeProfileId?: string;
  selectedRuntimeProfileVersion?: number;
  hasRuntimeProfileControl: boolean;
  canSelectRuntimeProfile: boolean;
  allowAdHocRuntimeProfile: boolean;
  isRuntimeProfilesLoading: boolean;
  thinkingOptions?: StatusOption[];
  selectedThinkingOptionId?: string;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onSelectMode?: (modeId: string) => void;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  onToggleFavoriteModel?: (provider: string, modelId: string) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  providerDefinitions: AgentProviderDefinition[];
  favoriteKeys: Set<string>;
  disabled: boolean;
  isModelLoading: boolean;
  canSelectProvider: boolean;
  canSelectMode: boolean;
  canSelectModel: boolean;
  canSelectThinking: boolean;
  canSelectProviderInModelMenu: (providerId: string) => boolean;
  modelDisabled: boolean;
  effectiveProviderDefinitions: AgentProviderDefinition[];
  effectiveAllProviderModels: Map<string, AgentModelDefinition[]>;
  comboboxProviderOptions: ComboboxOption[];
  comboboxModeOptions: ComboboxOption[];
  comboboxThinkingOptions: ComboboxOption[];
  displayProvider: string;
  displayAuthProfile: string;
  displayRuntimeProfile: string;
  displayThinking: string;
  ModeIconComponent: (typeof MODE_ICONS)[keyof typeof MODE_ICONS] | null;
  modeIconColor: string;
  openSelector: StatusSelector | null;
  ProviderIcon: ReturnType<typeof getProviderIcon> | null;
  prefsOpen: boolean;
  providerAnchorRef: RefObject<View | null>;
  thinkingAnchorRef: RefObject<View | null>;
  modeAnchorRef: RefObject<View | null>;
  providerPressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  thinkingPressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  authProfilePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  desktopRuntimeProfilePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  modePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  handleProviderPress: () => void;
  handleThinkingPress: () => void;
  handleModePress: () => void;
  handleProviderSelect: (id: string) => void;
  handleThinkingSelect: (id: string) => void;
  handleRuntimeProfileSelect: (id: string) => void;
  handleAuthProfileSelect: (id: string) => void;
  handleModeSelect: (id: string) => void;
  handleProviderOpenChange: (open: boolean) => void;
  handleThinkingOpenChange: (open: boolean) => void;
  handleRuntimeProfileOpenChange: (open: boolean) => void;
  handleAuthProfileOpenChange: (open: boolean) => void;
  handleModeOpenChange: (open: boolean) => void;
  handleOpenChange: (selector: StatusSelector) => (nextOpen: boolean) => void;
  handleOpenPrefs: () => void;
  handleClosePrefs: () => void;
  sheetThinkingPressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  sheetRuntimeProfilePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  sheetAuthProfilePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  sheetModePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  handleSheetModelSelect: (providerId: string, modelId: string) => void;
  renderSheetModelTrigger: (args: { selectedModelLabel: string }) => ReactElement;
  hasPreferencesControl: boolean;
  onEditRuntimeProfiles?: () => void;
  renderModeOption: (args: {
    option: ComboboxOption;
    selected: boolean;
    active: boolean;
    onPress: () => void;
  }) => ReactElement;
}

function DesktopStatusBarContent(props: DesktopStatusBarContentProps) {
  const {
    provider,
    modeOptions,
    selectedModeId,
    selectedModelId,
    authProfiles,
    selectedAuthProfileKey,
    hasAuthProfileControl,
    canSelectAuthProfile,
    runtimeProfiles,
    selectedRuntimeProfileId,
    selectedRuntimeProfileVersion,
    hasRuntimeProfileControl,
    canSelectRuntimeProfile,
    allowAdHocRuntimeProfile,
    thinkingOptions,
    selectedThinkingOptionId,
    features,
    onSetFeature,
    onSelectMode,
    onSelectThinkingOption,
    onToggleFavoriteModel,
    onDropdownClose,
    onModelSelectorOpen,
    disabled,
    isModelLoading,
    canSelectMode,
    canSelectModel,
    canSelectThinking,
    canSelectProviderInModelMenu,
    modelDisabled,
    effectiveProviderDefinitions,
    effectiveAllProviderModels,
    displayAuthProfile,
    displayRuntimeProfile,
    displayThinking,
    ModeIconComponent,
    modeIconColor,
    openSelector,
    prefsOpen,
    handleRuntimeProfileSelect,
    handleAuthProfileSelect,
    handleThinkingOpenChange,
    handleRuntimeProfileOpenChange,
    handleAuthProfileOpenChange,
    handleModeOpenChange,
    handleOpenChange,
    handleOpenPrefs,
    handleClosePrefs,
    sheetThinkingPressableStyle,
    sheetRuntimeProfilePressableStyle,
    sheetAuthProfilePressableStyle,
    sheetModePressableStyle,
    renderSheetModelTrigger,
    favoriteKeys,
    hasPreferencesControl,
    onEditRuntimeProfiles,
  } = props;

  const hasSavedRuntimeProfile = Boolean(selectedRuntimeProfileId);
  const shouldRenderPreferencesButton = hasPreferencesControl || canSelectModel;

  return (
    <>
      {shouldRenderPreferencesButton ? (
        <Pressable
          onPress={handleOpenPrefs}
          style={makePrefsButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={`Agent preferences (${displayRuntimeProfile})`}
          testID="agent-preferences-button"
        >
          <SheetPreferencesTriggerContent displayRuntimeProfile={displayRuntimeProfile} />
        </Pressable>
      ) : null}

      <AdaptiveModalSheet
        title="Preferences"
        visible={prefsOpen && shouldRenderPreferencesButton}
        onClose={handleClosePrefs}
        testID="agent-preferences-sheet"
      >
        <PreferencesSheetBody
          provider={provider}
          modeOptions={modeOptions}
          selectedModeId={selectedModeId}
          selectedModelId={selectedModelId}
          authProfiles={authProfiles}
          selectedAuthProfileKey={selectedAuthProfileKey}
          hasAuthProfileControl={hasAuthProfileControl}
          canSelectAuthProfile={canSelectAuthProfile}
          runtimeProfiles={runtimeProfiles}
          selectedRuntimeProfileId={selectedRuntimeProfileId}
          selectedRuntimeProfileVersion={selectedRuntimeProfileVersion}
          hasRuntimeProfileControl={hasRuntimeProfileControl}
          canSelectRuntimeProfile={canSelectRuntimeProfile}
          allowAdHocRuntimeProfile={allowAdHocRuntimeProfile}
          thinkingOptions={thinkingOptions}
          selectedThinkingOptionId={selectedThinkingOptionId}
          features={features}
          onSetFeature={onSetFeature}
          onSelectMode={onSelectMode}
          onSelectThinkingOption={onSelectThinkingOption}
          onToggleFavoriteModel={onToggleFavoriteModel}
          onDropdownClose={onDropdownClose}
          onModelSelectorOpen={onModelSelectorOpen}
          providerDefinitions={props.providerDefinitions}
          favoriteKeys={favoriteKeys}
          disabled={disabled}
          isModelLoading={isModelLoading}
          canSelectMode={canSelectMode}
          canSelectThinking={canSelectThinking}
          canSelectProviderInModelMenu={canSelectProviderInModelMenu}
          modelDisabled={modelDisabled}
          effectiveProviderDefinitions={effectiveProviderDefinitions}
          effectiveAllProviderModels={effectiveAllProviderModels}
          displayMode={findOptionLabel(modeOptions, selectedModeId, "Default")}
          displayAuthProfile={displayAuthProfile}
          displayRuntimeProfile={displayRuntimeProfile}
          displayThinking={displayThinking}
          ModeIconComponent={ModeIconComponent}
          modeIconColor={modeIconColor}
          openSelector={openSelector}
          sheetThinkingPressableStyle={sheetThinkingPressableStyle}
          sheetRuntimeProfilePressableStyle={sheetRuntimeProfilePressableStyle}
          sheetAuthProfilePressableStyle={sheetAuthProfilePressableStyle}
          sheetModePressableStyle={sheetModePressableStyle}
          handleSheetModelSelect={props.handleSheetModelSelect}
          handleThinkingOpenChange={handleThinkingOpenChange}
          handleRuntimeProfileOpenChange={handleRuntimeProfileOpenChange}
          handleAuthProfileOpenChange={handleAuthProfileOpenChange}
          handleModeOpenChange={handleModeOpenChange}
          handleRuntimeProfileSelect={handleRuntimeProfileSelect}
          handleAuthProfileSelect={handleAuthProfileSelect}
          handleOpenChange={handleOpenChange}
          renderSheetModelTrigger={renderSheetModelTrigger}
          onEditRuntimeProfiles={onEditRuntimeProfiles}
          renderModelControl={canSelectModel}
          shouldRenderDirectRuntimeControls={!hasSavedRuntimeProfile}
        />
      </AdaptiveModalSheet>
    </>
  );
}

function SheetAuthProfileSection({
  authProfiles,
  selectedAuthProfileKey,
  canSelectAuthProfile,
  disabled,
  displayAuthProfile,
  openSelector,
  sheetAuthProfilePressableStyle,
  handleAuthProfileOpenChange,
  handleAuthProfileSelect,
}: {
  authProfiles: ProviderAuthProfile[];
  selectedAuthProfileKey?: string;
  canSelectAuthProfile: boolean;
  disabled: boolean;
  displayAuthProfile: string;
  openSelector: StatusSelector | null;
  sheetAuthProfilePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  handleAuthProfileOpenChange: (open: boolean) => void;
  handleAuthProfileSelect: (id: string) => void;
}) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.sheetSection}>
      <DropdownMenu
        open={openSelector === "auth-profile"}
        onOpenChange={handleAuthProfileOpenChange}
      >
        <DropdownMenuTrigger
          disabled={disabled || !canSelectAuthProfile}
          style={sheetAuthProfilePressableStyle}
          accessibilityRole="button"
          accessibilityLabel="Select agent account"
          testID="agent-preferences-auth-profile"
        >
          <User size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={styles.sheetSelectText}>Account</Text>
          <Text ellipsizeMode="tail" numberOfLines={1} style={styles.sheetSelectValueText}>
            {displayAuthProfile}
          </Text>
          <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          <AuthProfileAutoMenuItem
            selected={!selectedAuthProfileKey}
            onSelectAuthProfile={handleAuthProfileSelect}
          />
          {authProfiles.map((profile) => (
            <AuthProfileMenuItem
              key={profile.key}
              profile={profile}
              selected={profile.key === selectedAuthProfileKey}
              onSelectAuthProfile={handleAuthProfileSelect}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function RuntimeProfileAutoMenuItem({
  selected,
  onSelectRuntimeProfile,
}: {
  selected: boolean;
  onSelectRuntimeProfile?: (runtimeProfileId: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelectRuntimeProfile?.("");
  }, [onSelectRuntimeProfile]);

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {CUSTOM_SETTINGS_LABEL}
    </DropdownMenuItem>
  );
}

function RuntimeProfileMenuItem({
  profile,
  selected,
  onSelectRuntimeProfile,
}: {
  profile: RuntimeProfile;
  selected: boolean;
  onSelectRuntimeProfile?: (runtimeProfileId: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelectRuntimeProfile?.(profile.id);
  }, [onSelectRuntimeProfile, profile.id]);

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {profile.name}
    </DropdownMenuItem>
  );
}

function SheetRuntimeProfileSection({
  visible,
  runtimeProfiles,
  selectedRuntimeProfileId,
  canSelectRuntimeProfile,
  allowAdHocRuntimeProfile,
  disabled,
  displayRuntimeProfile,
  openSelector,
  sheetRuntimeProfilePressableStyle,
  handleRuntimeProfileOpenChange,
  handleRuntimeProfileSelect,
}: {
  visible: boolean;
  runtimeProfiles: RuntimeProfile[];
  selectedRuntimeProfileId?: string;
  canSelectRuntimeProfile: boolean;
  allowAdHocRuntimeProfile: boolean;
  disabled: boolean;
  displayRuntimeProfile: string;
  openSelector: StatusSelector | null;
  sheetRuntimeProfilePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  handleRuntimeProfileOpenChange: (open: boolean) => void;
  handleRuntimeProfileSelect: (id: string) => void;
}) {
  const { theme } = useUnistyles();

  if (!visible) {
    return null;
  }

  return (
    <View style={styles.sheetSection}>
      <DropdownMenu
        open={openSelector === "runtime-profile"}
        onOpenChange={handleRuntimeProfileOpenChange}
      >
        <DropdownMenuTrigger
          disabled={disabled || !canSelectRuntimeProfile}
          style={sheetRuntimeProfilePressableStyle}
          accessibilityRole="button"
          accessibilityLabel="Select runtime profile"
          testID="agent-preferences-runtime-profile"
        >
          <Settings2 size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={styles.sheetSelectText}>Profile</Text>
          <Text ellipsizeMode="tail" numberOfLines={1} style={styles.sheetSelectValueText}>
            {displayRuntimeProfile}
          </Text>
          <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          {allowAdHocRuntimeProfile ? (
            <RuntimeProfileAutoMenuItem
              selected={!selectedRuntimeProfileId}
              onSelectRuntimeProfile={handleRuntimeProfileSelect}
            />
          ) : null}
          {runtimeProfiles.map((profile) => (
            <RuntimeProfileMenuItem
              key={profile.id}
              profile={profile}
              selected={profile.id === selectedRuntimeProfileId}
              onSelectRuntimeProfile={handleRuntimeProfileSelect}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

interface SheetStatusBarContentProps {
  provider: string;
  modeOptions?: StatusOption[];
  selectedModeId?: string;
  selectedModelId?: string;
  authProfiles: ProviderAuthProfile[];
  selectedAuthProfileKey?: string;
  hasAuthProfileControl: boolean;
  canSelectAuthProfile: boolean;
  isAuthProfilesLoading: boolean;
  runtimeProfiles: RuntimeProfile[];
  selectedRuntimeProfileId?: string;
  selectedRuntimeProfileVersion?: number;
  hasRuntimeProfileControl: boolean;
  canSelectRuntimeProfile: boolean;
  allowAdHocRuntimeProfile: boolean;
  isRuntimeProfilesLoading: boolean;
  thinkingOptions?: StatusOption[];
  selectedThinkingOptionId?: string;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onSelectMode?: (modeId: string) => void;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  onToggleFavoriteModel?: (provider: string, modelId: string) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  providerDefinitions: AgentProviderDefinition[];
  favoriteKeys: Set<string>;
  disabled: boolean;
  isModelLoading: boolean;
  canSelectMode: boolean;
  canSelectModel: boolean;
  canSelectThinking: boolean;
  canSelectProviderInModelMenu: (providerId: string) => boolean;
  modelDisabled: boolean;
  effectiveProviderDefinitions: AgentProviderDefinition[];
  effectiveAllProviderModels: Map<string, AgentModelDefinition[]>;
  displayMode: string;
  displayAuthProfile: string;
  displayRuntimeProfile: string;
  displayThinking: string;
  ModeIconComponent: (typeof MODE_ICONS)[keyof typeof MODE_ICONS] | null;
  modeIconColor: string;
  openSelector: StatusSelector | null;
  ProviderIcon: ReturnType<typeof getProviderIcon> | null;
  prefsOpen: boolean;
  handleOpenPrefs: () => void;
  handleClosePrefs: () => void;
  prefsButtonStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  splitControls: boolean;
  hasPreferencesControl: boolean;
  sheetThinkingPressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  sheetRuntimeProfilePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  sheetAuthProfilePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  sheetModePressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  handleSheetModelSelect: (providerId: string, modelId: string) => void;
  handleThinkingOpenChange: (open: boolean) => void;
  handleRuntimeProfileOpenChange: (open: boolean) => void;
  handleAuthProfileOpenChange: (open: boolean) => void;
  handleModeOpenChange: (open: boolean) => void;
  handleRuntimeProfileSelect: (id: string) => void;
  handleAuthProfileSelect: (id: string) => void;
  handleOpenChange: (selector: StatusSelector) => (nextOpen: boolean) => void;
  renderSheetModelTrigger: (args: { selectedModelLabel: string }) => ReactElement;
  onEditRuntimeProfiles?: () => void;
}

type PreferencesSheetBodyProps = Pick<
  SheetStatusBarContentProps,
  | "provider"
  | "modeOptions"
  | "selectedModeId"
  | "selectedModelId"
  | "authProfiles"
  | "selectedAuthProfileKey"
  | "hasAuthProfileControl"
  | "canSelectAuthProfile"
  | "runtimeProfiles"
  | "selectedRuntimeProfileId"
  | "selectedRuntimeProfileVersion"
  | "hasRuntimeProfileControl"
  | "canSelectRuntimeProfile"
  | "allowAdHocRuntimeProfile"
  | "thinkingOptions"
  | "selectedThinkingOptionId"
  | "features"
  | "onSetFeature"
  | "onSelectMode"
  | "onSelectThinkingOption"
  | "onToggleFavoriteModel"
  | "onDropdownClose"
  | "onModelSelectorOpen"
  | "providerDefinitions"
  | "favoriteKeys"
  | "disabled"
  | "isModelLoading"
  | "canSelectMode"
  | "canSelectThinking"
  | "canSelectProviderInModelMenu"
  | "modelDisabled"
  | "effectiveProviderDefinitions"
  | "effectiveAllProviderModels"
  | "displayMode"
  | "displayAuthProfile"
  | "displayRuntimeProfile"
  | "displayThinking"
  | "ModeIconComponent"
  | "modeIconColor"
  | "openSelector"
  | "sheetThinkingPressableStyle"
  | "sheetRuntimeProfilePressableStyle"
  | "sheetAuthProfilePressableStyle"
  | "sheetModePressableStyle"
  | "handleSheetModelSelect"
  | "handleThinkingOpenChange"
  | "handleRuntimeProfileOpenChange"
  | "handleAuthProfileOpenChange"
  | "handleModeOpenChange"
  | "handleRuntimeProfileSelect"
  | "handleAuthProfileSelect"
  | "handleOpenChange"
  | "renderSheetModelTrigger"
  | "onEditRuntimeProfiles"
> & {
  renderModelControl: boolean;
  shouldRenderDirectRuntimeControls: boolean;
};

function PreferencesSheetBody(props: PreferencesSheetBodyProps) {
  const { theme } = useUnistyles();
  const {
    provider,
    modeOptions,
    selectedModeId,
    selectedModelId,
    authProfiles,
    selectedAuthProfileKey,
    hasAuthProfileControl,
    canSelectAuthProfile,
    runtimeProfiles,
    selectedRuntimeProfileId,
    selectedRuntimeProfileVersion,
    hasRuntimeProfileControl,
    canSelectRuntimeProfile,
    allowAdHocRuntimeProfile,
    thinkingOptions,
    selectedThinkingOptionId,
    features,
    onSetFeature,
    onSelectMode,
    onSelectThinkingOption,
    onToggleFavoriteModel,
    onDropdownClose,
    onModelSelectorOpen,
    providerDefinitions,
    favoriteKeys,
    disabled,
    isModelLoading,
    canSelectMode,
    canSelectThinking,
    canSelectProviderInModelMenu,
    modelDisabled,
    effectiveProviderDefinitions,
    effectiveAllProviderModels,
    displayMode,
    displayAuthProfile,
    displayRuntimeProfile,
    displayThinking,
    ModeIconComponent,
    modeIconColor,
    openSelector,
    sheetThinkingPressableStyle,
    sheetRuntimeProfilePressableStyle,
    sheetAuthProfilePressableStyle,
    sheetModePressableStyle,
    handleSheetModelSelect,
    handleThinkingOpenChange,
    handleRuntimeProfileOpenChange,
    handleAuthProfileOpenChange,
    handleModeOpenChange,
    handleRuntimeProfileSelect,
    handleAuthProfileSelect,
    handleOpenChange,
    renderSheetModelTrigger,
    onEditRuntimeProfiles,
    renderModelControl,
    shouldRenderDirectRuntimeControls,
  } = props;
  const selectedRuntimeProfile = findRuntimeProfile(runtimeProfiles, selectedRuntimeProfileId);
  const selectedRuntimeProfileIdForApply = selectedRuntimeProfile?.id;
  const handleApplyLatestProfile = useCallback(() => {
    if (selectedRuntimeProfileIdForApply) {
      handleRuntimeProfileSelect(selectedRuntimeProfileIdForApply);
    }
  }, [handleRuntimeProfileSelect, selectedRuntimeProfileIdForApply]);

  return (
    <>
      <SheetRuntimeProfileSection
        visible={hasRuntimeProfileControl}
        runtimeProfiles={runtimeProfiles}
        selectedRuntimeProfileId={selectedRuntimeProfileId}
        canSelectRuntimeProfile={canSelectRuntimeProfile}
        allowAdHocRuntimeProfile={allowAdHocRuntimeProfile}
        disabled={disabled}
        displayRuntimeProfile={displayRuntimeProfile}
        openSelector={openSelector}
        sheetRuntimeProfilePressableStyle={sheetRuntimeProfilePressableStyle}
        handleRuntimeProfileOpenChange={handleRuntimeProfileOpenChange}
        handleRuntimeProfileSelect={handleRuntimeProfileSelect}
      />

      {renderModelControl && shouldRenderDirectRuntimeControls ? (
        <View style={styles.sheetSection}>
          <CombinedModelSelector
            providerDefinitions={effectiveProviderDefinitions}
            allProviderModels={effectiveAllProviderModels}
            selectedProvider={provider}
            selectedModel={selectedModelId ?? ""}
            canSelectProvider={canSelectProviderInModelMenu}
            onSelect={handleSheetModelSelect}
            favoriteKeys={favoriteKeys}
            onToggleFavorite={onToggleFavoriteModel}
            isLoading={isModelLoading}
            disabled={modelDisabled}
            onOpen={onModelSelectorOpen}
            onClose={onDropdownClose}
            renderTrigger={renderSheetModelTrigger}
          />
        </View>
      ) : null}

      {!shouldRenderDirectRuntimeControls && selectedRuntimeProfile ? (
        <RuntimeProfileDetailsSection
          profile={selectedRuntimeProfile}
          launchedVersion={selectedRuntimeProfileVersion}
          authProfiles={authProfiles}
          providerDefinitions={providerDefinitions}
          modeOptions={modeOptions}
          thinkingOptions={thinkingOptions}
          features={features}
          onEditRuntimeProfiles={onEditRuntimeProfiles}
          onApplyLatestProfile={handleApplyLatestProfile}
        />
      ) : null}

      {hasAuthProfileControl && shouldRenderDirectRuntimeControls ? (
        <SheetAuthProfileSection
          authProfiles={authProfiles}
          selectedAuthProfileKey={selectedAuthProfileKey}
          canSelectAuthProfile={canSelectAuthProfile}
          disabled={disabled}
          displayAuthProfile={displayAuthProfile}
          openSelector={openSelector}
          sheetAuthProfilePressableStyle={sheetAuthProfilePressableStyle}
          handleAuthProfileOpenChange={handleAuthProfileOpenChange}
          handleAuthProfileSelect={handleAuthProfileSelect}
        />
      ) : null}

      {shouldRenderDirectRuntimeControls && thinkingOptions && thinkingOptions.length > 0 ? (
        <View style={styles.sheetSection}>
          <DropdownMenu open={openSelector === "thinking"} onOpenChange={handleThinkingOpenChange}>
            <DropdownMenuTrigger
              disabled={disabled || !canSelectThinking}
              style={sheetThinkingPressableStyle}
              accessibilityRole="button"
              accessibilityLabel="Select thinking option"
              testID="agent-preferences-thinking"
            >
              <Brain size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
              <Text style={styles.sheetSelectText}>{displayThinking}</Text>
              <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              {thinkingOptions.map((thinking) => (
                <ThinkingMenuItem
                  key={thinking.id}
                  thinking={thinking}
                  selected={thinking.id === selectedThinkingOptionId}
                  onSelectThinkingOption={onSelectThinkingOption}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      ) : null}

      {shouldRenderDirectRuntimeControls && modeOptions && modeOptions.length > 0 ? (
        <View style={styles.sheetSection}>
          <DropdownMenu open={openSelector === "mode"} onOpenChange={handleModeOpenChange}>
            <DropdownMenuTrigger
              disabled={disabled || !canSelectMode}
              style={sheetModePressableStyle}
              accessibilityRole="button"
              accessibilityLabel="Select agent mode"
              testID="agent-preferences-mode"
            >
              {ModeIconComponent ? (
                <ModeIconComponent size={theme.iconSize.md} color={modeIconColor} />
              ) : null}
              <Text style={styles.sheetSelectText}>{displayMode}</Text>
              <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              {modeOptions.map((mode) => (
                <ModeMenuItem
                  key={mode.id}
                  mode={mode}
                  provider={provider}
                  providerDefinitions={providerDefinitions}
                  selected={mode.id === selectedModeId}
                  onSelectMode={onSelectMode}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      ) : null}

      {shouldRenderDirectRuntimeControls
        ? features?.map((feature) => (
            <SheetFeatureItem
              key={`feature-${feature.id}`}
              feature={feature}
              disabled={disabled}
              openSelector={openSelector}
              handleOpenChange={handleOpenChange}
              onSetFeature={onSetFeature}
            />
          ))
        : null}
    </>
  );
}

function RuntimeProfileDetailsSection({
  profile,
  launchedVersion,
  authProfiles,
  providerDefinitions,
  modeOptions,
  thinkingOptions,
  features,
  onEditRuntimeProfiles,
  onApplyLatestProfile,
}: {
  profile: RuntimeProfile;
  launchedVersion?: number;
  authProfiles: ProviderAuthProfile[];
  providerDefinitions: AgentProviderDefinition[];
  modeOptions?: StatusOption[];
  thinkingOptions?: StatusOption[];
  features?: AgentFeature[];
  onEditRuntimeProfiles?: () => void;
  onApplyLatestProfile?: () => void;
}) {
  const { theme } = useUnistyles();
  const isStale = launchedVersion !== undefined && launchedVersion < profile.version;
  const featureValues = profile.featureValues ?? {};
  const featureRows = Object.entries(featureValues).map(([featureId, value]) => {
    const featureLabel = features?.find((feature) => feature.id === featureId)?.label ?? featureId;
    return {
      label: featureLabel,
      value: formatRuntimeProfileValue(value),
    };
  });
  const rows = [
    {
      label: "Provider",
      value: resolveProviderLabelFromDefinitions(profile.provider, providerDefinitions),
    },
    {
      label: "Account",
      value: resolveAuthProfileDisplayByKey(authProfiles, profile.accountKey),
    },
    {
      label: "Model",
      value: formatRuntimeProfileValue(profile.model),
    },
    {
      label: "Permission",
      value: findOptionLabel(modeOptions, profile.modeId ?? undefined, profile.modeId ?? "Default"),
    },
    {
      label: "Thinking",
      value: findOptionLabel(
        thinkingOptions,
        profile.thinkingOptionId ?? undefined,
        profile.thinkingOptionId ?? "Default",
      ),
    },
    {
      label: "Launched",
      value: launchedVersion ? `Version ${launchedVersion}` : "Current draft",
    },
    {
      label: "Latest",
      value: `Version ${profile.version}`,
    },
    ...featureRows,
  ];

  return (
    <View style={styles.profileDetailsSection} testID="agent-preferences-profile-details">
      <View style={styles.profileDetailsHeader}>
        <View style={styles.profileDetailsTitleGroup}>
          <Text style={styles.profileDetailsTitle}>Profile details</Text>
          <Text style={styles.profileDetailsName} numberOfLines={1}>
            {profile.name}
          </Text>
        </View>
        {onEditRuntimeProfiles ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Edit ${profile.name}`}
            onPress={onEditRuntimeProfiles}
            style={makeProfileEditButtonStyle}
            testID="agent-preferences-edit-profile"
          >
            <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            <Text style={styles.profileEditButtonText}>Edit</Text>
          </Pressable>
        ) : null}
      </View>
      {rows.map((row) => (
        <View key={row.label} style={styles.profileDetailsRow}>
          <Text style={styles.profileDetailsLabel}>{row.label}</Text>
          <Text style={styles.profileDetailsValue} numberOfLines={1}>
            {row.value}
          </Text>
        </View>
      ))}
      {isStale ? (
        <View style={styles.profileUpdateCallout}>
          <Text style={styles.profileUpdateText}>
            This profile changed after this agent was launched.
          </Text>
          {onApplyLatestProfile ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Apply latest ${profile.name}`}
              onPress={onApplyLatestProfile}
              style={makeProfileApplyButtonStyle}
              testID="agent-preferences-apply-latest-profile"
            >
              <Text style={styles.profileApplyButtonText}>Apply latest profile</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// eslint-disable-next-line complexity
function SheetStatusBarContent(props: SheetStatusBarContentProps) {
  const {
    canSelectModel,
    displayRuntimeProfile,
    selectedRuntimeProfileId,
    prefsOpen,
    handleOpenPrefs,
    handleClosePrefs,
    prefsButtonStyle,
    hasPreferencesControl,
  } = props;

  const isRuntimeProfileSelected = Boolean(selectedRuntimeProfileId);
  const shouldRenderDirectRuntimeControls = !isRuntimeProfileSelected;
  const shouldRenderPreferencesButton = hasPreferencesControl || canSelectModel;

  return (
    <>
      {shouldRenderPreferencesButton ? (
        <Pressable
          onPress={handleOpenPrefs}
          style={prefsButtonStyle}
          accessibilityRole="button"
          accessibilityLabel="Agent preferences"
          testID="agent-preferences-button"
        >
          <SheetPreferencesTriggerContent displayRuntimeProfile={displayRuntimeProfile} />
        </Pressable>
      ) : null}

      <AdaptiveModalSheet
        title="Preferences"
        visible={prefsOpen && shouldRenderPreferencesButton}
        onClose={handleClosePrefs}
        testID="agent-preferences-sheet"
      >
        <PreferencesSheetBody
          {...props}
          renderModelControl={canSelectModel}
          shouldRenderDirectRuntimeControls={shouldRenderDirectRuntimeControls}
        />
      </AdaptiveModalSheet>
    </>
  );
}

function SheetFeatureItem({
  feature,
  disabled,
  openSelector,
  handleOpenChange,
  onSetFeature,
}: {
  feature: AgentFeature;
  disabled: boolean;
  openSelector: StatusSelector | null;
  handleOpenChange: (selector: StatusSelector) => (nextOpen: boolean) => void;
  onSetFeature?: (featureId: string, value: unknown) => void;
}) {
  const { theme } = useUnistyles();
  const featureSelector: StatusSelector = `feature-${feature.id}`;

  const handleFeatureOpenChange = useMemo(
    () => handleOpenChange(featureSelector),
    [handleOpenChange, featureSelector],
  );

  const handleTogglePress = useCallback(() => {
    if (feature.type === "toggle") {
      onSetFeature?.(feature.id, !feature.value);
    }
  }, [feature, onSetFeature]);

  const handleSelectOption = useCallback(
    (optionId: string) => {
      onSetFeature?.(feature.id, optionId);
    },
    [feature.id, onSetFeature],
  );

  const togglePressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.sheetSelect,
      pressed && styles.sheetSelectPressed,
      disabled && styles.disabledSheetSelect,
    ],
    [disabled],
  );

  if (feature.type === "toggle") {
    const FeatureIcon = getFeatureIcon(feature.icon);
    return (
      <View style={styles.sheetSection}>
        <Pressable
          disabled={disabled}
          onPress={handleTogglePress}
          style={togglePressableStyle}
          accessibilityRole="button"
          accessibilityLabel={getFeatureTooltip(feature)}
          testID={`agent-feature-${feature.id}`}
        >
          <FeatureIcon
            size={theme.iconSize.md}
            color={getFeatureIconColor(
              feature.id,
              feature.value,
              theme.colors.palette,
              theme.colors.foregroundMuted,
            )}
          />
          <Text style={styles.sheetSelectText}>{feature.label}</Text>
          <Text style={styles.modeBadgeText}>{feature.value ? "On" : "Off"}</Text>
        </Pressable>
      </View>
    );
  }

  if (feature.type === "select") {
    const selectedOption = feature.options.find((o) => o.id === feature.value);
    return (
      <View style={styles.sheetSection}>
        <DropdownMenu
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
        >
          <DropdownMenuTrigger
            disabled={disabled}
            style={togglePressableStyle}
            accessibilityRole="button"
            accessibilityLabel={getFeatureTooltip(feature)}
            testID={`agent-feature-${feature.id}`}
          >
            <Text style={styles.sheetSelectText}>{selectedOption?.label ?? feature.label}</Text>
            <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            {feature.options.map((option) => (
              <FeatureOptionMenuItem
                key={option.id}
                option={option}
                selected={option.id === feature.value}
                onSelect={handleSelectOption}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    );
  }

  return null;
}

function FeatureOptionMenuItem({
  option,
  selected,
  onSelect,
}: {
  option: { id: string; label: string };
  selected: boolean;
  onSelect: (optionId: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(option.id);
  }, [onSelect, option.id]);

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {option.label}
    </DropdownMenuItem>
  );
}

function AuthProfileAutoMenuItem({
  selected,
  onSelectAuthProfile,
}: {
  selected: boolean;
  onSelectAuthProfile?: (authProfileKey: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelectAuthProfile?.("");
  }, [onSelectAuthProfile]);

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      Default account
    </DropdownMenuItem>
  );
}

function AuthProfileMenuItem({
  profile,
  selected,
  onSelectAuthProfile,
}: {
  profile: ProviderAuthProfile;
  selected: boolean;
  onSelectAuthProfile?: (authProfileKey: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelectAuthProfile?.(profile.key);
  }, [onSelectAuthProfile, profile.key]);

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {formatAuthProfileLabel(profile)}
    </DropdownMenuItem>
  );
}

function ThinkingMenuItem({
  thinking,
  selected,
  onSelectThinkingOption,
}: {
  thinking: StatusOption;
  selected: boolean;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelectThinkingOption?.(thinking.id);
  }, [onSelectThinkingOption, thinking.id]);

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {thinking.label}
    </DropdownMenuItem>
  );
}

function ModeComboboxOption({
  option,
  selected,
  active,
  onPress,
  provider,
  providerDefinitions,
  iconColor,
}: {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  provider: string;
  providerDefinitions: AgentProviderDefinition[];
  iconColor: string;
}) {
  const visuals = getModeVisuals(provider, option.id, providerDefinitions);
  const IconComponent = visuals?.icon ? MODE_ICONS[visuals.icon] : ShieldCheck;
  const leadingSlot = useMemo(
    () => <IconComponent size={16} color={iconColor} />,
    [IconComponent, iconColor],
  );
  return (
    <ComboboxItem
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ModeMenuItem({
  mode,
  provider,
  providerDefinitions,
  selected,
  onSelectMode,
}: {
  mode: StatusOption;
  provider: string;
  providerDefinitions: AgentProviderDefinition[];
  selected: boolean;
  onSelectMode?: (modeId: string) => void;
}) {
  const { theme } = useUnistyles();
  const visuals = getModeVisuals(provider, mode.id, providerDefinitions);
  const Icon = visuals?.icon ? MODE_ICONS[visuals.icon] : ShieldCheck;

  const handleSelect = useCallback(() => {
    onSelectMode?.(mode.id);
  }, [mode.id, onSelectMode]);

  const leadingIcon = useMemo(
    () => <Icon size={16} color={theme.colors.foreground} />,
    [Icon, theme.colors.foreground],
  );

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} leading={leadingIcon}>
      {mode.label}
    </DropdownMenuItem>
  );
}

const EMPTY_MODES: AgentMode[] = [];
const AUTH_PROFILE_RESTART_SNAP_POINTS = ["42%", "70%"];

function useActiveAuthProfileRestartController(options: {
  agentId: string;
  authProfiles: ProviderAuthProfile[];
  selectedAuthProfileKey: string | undefined;
  client: AuthProfileRestartClient | null;
  toast: ReturnType<typeof useToast>;
}) {
  const { agentId, authProfiles, selectedAuthProfileKey, client, toast } = options;
  const [pending, setPending] = useState<PendingAuthProfileRestart | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);

  const requestRestart = useCallback(
    (authProfileKey: string) => {
      if (!client) {
        return;
      }
      const normalizedNextKey = normalizeAuthProfileSelection(authProfileKey);
      const normalizedCurrentKey = normalizeAuthProfileSelection(selectedAuthProfileKey);
      if (normalizedNextKey === normalizedCurrentKey) {
        return;
      }
      setPending({
        key: normalizedNextKey,
        label: resolveAuthProfileRestartLabel(authProfiles, normalizedNextKey),
      });
    },
    [authProfiles, client, selectedAuthProfileKey],
  );

  const close = useCallback(() => {
    if (isRestarting) {
      return;
    }
    setPending(null);
  }, [isRestarting]);

  const confirm = useCallback(() => {
    if (!client || !pending) {
      return;
    }
    const nextKey = pending.key;
    const nextLabel = pending.label;
    setIsRestarting(true);
    void (async () => {
      try {
        await client.restartAgentWithAuthProfile(agentId, nextKey);
        toast.show(`Restarting agent with ${nextLabel}`, { variant: "success" });
      } catch (error) {
        console.warn("[AgentStatusBar] restartAgentWithAuthProfile failed", error);
        toast.error(toErrorMessage(error));
      } finally {
        setIsRestarting(false);
        setPending(null);
      }
    })();
  }, [agentId, client, pending, toast]);

  return {
    pending,
    isRestarting,
    requestRestart,
    close,
    confirm,
  };
}

function useActiveRuntimeProfileRestartController(options: {
  agentId: string;
  runtimeProfiles: RuntimeProfile[];
  selectedRuntimeProfileId: string | undefined;
  selectedRuntimeProfileVersion: number | undefined;
  client: RuntimeProfileRestartClient | null;
  toast: ReturnType<typeof useToast>;
}) {
  const {
    agentId,
    runtimeProfiles,
    selectedRuntimeProfileId,
    selectedRuntimeProfileVersion,
    client,
    toast,
  } = options;
  const [pending, setPending] = useState<PendingRuntimeProfileRestart | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [progress, setProgress] = useState<RuntimeProfileRestartProgress>({
    phase: "idle",
    label: "",
  });
  const [expectedSnapshot, setExpectedSnapshot] = useState<{
    id: string | null;
    version?: number;
    label: string;
  } | null>(null);

  const requestRestart = useCallback(
    (runtimeProfileId: string) => {
      if (!client) {
        return;
      }
      const normalizedNextId = normalizeRuntimeProfileSelection(runtimeProfileId);
      const normalizedCurrentId = normalizeRuntimeProfileSelection(selectedRuntimeProfileId);
      if (normalizedNextId === normalizedCurrentId) {
        if (!normalizedNextId) {
          return;
        }
        const latestProfile = runtimeProfiles.find((profile) => profile.id === normalizedNextId);
        if (
          latestProfile?.version === undefined ||
          latestProfile.version === selectedRuntimeProfileVersion
        ) {
          return;
        }
      }
      setPending({
        id: normalizedNextId,
        label: resolveRuntimeProfileRestartLabel(runtimeProfiles, normalizedNextId),
      });
    },
    [client, runtimeProfiles, selectedRuntimeProfileId, selectedRuntimeProfileVersion],
  );

  const close = useCallback(() => {
    if (isRestarting) {
      return;
    }
    setPending(null);
    if (progress.phase === "failed") {
      setProgress({ phase: "idle", label: "" });
    }
  }, [isRestarting, progress.phase]);

  const confirm = useCallback(
    (acceptRuntimeWarnings = false) => {
      if (!client || !pending) {
        return;
      }
      const nextId = pending.id;
      const nextLabel = pending.label;
      const latestProfile = runtimeProfiles.find((profile) => profile.id === nextId);
      setIsRestarting(true);
      setProgress({ phase: "restarting", label: nextLabel });
      void (async () => {
        try {
          await client.restartAgentWithRuntimeProfile(agentId, nextId, undefined, {
            acceptRuntimeWarnings,
          });
          setPending(null);
          setExpectedSnapshot({
            id: nextId,
            version: latestProfile?.version,
            label: nextLabel,
          });
          setProgress({ phase: "waiting", label: nextLabel });
        } catch (error) {
          const warnings = getRuntimeLaunchWarnings(error);
          if (warnings && warnings.length > 0 && !acceptRuntimeWarnings) {
            setPending({ id: nextId, label: nextLabel, warnings });
            setProgress({ phase: "idle", label: "" });
            return;
          }
          console.warn("[AgentStatusBar] restartAgentWithRuntimeProfile failed", error);
          setProgress({ phase: "failed", label: nextLabel, error: toErrorMessage(error) });
          toast.error(toErrorMessage(error));
        } finally {
          setIsRestarting(false);
        }
      })();
    },
    [agentId, client, pending, runtimeProfiles, toast],
  );

  useEffect(() => {
    if (!expectedSnapshot || progress.phase !== "waiting") {
      return;
    }
    const expectedId = normalizeRuntimeProfileSelection(expectedSnapshot.id);
    const currentId = normalizeRuntimeProfileSelection(selectedRuntimeProfileId);
    if (expectedId !== currentId) {
      return;
    }
    if (
      expectedSnapshot.version !== undefined &&
      expectedSnapshot.version !== selectedRuntimeProfileVersion
    ) {
      return;
    }
    toast.show(`Agent restarted with ${expectedSnapshot.label}`, { variant: "success" });
    setExpectedSnapshot(null);
    setProgress({ phase: "idle", label: "" });
  }, [
    expectedSnapshot,
    progress.phase,
    selectedRuntimeProfileId,
    selectedRuntimeProfileVersion,
    toast,
  ]);

  return {
    pending,
    isRestarting,
    progress,
    requestRestart,
    close,
    confirm,
  };
}

function AuthProfileRestartConfirmationSheet({
  pending,
  isRestarting,
  onClose,
  onConfirm,
}: {
  pending: PendingAuthProfileRestart | null;
  isRestarting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const restartTargetLabel = pending?.label ?? "Selected account";
  const secondaryButtonStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.restartConfirmButton,
      styles.restartConfirmSecondaryButton,
      pressed && styles.restartConfirmButtonPressed,
      isRestarting && styles.disabledBadge,
    ],
    [isRestarting],
  );
  const primaryButtonStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.restartConfirmButton,
      styles.restartConfirmPrimaryButton,
      pressed && styles.restartConfirmPrimaryButtonPressed,
      isRestarting && styles.disabledBadge,
    ],
    [isRestarting],
  );

  return (
    <AdaptiveModalSheet
      title="Restart agent with account"
      visible={pending !== null}
      onClose={onClose}
      snapPoints={AUTH_PROFILE_RESTART_SNAP_POINTS}
      desktopMaxWidth={420}
      testID="agent-auth-profile-restart-confirmation"
    >
      <View style={styles.restartConfirmContent}>
        <Text style={styles.restartConfirmText}>
          Switch this agent to {restartTargetLabel}. Any running turn will stop and the provider
          process will restart with the selected account.
        </Text>
        <View style={styles.restartConfirmActions}>
          <Pressable
            accessibilityRole="button"
            disabled={isRestarting}
            onPress={onClose}
            style={secondaryButtonStyle}
          >
            <Text style={styles.restartConfirmSecondaryText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={isRestarting}
            onPress={onConfirm}
            style={primaryButtonStyle}
          >
            <Text style={styles.restartConfirmPrimaryText}>
              {isRestarting ? "Restarting..." : "Restart"}
            </Text>
          </Pressable>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function RuntimeProfileRestartConfirmationSheet({
  pending,
  isRestarting,
  progress,
  onClose,
  onConfirm,
}: {
  pending: PendingRuntimeProfileRestart | null;
  isRestarting: boolean;
  progress: RuntimeProfileRestartProgress;
  onClose: () => void;
  onConfirm: (acceptRuntimeWarnings?: boolean) => void;
}) {
  const restartTargetLabel = pending?.label ?? "Selected profile";
  const hasWarnings = Boolean(pending?.warnings?.length);
  const isProgressVisible = progress.phase !== "idle";
  const visible = pending !== null || isProgressVisible;
  const primaryButtonLabel = useMemo(() => {
    if (isRestarting) {
      return "Restarting...";
    }
    if (hasWarnings) {
      return "Restart anyway";
    }
    return "Restart";
  }, [hasWarnings, isRestarting]);
  const secondaryButtonStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.restartConfirmButton,
      styles.restartConfirmSecondaryButton,
      pressed && styles.restartConfirmButtonPressed,
      isRestarting && styles.disabledBadge,
    ],
    [isRestarting],
  );
  const primaryButtonStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.restartConfirmButton,
      styles.restartConfirmPrimaryButton,
      pressed && styles.restartConfirmPrimaryButtonPressed,
      isRestarting && styles.disabledBadge,
    ],
    [isRestarting],
  );
  const handleConfirmPress = useCallback(() => {
    onConfirm(hasWarnings);
  }, [hasWarnings, onConfirm]);

  return (
    <AdaptiveModalSheet
      title="Restart agent with profile"
      visible={visible}
      onClose={onClose}
      snapPoints={AUTH_PROFILE_RESTART_SNAP_POINTS}
      desktopMaxWidth={420}
      testID="agent-runtime-profile-restart-confirmation"
    >
      <View style={styles.restartConfirmContent}>
        {progress.phase === "restarting" || progress.phase === "waiting" ? (
          <View style={styles.restartProgressRow}>
            <ActivityIndicator size="small" />
            <Text style={styles.restartConfirmText}>
              {progress.phase === "restarting"
                ? `Restarting with ${progress.label}...`
                : `Waiting for ${progress.label} to become active...`}
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.restartConfirmText}>
              {hasWarnings
                ? "Another active agent is already using this profile or account."
                : `Switch this agent to ${restartTargetLabel}. Any running turn will stop and the provider process will restart with the selected runtime profile.`}
            </Text>
            {pending?.warnings?.map((warning) => (
              <Text key={warning.message} style={styles.restartWarningText}>
                {warning.message}
              </Text>
            ))}
            {progress.phase === "failed" && progress.error ? (
              <Text style={styles.restartErrorText}>{progress.error}</Text>
            ) : null}
            <View style={styles.restartConfirmActions}>
              <Pressable
                accessibilityRole="button"
                disabled={isRestarting}
                onPress={onClose}
                style={secondaryButtonStyle}
              >
                <Text style={styles.restartConfirmSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={isRestarting || !pending}
                onPress={handleConfirmPress}
                style={primaryButtonStyle}
              >
                <Text style={styles.restartConfirmPrimaryText}>{primaryButtonLabel}</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

export const AgentStatusBar = memo(function AgentStatusBar({
  agentId,
  serverId,
  onDropdownClose,
}: AgentStatusBarProps) {
  const { preferences, updatePreferences } = useFormPreferences();
  const agent = useSessionStore(
    useShallow((state) => selectAgentStatusBarSlice(state, serverId, agentId)),
  );
  const availableModes = useStoreWithEqualityFn(
    useSessionStore,
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.availableModes ?? EMPTY_MODES,
    compareAvailableModes,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const toast = useToast();

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    refetchIfStale: refetchSnapshotIfStale,
  } = useProvidersSnapshot(serverId);
  const agentProvider = agent?.provider;
  const authProfileState = useAgentStatusBarAuthProfileState(serverId, agent);
  const runtimeProfileState = useAgentStatusBarRuntimeProfileState(serverId, agent);
  const authProfileRestart = useActiveAuthProfileRestartController({
    agentId,
    authProfiles: authProfileState.authProfiles,
    selectedAuthProfileKey: authProfileState.selectedAuthProfileKey,
    client,
    toast,
  });
  const runtimeProfileRestart = useActiveRuntimeProfileRestartController({
    agentId,
    runtimeProfiles: runtimeProfileState.runtimeProfiles,
    selectedRuntimeProfileId: runtimeProfileState.selectedRuntimeProfileId,
    selectedRuntimeProfileVersion: runtimeProfileState.selectedRuntimeProfileVersion,
    client,
    toast,
  });

  const snapshotSelectedEntry = useMemo(
    () => resolveSnapshotSelectedEntry(snapshotEntries, agent?.provider),
    [snapshotEntries, agent?.provider],
  );

  const models = snapshotSelectedEntry?.models ?? null;
  const selectedProviderIsLoading = snapshotSelectedEntry?.status === "loading";

  const agentProviderDefinitions = useMemo(
    () => buildAgentProviderDefinitions(agent?.provider, snapshotEntries),
    [agent?.provider, snapshotEntries],
  );

  const agentProviderModels = useMemo(
    () => buildAgentProviderModels(agent?.provider, models),
    [agent?.provider, models],
  );

  const displayMode = resolveAgentDisplayMode(availableModes, agent?.currentModeId);

  const modelSelection = resolveAgentModelSelection({
    models,
    runtimeModelId: agent?.runtimeModelId,
    configuredModelId: agent?.model,
    explicitThinkingOptionId: agent?.thinkingOptionId,
  });

  const modeOptions = useMemo<StatusOption[]>(() => {
    return availableModes.map((mode) => ({
      id: mode.id,
      label: mode.label,
    }));
  }, [availableModes]);

  const modelOptions = useMemo<StatusOption[]>(() => {
    return (models ?? []).map((model) => ({
      id: model.id,
      label: model.label,
    }));
  }, [models]);
  const favoriteKeys = useMemo(
    () =>
      new Set(
        (preferences.favoriteModels ?? []).map((favorite) => buildFavoriteModelKey(favorite)),
      ),
    [preferences.favoriteModels],
  );

  const thinkingOptions = useMemo<StatusOption[]>(() => {
    return (modelSelection.thinkingOptions ?? []).map((option) => ({
      id: option.id,
      label: option.label,
    }));
  }, [modelSelection.thinkingOptions]);

  const activeModelId = modelSelection.activeModelId;

  const handleSelectMode = useCallback(
    (modeId: string) => {
      if (!client) {
        return;
      }
      void client.setAgentMode(agentId, modeId).catch((error) => {
        console.warn("[AgentStatusBar] setAgentMode failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, client, toast],
  );

  const handleSelectModel = useCallback(
    (modelId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider: agentProvider,
          updates: {
            model: modelId,
          },
        }),
      ).catch((error) => {
        console.warn("[AgentStatusBar] persist model preference failed", error);
      });
      void client.setAgentModel(agentId, modelId).catch((error) => {
        console.warn("[AgentStatusBar] setAgentModel failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, agentProvider, client, toast, updatePreferences],
  );

  const handleToggleFavoriteModel = useCallback(
    (provider: string, modelId: string) => {
      void updatePreferences((current) =>
        toggleFavoriteModel({ preferences: current, provider, modelId }),
      ).catch((error) => {
        console.warn("[AgentStatusBar] toggle favorite model failed", error);
      });
    },
    [updatePreferences],
  );

  const handleSelectThinkingOption = useCallback(
    (thinkingOptionId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      if (activeModelId) {
        void updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: {
              model: activeModelId,
              thinkingByModel: {
                [activeModelId]: thinkingOptionId,
              },
            },
          }),
        ).catch((error) => {
          console.warn("[AgentStatusBar] persist thinking preference failed", error);
        });
      }
      void client.setAgentThinkingOption(agentId, thinkingOptionId).catch((error) => {
        console.warn("[AgentStatusBar] setAgentThinkingOption failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [activeModelId, agentId, agentProvider, client, toast, updatePreferences],
  );

  const handleSetFeature = useCallback(
    (featureId: string, value: unknown) => {
      if (!client || !agentProvider) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider: agentProvider,
          updates: {
            featureValues: {
              [featureId]: value,
            },
          },
        }),
      ).catch((error) => {
        console.warn("[AgentStatusBar] persist feature preference failed", error);
      });
      void client.setAgentFeature(agentId, featureId, value).catch((error) => {
        console.warn("[AgentStatusBar] setAgentFeature failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, agentProvider, client, toast, updatePreferences],
  );

  const handleModelSelectorOpen = useCallback(() => {
    refetchSnapshotIfStale(agentProvider);
  }, [agentProvider, refetchSnapshotIfStale]);

  const handleEditRuntimeProfiles = useCallback(() => {
    router.push(buildSettingsHostRoute(serverId));
  }, [serverId]);

  const fallbackModeOptions = useMemo<StatusOption[]>(
    () =>
      modeOptions.length > 0
        ? modeOptions
        : [{ id: agent?.currentModeId ?? "", label: displayMode }],
    [agent?.currentModeId, displayMode, modeOptions],
  );
  const statusBarDisabled = resolveAgentStatusBarDisabled({
    client,
    isAuthProfileRestarting: authProfileRestart.isRestarting,
    isRuntimeProfileRestarting: runtimeProfileRestart.isRestarting,
  });

  if (!agent) {
    return null;
  }

  return (
    <>
      <ControlledStatusBar
        provider={agent.provider}
        modeOptions={fallbackModeOptions}
        selectedModeId={agent.currentModeId ?? undefined}
        providerDefinitions={agentProviderDefinitions}
        allProviderModels={agentProviderModels}
        onSelectMode={handleSelectMode}
        modelOptions={modelOptions}
        selectedModelId={modelSelection.activeModelId ?? undefined}
        onSelectModel={handleSelectModel}
        favoriteKeys={favoriteKeys}
        onToggleFavoriteModel={handleToggleFavoriteModel}
        thinkingOptions={thinkingOptions.length > 1 ? thinkingOptions : undefined}
        selectedThinkingOptionId={modelSelection.selectedThinkingId ?? undefined}
        onSelectThinkingOption={handleSelectThinkingOption}
        features={agent.features}
        onSetFeature={handleSetFeature}
        authProfiles={authProfileState.authProfiles}
        selectedAuthProfileKey={authProfileState.selectedAuthProfileKey}
        onSelectAuthProfile={authProfileRestart.requestRestart}
        isAuthProfilesLoading={authProfileState.isAuthProfilesLoading}
        runtimeProfiles={runtimeProfileState.runtimeProfiles}
        selectedRuntimeProfileId={runtimeProfileState.selectedRuntimeProfileId}
        selectedRuntimeProfileVersion={runtimeProfileState.selectedRuntimeProfileVersion}
        onSelectRuntimeProfile={runtimeProfileRestart.requestRestart}
        isRuntimeProfilesLoading={runtimeProfileState.isRuntimeProfilesLoading}
        allowAdHocRuntimeProfile={true}
        isModelLoading={snapshotIsLoading || selectedProviderIsLoading}
        onModelSelectorOpen={handleModelSelectorOpen}
        onDropdownClose={onDropdownClose}
        onEditRuntimeProfiles={handleEditRuntimeProfiles}
        disabled={statusBarDisabled}
      />
      <AuthProfileRestartConfirmationSheet
        pending={authProfileRestart.pending}
        isRestarting={authProfileRestart.isRestarting}
        onClose={authProfileRestart.close}
        onConfirm={authProfileRestart.confirm}
      />
      <RuntimeProfileRestartConfirmationSheet
        pending={runtimeProfileRestart.pending}
        isRestarting={runtimeProfileRestart.isRestarting}
        progress={runtimeProfileRestart.progress}
        onClose={runtimeProfileRestart.close}
        onConfirm={runtimeProfileRestart.confirm}
      />
    </>
  );
});

export function DraftAgentStatusBar({
  providerDefinitions,
  selectedProvider,
  onSelectProvider: _onSelectProvider,
  modeOptions,
  selectedMode,
  onSelectMode,
  models,
  selectedModel,
  onSelectModel,
  authProfiles,
  selectedAuthProfileKey,
  onSelectAuthProfile,
  isAuthProfilesLoading,
  runtimeProfiles = EMPTY_RUNTIME_PROFILES,
  selectedRuntimeProfileId,
  onSelectRuntimeProfile,
  isRuntimeProfilesLoading,
  allowAdHocRuntimeProfile = true,
  isModelLoading: _isModelLoading,
  allProviderModels,
  isAllModelsLoading,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  features,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
  onEditRuntimeProfiles,
  disabled = false,
}: DraftAgentStatusBarProps) {
  const { preferences, updatePreferences } = useFormPreferences();

  const mappedModeOptions = useMemo<StatusOption[]>(() => {
    if (modeOptions.length === 0) {
      return [{ id: "", label: "Default" }];
    }
    return modeOptions.map((mode) => ({
      id: mode.id,
      label: mode.label,
    }));
  }, [modeOptions]);

  const mappedThinkingOptions = useMemo<StatusOption[]>(() => {
    return thinkingOptions.map((option) => ({
      id: option.id,
      label: option.label,
    }));
  }, [thinkingOptions]);
  const favoriteKeys = useMemo(
    () =>
      new Set(
        (preferences.favoriteModels ?? []).map((favorite) => buildFavoriteModelKey(favorite)),
      ),
    [preferences.favoriteModels],
  );

  const effectiveSelectedMode = selectedMode || mappedModeOptions[0]?.id || "";
  const effectiveSelectedThinkingOption =
    selectedThinkingOptionId || mappedThinkingOptions[0]?.id || undefined;
  const hasSelectedProvider = selectedProvider !== null;

  const modelOptions = useMemo<StatusOption[]>(
    () =>
      models.map((model) => ({
        id: model.id,
        label: model.label,
      })),
    [models],
  );

  const handleToggleFavorite = useCallback(
    (provider: string, modelId: string) => {
      void updatePreferences((current) =>
        toggleFavoriteModel({ preferences: current, provider, modelId }),
      ).catch((error) => {
        console.warn("[DraftAgentStatusBar] toggle favorite model failed", error);
      });
    },
    [updatePreferences],
  );

  return (
    <ControlledStatusBar
      provider={selectedProvider ?? ""}
      providerDefinitions={providerDefinitions}
      allProviderModels={allProviderModels}
      modeOptions={hasSelectedProvider ? mappedModeOptions : undefined}
      selectedModeId={effectiveSelectedMode}
      onSelectMode={onSelectMode}
      modelOptions={modelOptions}
      selectedModelId={selectedModel}
      onSelectModel={onSelectModel}
      onSelectProviderAndModel={onSelectProviderAndModel}
      authProfiles={authProfiles}
      selectedAuthProfileKey={selectedAuthProfileKey}
      onSelectAuthProfile={onSelectAuthProfile}
      isAuthProfilesLoading={isAuthProfilesLoading}
      runtimeProfiles={runtimeProfiles}
      selectedRuntimeProfileId={selectedRuntimeProfileId}
      onSelectRuntimeProfile={onSelectRuntimeProfile}
      isRuntimeProfilesLoading={isRuntimeProfilesLoading}
      allowAdHocRuntimeProfile={allowAdHocRuntimeProfile}
      isModelLoading={isAllModelsLoading}
      favoriteKeys={favoriteKeys}
      onToggleFavoriteModel={handleToggleFavorite}
      thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
      selectedThinkingOptionId={effectiveSelectedThinkingOption}
      onSelectThinkingOption={onSelectThinkingOption}
      features={features}
      onSetFeature={onSetFeature}
      onDropdownClose={onDropdownClose}
      onModelSelectorOpen={onModelSelectorOpen}
      onEditRuntimeProfiles={onEditRuntimeProfiles}
      disabled={disabled}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[1],
  },
  modeBadge: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  modeIconBadge: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
    borderRadius: theme.borderRadius.full,
  },
  modeBadgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  disabledBadge: {
    opacity: 0.5,
  },
  modeBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  prefsButton: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  prefsIconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  prefsButtonPressed: {
    backgroundColor: theme.colors.surface0,
  },
  prefsButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 1,
  },
  sheetSection: {
    gap: theme.spacing[2],
  },
  sheetSelect: {
    width: "100%",
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
  },
  sheetSelectPressed: {
    backgroundColor: theme.colors.surface2,
  },
  disabledSheetSelect: {
    opacity: 0.5,
  },
  sheetSelectText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  sheetSelectValueText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textAlign: "right",
  },
  profileDetailsSection: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
  },
  profileDetailsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  profileDetailsTitleGroup: {
    minWidth: 0,
    flex: 1,
    gap: theme.spacing[1],
  },
  profileDetailsTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  profileDetailsName: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  profileDetailsRow: {
    minHeight: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  profileDetailsLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  profileDetailsValue: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textAlign: "right",
  },
  profileUpdateCallout: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.palette.amber[500],
    backgroundColor: theme.colors.surface1,
  },
  profileUpdateText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  profileApplyButton: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.foreground,
  },
  profileApplyButtonText: {
    color: theme.colors.background,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  profileEditButton: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  profileEditButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  restartConfirmContent: {
    gap: theme.spacing[4],
  },
  restartConfirmText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.45,
  },
  restartProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  restartWarningText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  restartErrorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  restartConfirmActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[3],
  },
  restartConfirmButton: {
    minHeight: 40,
    minWidth: 96,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
  },
  restartConfirmSecondaryButton: {
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.surface2,
  },
  restartConfirmPrimaryButton: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  restartConfirmButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  restartConfirmPrimaryButtonPressed: {
    opacity: 0.9,
  },
  restartConfirmSecondaryText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  restartConfirmPrimaryText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));
