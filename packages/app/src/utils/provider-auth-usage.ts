import type {
  ProviderAuthLimitState,
  ProviderAuthUsageSnapshot,
} from "@server/server/agent/agent-sdk-types";

export function formatProviderAuthUsageSummary(
  usage: ProviderAuthUsageSnapshot | null | undefined,
): string | null {
  if (!usage) {
    return null;
  }
  const limitState = usage.limitState ?? inferLimitState(usage);
  if (limitState === "limited" || limitState === "near-limit") {
    const dominantUsage = formatDominantUsage(usage);
    const label = limitState === "limited" ? "Limited" : "Near limit";
    return dominantUsage ? `${label}: ${dominantUsage}` : label;
  }

  const parts = [
    formatUsageWindow(usage.primaryUsedPercent, usage.primaryWindowMinutes),
    formatUsageWindow(usage.secondaryUsedPercent, usage.secondaryWindowMinutes),
    formatCredits(usage.creditsRemaining),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" / ") : null;
}

export function formatProviderAuthUsageWarning(
  usage: ProviderAuthUsageSnapshot | null | undefined,
): string | null {
  if (!usage) {
    return null;
  }
  const limitState = usage.limitState ?? inferLimitState(usage);
  if (limitState !== "limited" && limitState !== "near-limit") {
    return null;
  }

  const base =
    limitState === "limited"
      ? "This account appears to be at its usage limit"
      : "This account is near its usage limit";
  const resetTime = formatDominantResetTime(usage);
  return resetTime ? `${base}; resets around ${resetTime}` : base;
}

function inferLimitState(usage: ProviderAuthUsageSnapshot): ProviderAuthLimitState | undefined {
  const usedPercents = [usage.primaryUsedPercent, usage.secondaryUsedPercent].filter(
    (value): value is number => typeof value === "number",
  );
  if (usedPercents.length === 0) {
    return undefined;
  }
  const usedPercent = Math.max(...usedPercents);
  if (usedPercent >= 100) {
    return "limited";
  }
  if (usedPercent >= 85) {
    return "near-limit";
  }
  return "ok";
}

function formatDominantUsage(usage: ProviderAuthUsageSnapshot): string | null {
  const primary = buildUsageEntry(usage.primaryUsedPercent, usage.primaryWindowMinutes);
  const secondary = buildUsageEntry(usage.secondaryUsedPercent, usage.secondaryWindowMinutes);
  const dominant = [primary, secondary]
    .filter((entry): entry is UsageEntry => entry !== null)
    .sort((left, right) => right.percent - left.percent)[0];
  return dominant?.label ?? null;
}

function formatDominantResetTime(usage: ProviderAuthUsageSnapshot): string | null {
  const primary = buildResetEntry(
    usage.primaryUsedPercent,
    usage.primaryResetsAt,
    usage.primaryWindowMinutes,
  );
  const secondary = buildResetEntry(
    usage.secondaryUsedPercent,
    usage.secondaryResetsAt,
    usage.secondaryWindowMinutes,
  );
  const dominant = [primary, secondary]
    .filter((entry): entry is ResetEntry => entry !== null)
    .sort((left, right) => right.percent - left.percent)[0];
  return dominant ? formatTimeOfDay(dominant.resetsAt) : null;
}

interface UsageEntry {
  percent: number;
  label: string;
}

interface ResetEntry {
  percent: number;
  resetsAt: string;
}

function buildUsageEntry(
  usedPercent: number | undefined,
  windowMinutes: number | undefined,
): UsageEntry | null {
  const label = formatUsageWindow(usedPercent, windowMinutes);
  return typeof usedPercent === "number" && label ? { percent: usedPercent, label } : null;
}

function buildResetEntry(
  usedPercent: number | undefined,
  resetsAt: string | undefined,
  windowMinutes: number | undefined,
): ResetEntry | null {
  if (!resetsAt) {
    return null;
  }
  return {
    percent: typeof usedPercent === "number" ? usedPercent : (windowMinutes ?? 0),
    resetsAt,
  };
}

function formatUsageWindow(
  usedPercent: number | undefined,
  windowMinutes: number | undefined,
): string | null {
  if (typeof usedPercent !== "number") {
    return null;
  }
  const windowLabel = formatWindowMinutes(windowMinutes);
  return windowLabel ? `${formatPercent(usedPercent)} ${windowLabel}` : formatPercent(usedPercent);
}

function formatWindowMinutes(windowMinutes: number | undefined): string | null {
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return null;
  }
  if (windowMinutes === 10_080) {
    return "weekly";
  }
  if (windowMinutes === 1440) {
    return "daily";
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`;
  }
  return `${windowMinutes}m`;
}

function formatCredits(creditsRemaining: number | undefined): string | null {
  return typeof creditsRemaining === "number" ? `Credits: ${creditsRemaining} remaining` : null;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function formatTimeOfDay(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
