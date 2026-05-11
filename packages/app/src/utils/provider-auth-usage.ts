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

  const parts = [
    formatUsageWindow(usage.primaryUsedPercent, usage.primaryWindowMinutes, usage.primaryResetsAt),
    formatUsageWindow(
      usage.secondaryUsedPercent,
      usage.secondaryWindowMinutes,
      usage.secondaryResetsAt,
    ),
    formatCredits(usage.creditsRemaining),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join("\n") : null;
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
  const summary = formatDominantUsage(usage);
  return summary ? `${base}: ${summary}` : base;
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
  const primary = buildUsageEntry(
    usage.primaryUsedPercent,
    usage.primaryWindowMinutes,
    usage.primaryResetsAt,
  );
  const secondary = buildUsageEntry(
    usage.secondaryUsedPercent,
    usage.secondaryWindowMinutes,
    usage.secondaryResetsAt,
  );
  const dominant = [primary, secondary]
    .filter((entry): entry is UsageEntry => entry !== null)
    .sort((left, right) => right.percent - left.percent)[0];
  return dominant?.label ?? null;
}

interface UsageEntry {
  percent: number;
  label: string;
}

function buildUsageEntry(
  usedPercent: number | undefined,
  windowMinutes: number | undefined,
  resetsAt: string | undefined,
): UsageEntry | null {
  const label = formatUsageWindow(usedPercent, windowMinutes, resetsAt);
  return typeof usedPercent === "number" && label ? { percent: usedPercent, label } : null;
}

function formatUsageWindow(
  usedPercent: number | undefined,
  windowMinutes: number | undefined,
  resetsAt: string | undefined,
): string | null {
  if (typeof usedPercent !== "number") {
    return null;
  }
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const windowLabel = formatWindowMinutes(windowMinutes);
  const usageLabel = windowLabel
    ? `${formatPercent(remainingPercent)} ${windowLabel} left`
    : `${formatPercent(remainingPercent)} left`;
  const resetLabel = formatResetTime(resetsAt, windowMinutes);
  return resetLabel ? `${usageLabel} · resets ${resetLabel}` : usageLabel;
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

function formatResetTime(
  value: string | undefined,
  windowMinutes: number | undefined,
): string | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  if (windowMinutes === 10_080 || (typeof windowMinutes === "number" && windowMinutes > 1440)) {
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
