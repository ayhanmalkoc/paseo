import path from "node:path";

import type { AgentProvider } from "./agent-sdk-types.js";

export function getProvidersRoot(paseoHome: string): string {
  return path.join(paseoHome, "providers");
}

export function getProviderRoot(paseoHome: string, provider: AgentProvider): string {
  return path.join(getProvidersRoot(paseoHome), slugifyPathSegment(provider));
}

export function getProviderAccountRoot(
  providerRoot: string,
  input: {
    key: string;
    alias?: string | null;
    email?: string | null;
    accountName?: string | null;
  },
): string {
  return path.join(providerRoot, "accounts", getProviderAccountSlug(input));
}

export function getProviderAccountHomePath(
  providerRoot: string,
  input: {
    key: string;
    alias?: string | null;
    email?: string | null;
    accountName?: string | null;
  },
): string {
  return path.join(getProviderAccountRoot(providerRoot, input), "home");
}

export function getProviderAccountSlug(input: {
  key: string;
  alias?: string | null;
  email?: string | null;
  accountName?: string | null;
}): string {
  const label = input.alias ?? input.email ?? input.accountName ?? input.key;
  const base = slugifyPathSegment(label) || "account";
  const keySuffix = slugifyPathSegment(input.key.replace(/^[a-z]+-/i, "")).slice(0, 8);
  if (!keySuffix || base.endsWith(keySuffix)) {
    return base;
  }
  return `${base}-${keySuffix}`;
}

export function getProviderProfileRoot(providerRoot: string, runtimeProfileId: string): string {
  return path.join(providerRoot, "profiles", slugifyPathSegment(runtimeProfileId));
}

export function slugifyPathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
