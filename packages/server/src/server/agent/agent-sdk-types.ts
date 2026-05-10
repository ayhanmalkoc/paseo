import type { Options as ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAttachment } from "../../shared/messages.js";

export type AgentProvider = string;

export interface AgentMetadata {
  [key: string]: unknown;
}

/**
 * Stdio-based MCP server (spawns a subprocess).
 */
export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * HTTP-based MCP server.
 */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * SSE-based MCP server (Server-Sent Events over HTTP).
 */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Canonical MCP server configuration.
 * Discriminated union by `type` field.
 * Each provider normalizes this to their expected format.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  colorTier?: string;
}

export type ProviderStatus = "ready" | "loading" | "error" | "unavailable";

export interface AgentModelDefinition {
  provider: AgentProvider;
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
  thinkingOptions?: AgentSelectOption[];
  defaultThinkingOptionId?: string;
}

export interface AgentSelectOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
}

export interface ProviderSnapshotEntry {
  provider: AgentProvider;
  status: ProviderStatus;
  enabled: boolean;
  error?: string;
  models?: AgentModelDefinition[];
  modes?: AgentMode[];
  fetchedAt?: string;
  label?: string;
  description?: string;
  defaultModeId?: string | null;
}

export type ProviderAuthStatus = "ready" | "needs-login" | "invalid" | "refreshing";
export type ProviderAuthMode = "chatgpt" | "api-key" | "oauth" | "external" | "unknown";

export interface ProviderAuthUsageSnapshot {
  source: "local-rollout" | "provider-api";
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
  creditsRemaining?: number;
  refreshedAt: string;
}

export interface ProviderAuthProfile {
  provider: AgentProvider;
  key: string;
  alias: string;
  email?: string;
  accountName?: string;
  accountId?: string;
  userId?: string;
  authMode: ProviderAuthMode;
  plan?: string;
  status: ProviderAuthStatus;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  usage?: ProviderAuthUsageSnapshot;
}

export type ProviderAccount = ProviderAuthProfile;

export type AccountLoginMethod = "chatgpt-device-code" | "chatgpt-browser" | "api-key";

export type AccountLoginStatus =
  | "starting"
  | "pending-user"
  | "importing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface AccountLoginSession {
  id: string;
  provider: AgentProvider;
  method: AccountLoginMethod;
  status: AccountLoginStatus;
  verificationUrl?: string;
  userCode?: string;
  account?: ProviderAccount;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export type RuntimeProfileConcurrencyPolicy = "allow" | "warn" | "single-active";
export type RuntimeProfileSessionBehavior = "continue" | "fresh";

export interface RuntimeProfile {
  id: string;
  version: number;
  name: string;
  provider: AgentProvider;
  accountKey?: string | null;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  instructionOverlay?: string | null;
  systemPrompt?: string | null;
  featureValues?: Record<string, unknown>;
  envOverlay?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  concurrencyPolicy: RuntimeProfileConcurrencyPolicy;
  sessionBehavior?: RuntimeProfileSessionBehavior;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeProfilePatch = Partial<
  Pick<
    RuntimeProfile,
    | "name"
    | "provider"
    | "accountKey"
    | "model"
    | "modeId"
    | "thinkingOptionId"
    | "instructionOverlay"
    | "systemPrompt"
    | "featureValues"
    | "envOverlay"
    | "mcpServers"
    | "concurrencyPolicy"
    | "sessionBehavior"
  >
>;

export type RuntimeProfileLaunchOverrides = Partial<
  Pick<
    RuntimeProfile,
    | "accountKey"
    | "model"
    | "modeId"
    | "thinkingOptionId"
    | "instructionOverlay"
    | "systemPrompt"
    | "featureValues"
    | "envOverlay"
    | "mcpServers"
    | "sessionBehavior"
  >
>;

export interface AgentProfileSnapshot {
  sourceProfileId?: string;
  sourceProfileVersion?: number;
  sourceProfileName?: string;
  provider: AgentProvider;
  accountKey?: string | null;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  instructionOverlay?: string | null;
  systemPrompt?: string | null;
  featureValues?: Record<string, unknown>;
  envOverlay?: Record<string, string>;
  concurrencyPolicy?: RuntimeProfileConcurrencyPolicy;
  sessionBehavior?: RuntimeProfileSessionBehavior;
  resolvedAt: string;
}

export interface RuntimeLaunchWarning {
  code:
    | "account-in-use"
    | "runtime-profile-in-use"
    | "missing-account"
    | "invalid-account"
    | "provider-unavailable";
  message: string;
  accountKey?: string | null;
  runtimeProfileId?: string | null;
  agentIds?: string[];
}

export interface AgentFeatureToggle {
  type: "toggle";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  value: boolean;
}

export interface AgentFeatureSelect {
  type: "select";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  value: string | null;
  options: AgentSelectOption[];
}

export type AgentFeature = AgentFeatureToggle | AgentFeatureSelect;

export interface AgentCapabilityFlags {
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
}

export interface AgentPersistenceHandle {
  provider: AgentProvider;
  sessionId: string;
  /** Provider specific handle (Codex thread id, Claude resume token, etc). */
  nativeHandle?: string;
  metadata?: AgentMetadata;
}

export type PersistedAgentSourceKind = "native-default" | "auth-profile";

export interface PersistedAgentSource {
  kind: PersistedAgentSourceKind;
  authProfileKey?: string | null;
  label?: string | null;
}

export type AgentPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | AgentAttachment;

export type AgentPromptInput = string | AgentPromptContentBlock[];

export interface AgentRunOptions {
  outputSchema?: unknown;
  resumeFrom?: AgentPersistenceHandle;
  maxThinkingTokens?: number;
}

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export const TOOL_CALL_ICON_NAMES = [
  "wrench",
  "square_terminal",
  "eye",
  "pencil",
  "search",
  "bot",
  "sparkles",
  "brain",
  "mic_vocal",
] as const;

export type ToolCallIconName = (typeof TOOL_CALL_ICON_NAMES)[number];

export type ToolCallDetail =
  | {
      type: "shell";
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
    }
  | {
      type: "read";
      filePath: string;
      content?: string;
      offset?: number;
      limit?: number;
    }
  | {
      type: "edit";
      filePath: string;
      oldString?: string;
      newString?: string;
      unifiedDiff?: string;
    }
  | {
      type: "write";
      filePath: string;
      content?: string;
    }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: Array<{
        title: string;
        url: string;
      }>;
      annotations?: string[];
      numFiles?: number;
      numMatches?: number;
      durationMs?: number;
      durationSeconds?: number;
      truncated?: boolean;
      mode?: "content" | "files_with_matches" | "count";
    }
  | {
      type: "fetch";
      url: string;
      prompt?: string;
      result?: string;
      code?: number;
      codeText?: string;
      bytes?: number;
      durationMs?: number;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
      log: string;
      commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
      }>;
      truncated?: boolean;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      log: string;
      actions?: Array<{
        index: number;
        toolName: string;
        summary?: string;
      }>;
    }
  | {
      type: "plain_text";
      label?: string;
      text?: string;
      icon?: ToolCallIconName;
    }
  | {
      type: "plan";
      text: string;
    }
  | {
      type: "unknown";
      input: unknown;
      output: unknown;
    };

interface ToolCallBase {
  [key: string]: unknown;
  type: "tool_call";
  callId: string;
  name: string;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
}

type ToolCallRunningTimelineItem = ToolCallBase & {
  status: "running";
  error: null;
};

type ToolCallCompletedTimelineItem = ToolCallBase & {
  status: "completed";
  error: null;
};

type ToolCallFailedTimelineItem = ToolCallBase & {
  status: "failed";
  error: unknown;
};

type ToolCallCanceledTimelineItem = ToolCallBase & {
  status: "canceled";
  error: null;
};

export type ToolCallTimelineItem =
  | ToolCallRunningTimelineItem
  | ToolCallCompletedTimelineItem
  | ToolCallFailedTimelineItem
  | ToolCallCanceledTimelineItem;

export interface CompactionTimelineItem {
  [key: string]: unknown;
  type: "compaction";
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string }
  | CompactionTimelineItem;

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string; provider: AgentProvider }
  | { type: "turn_started"; provider: AgentProvider; turnId?: string }
  | { type: "turn_completed"; provider: AgentProvider; usage?: AgentUsage; turnId?: string }
  | { type: "usage_updated"; provider: AgentProvider; usage: AgentUsage; turnId?: string }
  | {
      type: "mode_changed";
      provider: AgentProvider;
      currentModeId: string | null;
      availableModes: AgentMode[];
    }
  | { type: "model_changed"; provider: AgentProvider; runtimeInfo: AgentRuntimeInfo }
  | {
      type: "thinking_option_changed";
      provider: AgentProvider;
      thinkingOptionId: string | null;
    }
  | {
      type: "turn_failed";
      provider: AgentProvider;
      error: string;
      code?: string;
      diagnostic?: string;
      turnId?: string;
    }
  | { type: "turn_canceled"; provider: AgentProvider; reason: string; turnId?: string }
  | { type: "timeline"; item: AgentTimelineItem; provider: AgentProvider; turnId?: string }
  | {
      type: "permission_requested";
      provider: AgentProvider;
      request: AgentPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: AgentProvider;
      requestId: string;
      resolution: AgentPermissionResponse;
      turnId?: string;
    }
  | {
      type: "attention_required";
      provider: AgentProvider;
      reason: "finished" | "error" | "permission";
      timestamp: string;
    };

export type AgentPermissionRequestKind = "tool" | "plan" | "question" | "mode" | "other";

export type AgentPermissionUpdate = AgentMetadata;

export interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
  intent?: "implement" | "implement_resume" | "dismiss";
}

export interface AgentPermissionRequest {
  id: string;
  provider: AgentProvider;
  name: string;
  kind: AgentPermissionRequestKind;
  title?: string;
  description?: string;
  input?: AgentMetadata;
  detail?: ToolCallDetail;
  suggestions?: AgentPermissionUpdate[];
  actions?: AgentPermissionAction[];
  metadata?: AgentMetadata;
}

export type AgentPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: AgentMetadata;
      updatedPermissions?: AgentPermissionUpdate[];
    }
  | {
      behavior: "deny";
      selectedActionId?: string;
      message?: string;
      interrupt?: boolean;
    };

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
  canceled?: boolean;
}

export interface AgentRuntimeInfo {
  provider: AgentProvider;
  sessionId: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  modeId?: string | null;
  extra?: AgentMetadata;
}

/**
 * Represents a slash command available in an agent session.
 * Commands are executed by sending them as prompts with / prefix.
 */
export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface ListPersistedAgentsOptions {
  limit?: number;
  /**
   * Optional cwd hint. Providers that can cheaply pre-filter persisted
   * sessions by working directory should do so before doing expensive
   * work like fetching turn timelines. Providers that can't filter
   * cheaply may ignore this hint.
   */
  cwd?: string;
  launchContext?: AgentLaunchContext;
  source?: PersistedAgentSource;
}

export interface PersistedAgentDescriptor {
  provider: AgentProvider;
  sessionId: string;
  cwd: string;
  title: string | null;
  lastActivityAt: Date;
  persistence: AgentPersistenceHandle;
  timeline: AgentTimelineItem[];
  source?: PersistedAgentSource;
}

export interface AgentSessionConfig {
  provider: AgentProvider;
  cwd: string;
  /**
   * Provider-agnostic system/developer instruction string.
   * Mapped by each provider to its native instruction field.
   */
  systemPrompt?: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  authProfileKey?: string | null;
  runtimeProfileId?: string | null;
  profileOverrides?: RuntimeProfileLaunchOverrides;
  profileSnapshot?: AgentProfileSnapshot;
  sessionBehavior?: RuntimeProfileSessionBehavior;
  featureValues?: Record<string, unknown>;
  title?: string | null;
  approvalPolicy?: string;
  sandboxMode?: string;
  networkAccess?: boolean;
  webSearch?: boolean;
  extra?: {
    codex?: AgentMetadata;
    claude?: Partial<ClaudeAgentOptions>;
  };
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   * They are used for ephemeral system tasks like commit/PR generation.
   */
  internal?: boolean;
}

export interface AgentLaunchContext {
  env?: Record<string, string>;
}

export interface AgentCreateSessionOptions {
  /**
   * Whether the provider should leave a durable native session behind.
   * Defaults to true. Providers that cannot honor false should no-op.
   */
  persistSession?: boolean;
}

export interface AgentResumeSessionOptions {
  /**
   * When true, providers must fail the resume attempt instead of silently
   * creating a fresh native session/thread.
   */
  strict?: boolean;
}

/**
 * Returned by respondToPermission when the permission resolution requires
 * a follow-up turn (e.g. Codex plan approval → implementation).
 */
export interface AgentPermissionResult {
  followUpPrompt?: AgentPromptInput;
}

export interface AgentSession {
  readonly provider: AgentProvider;
  readonly id: string | null;
  readonly capabilities: AgentCapabilityFlags;
  readonly features?: AgentFeature[];
  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  streamHistory(): AsyncGenerator<AgentStreamEvent>;
  getRuntimeInfo(): Promise<AgentRuntimeInfo>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode(modeId: string): Promise<void>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
  describePersistence(): AgentPersistenceHandle | null;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  listCommands?(): Promise<AgentSlashCommand[]>;
  setModel?(modelId: string | null): Promise<void>;
  setThinkingOption?(thinkingOptionId: string | null): Promise<void>;
  setFeature?(featureId: string, value: unknown): Promise<void>;
  /**
   * Out-of-band prompt handler. When non-null, the manager runs the returned
   * handler instead of allocating a turn. The handler emits stream events
   * directly via the provided `emit` callback, which routes through the
   * manager's persistence + broadcast pipeline. The active foreground turn
   * (if any) is left untouched, so this is how mid-turn side-effect commands
   * (e.g. /goal pause) reach the provider without canceling the running turn.
   */
  tryHandleOutOfBand?(prompt: AgentPromptInput): {
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null;
}

export interface ListModelsOptions {
  cwd: string;
  force: boolean;
}

export interface ListModesOptions {
  cwd: string;
  force: boolean;
}

export interface AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;
  createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession>;
  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession>;
  listModels(options: ListModelsOptions): Promise<AgentModelDefinition[]>;
  listModes?(options: ListModesOptions): Promise<AgentMode[]>;
  listPersistedAgents?(options?: ListPersistedAgentsOptions): Promise<PersistedAgentDescriptor[]>;
  /**
   * Check if this provider is available (CLI binary is installed).
   * Returns true if available, false otherwise.
   */
  isAvailable(): Promise<boolean>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
  /**
   * Archive a persisted session in the native provider (best-effort).
   * Called when Paseo archives an agent so the provider's own UI reflects the same state.
   */
  archiveNativeSession?(handle: AgentPersistenceHandle): Promise<void>;
}
