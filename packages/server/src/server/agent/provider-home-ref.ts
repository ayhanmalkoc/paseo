import type { AgentProvider, ProviderAuthProfile, ProviderHomeRef } from "./agent-sdk-types.js";

export function createNativeDefaultProviderHomeRef(input: {
  provider: AgentProvider;
  homePath?: string | null;
  label?: string | null;
  accountFingerprint?: string | null;
}): ProviderHomeRef {
  return stripUndefined({
    kind: "native-default",
    provider: input.provider,
    homePath: normalizeNullableString(input.homePath),
    label: normalizeNullableString(input.label),
    accountFingerprint: normalizeNullableString(input.accountFingerprint),
  });
}

export function createManagedProviderHomeRef(input: {
  provider: AgentProvider;
  profileKey: string;
  homePath?: string | null;
  label?: string | null;
  accountFingerprint?: string | null;
}): ProviderHomeRef {
  return stripUndefined({
    kind: "managed-profile",
    provider: input.provider,
    profileKey: normalizeRequiredString(input.profileKey),
    homePath: normalizeNullableString(input.homePath),
    label: normalizeNullableString(input.label),
    accountFingerprint: normalizeNullableString(input.accountFingerprint),
  });
}

export function createManagedProviderHomeRefFromProfile(
  profile: Pick<
    ProviderAuthProfile,
    "provider" | "key" | "email" | "accountName" | "accountId" | "userId"
  > & { alias?: string | null },
): ProviderHomeRef {
  return createManagedProviderHomeRef({
    provider: profile.provider,
    profileKey: profile.key,
    label: profile.email ?? profile.accountName ?? profile.alias,
    accountFingerprint: profile.accountId ?? profile.userId ?? profile.email,
  });
}

export function normalizeProviderHomeRef(
  value: ProviderHomeRef | null | undefined,
  provider?: AgentProvider,
): ProviderHomeRef | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const refProvider = normalizeRequiredString(value.provider);
  if (!refProvider || (provider && refProvider !== provider)) {
    return null;
  }
  if (value.kind === "native-default") {
    return createNativeDefaultProviderHomeRef({
      provider: refProvider,
      homePath: value.homePath,
      label: value.label,
      accountFingerprint: value.accountFingerprint,
    });
  }
  if (value.kind === "managed-profile") {
    const profileKey = normalizeRequiredString(value.profileKey);
    if (!profileKey) {
      return null;
    }
    return createManagedProviderHomeRef({
      provider: refProvider,
      profileKey,
      homePath: value.homePath,
      label: value.label,
      accountFingerprint: value.accountFingerprint,
    });
  }
  return null;
}

export function getProviderHomeRefKey(value: ProviderHomeRef | null | undefined): string | null {
  const ref = normalizeProviderHomeRef(value);
  if (!ref) {
    return null;
  }
  if (ref.kind === "managed-profile") {
    return `${ref.provider}:managed-profile:${ref.profileKey}`;
  }
  return `${ref.provider}:native-default:${ref.homePath ?? ""}`;
}

export function getManagedProviderHomeProfileKey(
  value: ProviderHomeRef | null | undefined,
): string | null {
  const ref = normalizeProviderHomeRef(value);
  return ref?.kind === "managed-profile" ? (ref.profileKey ?? null) : null;
}

function normalizeRequiredString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stripUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}
