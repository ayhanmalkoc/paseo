import { homedir } from "node:os";
import type { Logger } from "pino";

import type { AgentCapabilityFlags, AgentMode } from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { findExecutable } from "../../../utils/executable.js";
import { ACPAgentClient } from "./acp-agent.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
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
}

export class GeminiACPAgentClient extends ACPAgentClient {
  constructor(options: GeminiACPAgentClientOptions) {
    super({
      provider: "gemini",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["gemini", "--acp"],
      defaultModes: GEMINI_MODES,
      capabilities: GEMINI_CAPABILITIES,
    });
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      const resolvedBinary = await findExecutable("gemini");
      let modelsValue = "Not checked";
      let status = formatDiagnosticStatus(available);

      if (available) {
        try {
          const models = await this.listModels({ cwd: homedir(), force: false });
          modelsValue = String(models.length);
        } catch (error) {
          modelsValue = `Error - ${toDiagnosticErrorMessage(error)}`;
          status = formatDiagnosticStatus(available, {
            source: "model fetch",
            cause: error,
          });
        }

        if (!modelsValue.startsWith("Error -")) {
          try {
            await this.listModes({ cwd: homedir(), force: false });
          } catch (error) {
            status = formatDiagnosticStatus(available, {
              source: "mode fetch",
              cause: error,
            });
          }
        }
      }

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
          { label: "Models", value: modelsValue },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Gemini", error),
      };
    }
  }
}
