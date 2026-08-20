export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = -1;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 2)} ${units[unit]}`;
}

export function formatRate(value: number | null | undefined): string {
  const formatted = formatBytes(value);
  return formatted === "—" ? "—" : `${formatted}/s`;
}

export function formatDate(
  value: number | null | undefined,
  locale = "zh-CN",
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";

  return new Date(value * 1000).toLocaleString(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/…`;
  } catch {
    return "已隐藏订阅地址";
  }
}

export function latencyTone(delay: number | null | undefined): "fast" | "medium" | "slow" | "unknown" {
  if (delay === null || delay === undefined || !Number.isFinite(delay)) return "unknown";
  if (delay < 160) return "fast";
  if (delay < 350) return "medium";
  return "slow";
}
