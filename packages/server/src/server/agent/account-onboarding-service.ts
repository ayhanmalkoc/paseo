import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { AccountLoginMethod, AccountLoginSession, AgentProvider } from "./agent-sdk-types.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "./provider-launch-config.js";
import { findExecutable } from "../../utils/executable.js";
import { spawnProcess } from "../../utils/spawn.js";
import { CodexAppServerJsonRpcClient } from "./providers/codex-app-server-json-rpc.js";
import type { ProviderAuthService } from "./provider-auth-service.js";

const CODEX_PROVIDER = "codex" as const;
const CODEX_AUTH_FILENAME = "auth.json";
const LOGIN_START_TIMEOUT_MS = 30_000;

type LoginSubscriber = (session: AccountLoginSession) => void;

interface ActiveLogin {
  client: CodexAppServerJsonRpcClient;
  stagingRoot: string;
  loginId: string | null;
}

export class AccountOnboardingService {
  private readonly logger: Logger;
  private readonly baseDir: string;
  private readonly providerAuthService: ProviderAuthService;
  private readonly now: () => Date;
  private readonly runtimeSettings?: Partial<Record<AgentProvider, ProviderRuntimeSettings>>;
  private readonly sessions = new Map<string, AccountLoginSession>();
  private readonly activeLogins = new Map<string, ActiveLogin>();
  private readonly subscribers = new Set<LoginSubscriber>();

  constructor(options: {
    paseoHome: string;
    logger: Logger;
    providerAuthService: ProviderAuthService;
    runtimeSettings?: Partial<Record<AgentProvider, ProviderRuntimeSettings>>;
    now?: () => Date;
  }) {
    this.baseDir = path.join(options.paseoHome, "provider-auth");
    this.logger = options.logger.child({ module: "account-onboarding" });
    this.providerAuthService = options.providerAuthService;
    this.runtimeSettings = options.runtimeSettings;
    this.now = options.now ?? (() => new Date());
  }

  subscribe(callback: LoginSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  listMethods(provider: AgentProvider): AccountLoginMethod[] {
    return provider === CODEX_PROVIDER ? ["chatgpt-device-code"] : [];
  }

  listSessions(provider?: AgentProvider): AccountLoginSession[] {
    return Array.from(this.sessions.values())
      .filter((session) => !provider || session.provider === provider)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async startLogin(input: {
    provider: AgentProvider;
    method: AccountLoginMethod;
    setDefault?: boolean;
  }): Promise<AccountLoginSession> {
    if (input.provider !== CODEX_PROVIDER || input.method !== "chatgpt-device-code") {
      throw new Error(
        `Account login method '${input.method}' is not supported for ${input.provider}`,
      );
    }

    const now = this.now().toISOString();
    const session: AccountLoginSession = {
      id: randomUUID(),
      provider: input.provider,
      method: input.method,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.emitUpdate(session);
    void this.runCodexDeviceCodeLogin(session.id, { setDefault: input.setDefault }).catch(
      (error) => {
        if (this.sessions.get(session.id)?.status === "cancelled") {
          return;
        }
        this.updateSession(session.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return session;
  }

  async cancelLogin(sessionId: string): Promise<AccountLoginSession> {
    this.requireSession(sessionId);
    const active = this.activeLogins.get(sessionId);
    if (!active) {
      return this.updateSession(sessionId, { status: "cancelled" });
    }
    if (active.loginId) {
      await active.client
        .request("account/login/cancel", { loginId: active.loginId }, LOGIN_START_TIMEOUT_MS)
        .catch((error) => {
          this.logger.debug({ err: error, sessionId }, "Failed to cancel Codex account login");
        });
    }
    await active.client.dispose().catch(() => undefined);
    await fs.rm(active.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    this.activeLogins.delete(sessionId);
    return this.updateSession(sessionId, { status: "cancelled" });
  }

  private async runCodexDeviceCodeLogin(
    sessionId: string,
    options?: { setDefault?: boolean },
  ): Promise<void> {
    const stagingRoot = path.join(this.baseDir, CODEX_PROVIDER, "pending", sessionId);
    const codexHome = path.join(stagingRoot, "codex-home");
    await fs.mkdir(codexHome, { recursive: true });
    await copyOptionalCodexConfig(codexHome);

    const child = await this.spawnCodexAppServer({ CODEX_HOME: codexHome });
    const client = new CodexAppServerJsonRpcClient(child, this.logger);
    let loginId: string | null = null;
    this.activeLogins.set(sessionId, { client, stagingRoot, loginId });

    try {
      const completed = new Promise<void>((resolve, reject) => {
        client.setNotificationHandler((method, params) => {
          if (method !== "account/login/completed") {
            return;
          }
          const result = parseLoginCompleted(params);
          if (result.loginId && loginId && result.loginId !== loginId) {
            return;
          }
          if (!result.success) {
            reject(new Error(result.error ?? "Codex account login failed"));
            return;
          }
          resolve();
        });
      });

      await client.request("initialize", buildCodexAppServerInitializeParams());
      client.notify("initialized", {});
      const startResult = parseDeviceCodeStartResult(
        await client.request(
          "account/login/start",
          { type: "chatgptDeviceCode" },
          LOGIN_START_TIMEOUT_MS,
        ),
      );
      loginId = startResult.loginId;
      this.activeLogins.set(sessionId, { client, stagingRoot, loginId });
      this.updateSession(sessionId, {
        status: "pending-user",
        verificationUrl: startResult.verificationUrl,
        userCode: startResult.userCode,
      });

      await completed;
      this.updateSession(sessionId, { status: "importing" });
      const account = await this.providerAuthService.importProfile({
        provider: CODEX_PROVIDER,
        source: "file",
        path: path.join(codexHome, CODEX_AUTH_FILENAME),
        setDefault: options?.setDefault,
      });
      this.updateSession(sessionId, {
        status: "completed",
        account,
      });
    } finally {
      this.activeLogins.delete(sessionId);
      await client.dispose().catch(() => undefined);
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async spawnCodexAppServer(
    launchEnv?: Record<string, string>,
  ): Promise<ChildProcessWithoutNullStreams> {
    const prefix = await resolveProviderCommandPrefix(
      this.runtimeSettings?.[CODEX_PROVIDER]?.command,
      resolveCodexBinary,
    );
    const child = spawnProcess(prefix.command, [...prefix.args, "app-server"], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      ...createProviderEnvSpec({
        runtimeSettings: this.runtimeSettings?.[CODEX_PROVIDER],
        overlays: [launchEnv],
      }),
    });
    assertChildWithPipes(child);
    return child;
  }

  private requireSession(sessionId: string): AccountLoginSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Account login session '${sessionId}' was not found`);
    }
    return session;
  }

  private updateSession(
    sessionId: string,
    patch: Partial<Omit<AccountLoginSession, "id" | "provider" | "method" | "createdAt">>,
  ): AccountLoginSession {
    const previous = this.requireSession(sessionId);
    const next: AccountLoginSession = {
      ...previous,
      ...patch,
      updatedAt: this.now().toISOString(),
    };
    this.sessions.set(sessionId, next);
    this.emitUpdate(next);
    return next;
  }

  private emitUpdate(session: AccountLoginSession): void {
    for (const subscriber of this.subscribers) {
      subscriber(session);
    }
  }
}

async function resolveCodexBinary(): Promise<string> {
  const found = await findExecutable("codex");
  if (found) {
    return found;
  }
  throw new Error(
    "Codex binary not found. Install the Codex CLI and ensure it is available in your shell PATH.",
  );
}

function assertChildWithPipes(
  child: ChildProcess,
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Child process did not expose stdio pipes");
  }
}

function buildCodexAppServerInitializeParams(): {
  clientInfo: { name: string; title: string; version: string };
  capabilities: { experimentalApi: true };
} {
  return {
    clientInfo: {
      name: "paseo",
      title: "Paseo",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

function parseDeviceCodeStartResult(value: unknown): {
  loginId: string;
  verificationUrl: string;
  userCode: string;
} {
  const record = readRecord(value);
  const loginId = readString(record?.loginId);
  const verificationUrl = readString(record?.verificationUrl);
  const userCode = readString(record?.userCode);
  if (!loginId || !verificationUrl || !userCode) {
    throw new Error("Codex account login did not return a device code");
  }
  return { loginId, verificationUrl, userCode };
}

function parseLoginCompleted(value: unknown): {
  loginId: string | null;
  success: boolean;
  error: string | null;
} {
  const record = readRecord(value);
  return {
    loginId: readString(record?.loginId),
    success: record?.success === true,
    error: readString(record?.error),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function copyOptionalCodexConfig(targetCodexHome: string): Promise<void> {
  const sourcePath = path.join(
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
    "config.toml",
  );
  await fs.copyFile(sourcePath, path.join(targetCodexHome, "config.toml")).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}
