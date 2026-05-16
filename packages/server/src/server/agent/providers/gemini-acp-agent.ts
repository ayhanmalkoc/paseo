import { existsSync } from "node:fs";
import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentMode,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { findExecutable } from "../../../utils/executable.js";
import { ACPAgentClient } from "./acp-agent.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
} from "./diagnostic-utils.js";

const GEMINI_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const GEMINI_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Default",
    description: "Gemini CLI's default approval flow",
  },
  {
    id: "autoEdit",
    label: "Auto Edit",
    description: "Automatically approves edit tools while prompting for other tool calls",
  },
  {
    id: "yolo",
    label: "Full Access",
    description: "Automatically approves all Gemini CLI tool calls",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode when supported by the installed Gemini CLI",
  },
];

interface GeminiACPAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  settingsPath?: string;
}

export class GeminiACPAgentClient extends ACPAgentClient {
  private readonly settingsPath?: string;

  constructor(options: GeminiACPAgentClientOptions) {
    super({
      provider: "gemini",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["gemini", "--acp"],
      defaultModes: GEMINI_MODES,
      capabilities: GEMINI_CAPABILITIES,
    });
    this.settingsPath = options.settingsPath;
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    _options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    return super.createSession(config, this.withGeminiSettingsEnv(launchContext));
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    _options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    return super.resumeSession(handle, overrides, this.withGeminiSettingsEnv(launchContext));
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      const resolvedBinary = await findExecutable("gemini");
      const status = formatDiagnosticStatus(available);

      return {
        diagnostic: formatProviderDiagnostic("Gemini", [
          {
            label: "Binary",
            value: resolvedBinary ?? "not found",
          },
          {
            label: "Version",
            value: resolvedBinary ? await resolveBinaryVersion(resolvedBinary) : "unknown",
          },
          { label: "Models", value: "Shown in the provider model list" },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Gemini", error),
      };
    }
  }

  private withGeminiSettingsEnv(
    launchContext?: AgentLaunchContext,
  ): AgentLaunchContext | undefined {
    if (!this.settingsPath || !existsSync(this.settingsPath)) {
      return launchContext;
    }
    return {
      ...launchContext,
      env: {
        ...launchContext?.env,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: this.settingsPath,
      },
    };
  }
}
