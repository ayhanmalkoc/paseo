import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type {
  AgentProvider,
  RuntimeProfile,
  RuntimeProfilePatch,
  RuntimeProfileConcurrencyPolicy,
} from "./agent-sdk-types.js";

interface StoredRuntimeProfileRegistry {
  schemaVersion: 1;
  profiles: Record<string, RuntimeProfile>;
}

const CURRENT_SCHEMA_VERSION = 1;
const DEFAULT_CONCURRENCY_POLICY: RuntimeProfileConcurrencyPolicy = "warn";
type RuntimeProfileSubscriber = (profiles: RuntimeProfile[]) => void;
type LegacyRuntimeProfileInput = Partial<RuntimeProfile> & {
  featureDefaults?: Record<string, unknown>;
  workspaceDefaults?: unknown;
  permissionPresetId?: unknown;
  mcpServerIds?: unknown;
  skillIds?: unknown;
  worktreePolicy?: unknown;
};

export class RuntimeProfileService {
  private readonly baseDir: string;
  private readonly registryPath: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private registry: StoredRuntimeProfileRegistry | null = null;
  private loadPromise: Promise<StoredRuntimeProfileRegistry> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();
  private readonly subscribers = new Set<RuntimeProfileSubscriber>();

  constructor(options: { paseoHome: string; logger: Logger; now?: () => Date }) {
    this.baseDir = path.join(options.paseoHome, "runtime-profiles");
    this.registryPath = path.join(this.baseDir, "profiles.json");
    this.logger = options.logger.child({ module: "runtime-profiles" });
    this.now = options.now ?? (() => new Date());
  }

  async listProfiles(provider?: AgentProvider): Promise<RuntimeProfile[]> {
    const registry = await this.load();
    return Object.values(registry.profiles)
      .filter((profile) => !provider || profile.provider === provider)
      .sort(compareRuntimeProfiles);
  }

  subscribe(callback: RuntimeProfileSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async getProfile(profileId: string): Promise<RuntimeProfile | null> {
    const registry = await this.load();
    return registry.profiles[profileId] ?? null;
  }

  async createProfile(input: RuntimeProfilePatch & { name: string; provider: AgentProvider }) {
    const registry = await this.load();
    const now = this.now().toISOString();
    const profile: RuntimeProfile = normalizeProfile({
      ...input,
      id: randomUUID(),
      version: 1,
      name: input.name,
      provider: input.provider,
      concurrencyPolicy: input.concurrencyPolicy ?? DEFAULT_CONCURRENCY_POLICY,
      createdAt: now,
      updatedAt: now,
    });
    registry.profiles = {
      ...registry.profiles,
      [profile.id]: profile,
    };
    await this.save(registry);
    this.emitUpdate(registry);
    return profile;
  }

  async updateProfile(profileId: string, patch: RuntimeProfilePatch): Promise<RuntimeProfile> {
    const registry = await this.load();
    const previous = registry.profiles[profileId];
    if (!previous) {
      throw new Error(`Runtime profile '${profileId}' was not found`);
    }
    const profile = normalizeProfile({
      ...previous,
      ...patch,
      id: previous.id,
      version: previous.version + 1,
      createdAt: previous.createdAt,
      updatedAt: this.now().toISOString(),
    });
    registry.profiles = {
      ...registry.profiles,
      [profile.id]: profile,
    };
    await this.save(registry);
    this.emitUpdate(registry);
    return profile;
  }

  async deleteProfile(profileId: string): Promise<void> {
    const registry = await this.load();
    if (!registry.profiles[profileId]) {
      return;
    }
    registry.profiles = { ...registry.profiles };
    delete registry.profiles[profileId];
    await this.save(registry);
    this.emitUpdate(registry);
  }

  private async load(): Promise<StoredRuntimeProfileRegistry> {
    if (this.registry) {
      return this.registry;
    }
    this.loadPromise ??= this.readRegistry();
    this.registry = await this.loadPromise;
    return this.registry;
  }

  private async readRegistry(): Promise<StoredRuntimeProfileRegistry> {
    await fs.mkdir(this.baseDir, { recursive: true });
    try {
      const data = await fs.readFile(this.registryPath, "utf8");
      return normalizeRegistry(JSON.parse(data));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyRegistry();
      }
      this.logger.warn({ err: error }, "Failed to read runtime profiles; starting empty");
      return emptyRegistry();
    }
  }

  private async save(registry: StoredRuntimeProfileRegistry): Promise<void> {
    this.registry = registry;
    const payload = `${JSON.stringify(registry, null, 2)}\n`;
    const nextWrite = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
        await writeFileAtomically(this.registryPath, payload);
        return undefined;
      });
    this.pendingWrite = nextWrite;
    await nextWrite;
  }

  private emitUpdate(registry: StoredRuntimeProfileRegistry): void {
    const profiles = Object.values(registry.profiles).sort(compareRuntimeProfiles);
    for (const subscriber of this.subscribers) {
      subscriber(profiles);
    }
  }
}

function emptyRegistry(): StoredRuntimeProfileRegistry {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profiles: {},
  };
}

function normalizeRegistry(input: unknown): StoredRuntimeProfileRegistry {
  const registry = emptyRegistry();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return registry;
  }
  const rawProfiles = (input as { profiles?: unknown }).profiles;
  if (!rawProfiles || typeof rawProfiles !== "object" || Array.isArray(rawProfiles)) {
    return registry;
  }
  for (const [id, value] of Object.entries(rawProfiles)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    try {
      const profile = normalizeProfile(value as LegacyRuntimeProfileInput);
      registry.profiles[id] = profile;
    } catch {
      // Skip malformed profiles rather than blocking daemon startup.
    }
  }
  return registry;
}

function normalizeProfile(profile: LegacyRuntimeProfileInput): RuntimeProfile {
  const name = normalizeRequiredString(profile.name, "Runtime profile name");
  const provider = normalizeRequiredString(profile.provider, "Runtime profile provider");
  const featureValues = mergeRecords(
    normalizeRecord(profile.featureDefaults),
    normalizeRecord(profile.featureValues),
  );
  return {
    id: normalizeRequiredString(profile.id, "Runtime profile id"),
    version:
      typeof profile.version === "number" &&
      Number.isInteger(profile.version) &&
      profile.version > 0
        ? profile.version
        : 1,
    name,
    provider,
    accountKey: normalizeNullableString(profile.accountKey),
    model: normalizeNullableString(profile.model),
    modeId: normalizeNullableString(profile.modeId),
    thinkingOptionId: normalizeNullableString(profile.thinkingOptionId),
    instructionOverlay: normalizeNullableString(profile.instructionOverlay),
    systemPrompt: normalizeNullableString(profile.systemPrompt),
    featureValues,
    envOverlay: normalizeStringRecord(profile.envOverlay),
    mcpServers: profile.mcpServers,
    concurrencyPolicy: normalizeConcurrencyPolicy(profile.concurrencyPolicy),
    createdAt: normalizeRequiredString(profile.createdAt, "Runtime profile createdAt"),
    updatedAt: normalizeRequiredString(profile.updatedAt, "Runtime profile updatedAt"),
  };
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return { ...(value as Record<string, unknown>) };
}

function mergeRecords(
  ...values: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeConcurrencyPolicy(value: unknown): RuntimeProfileConcurrencyPolicy {
  return value === "allow" || value === "single-active" || value === "warn"
    ? value
    : DEFAULT_CONCURRENCY_POLICY;
}

function compareRuntimeProfiles(left: RuntimeProfile, right: RuntimeProfile): number {
  const leftUpdated = Date.parse(left.updatedAt);
  const rightUpdated = Date.parse(right.updatedAt);
  if (!Number.isNaN(leftUpdated) && !Number.isNaN(rightUpdated) && leftUpdated !== rightUpdated) {
    return rightUpdated - leftUpdated;
  }
  return left.name.localeCompare(right.name);
}

async function writeFileAtomically(targetPath: string, payload: string) {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(
    directory,
    `.runtime-profiles.tmp-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, targetPath);
}
