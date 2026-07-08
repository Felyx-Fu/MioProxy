export type CoreLogSource = "process-stdout" | "process-stderr" | "controller-logs";
export type CoreLogLevel = "debug" | "info" | "warning" | "error" | "unknown";

export interface CoreLogEvent {
  time: string;
  source: CoreLogSource;
  level: CoreLogLevel;
  message: string;
  fields?: Record<string, unknown>;
}

export function parseProcessLogLine(
  line: string,
  source: Extract<CoreLogSource, "process-stdout" | "process-stderr">,
  now: Date = new Date()
): CoreLogEvent | null {
  const message = line.trimEnd();
  if (message.length === 0) {
    return null;
  }

  return {
    time: now.toISOString(),
    source,
    level: inferLevel(message),
    message
  };
}

export function parseControllerLogMessage(message: string): CoreLogEvent | null {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const text =
        stringValue(record.message) ??
        stringValue(record.msg) ??
        stringValue(record.payload) ??
        trimmed;
      return {
        time: stringValue(record.time) ?? new Date().toISOString(),
        source: "controller-logs",
        level: normalizeLevel(stringValue(record.level) ?? stringValue(record.type)),
        message: text,
        fields: fieldsValue(record.fields)
      };
    }
  } catch {
    // Plain text logs are still useful when structured logs are unavailable.
  }

  return {
    time: new Date().toISOString(),
    source: "controller-logs",
    level: inferLevel(trimmed),
    message: trimmed
  };
}

export function serializeLogEvent(event: CoreLogEvent): string {
  return JSON.stringify(event);
}

function inferLevel(message: string): CoreLogLevel {
  const lower = message.toLowerCase();
  if (lower.includes("panic") || lower.includes("error") || lower.includes("failed")) {
    return "error";
  }
  if (lower.includes("warn")) {
    return "warning";
  }
  if (lower.includes("debug")) {
    return "debug";
  }
  if (lower.includes("info")) {
    return "info";
  }
  return "unknown";
}

function normalizeLevel(value: string | undefined): CoreLogLevel {
  switch (value?.toLowerCase()) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warning":
    case "warn":
      return "warning";
    case "error":
    case "fatal":
    case "panic":
      return "error";
    default:
      return "unknown";
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fieldsValue(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    return { items: value };
  }
  return objectValue(value);
}
