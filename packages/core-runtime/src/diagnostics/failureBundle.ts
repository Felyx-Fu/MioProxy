import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RenderValidatePromoteAndApplyResult } from "../orchestrator/renderValidatePromoteAndApply.js";

export interface SaveFailureBundleOptions {
  rootDir: string;
  profileId: string;
  sessionId: string;
  result: Extract<RenderValidatePromoteAndApplyResult, { ok: false }>;
  now?: Date;
}

export interface FailureBundle {
  version: 1;
  createdAt: string;
  profileId: string;
  sessionId: string;
  stage: string;
  error: SerializedError;
  render?: unknown;
  validation?: unknown;
  promotion?: unknown;
  apply?: unknown;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export interface SaveFailureBundleResult {
  bundleDir: string;
  bundlePath: string;
  bundle: FailureBundle;
}

export interface ExportFailureReportOptions {
  rootDir: string;
  profileId: string;
  sessionId: string;
  failureBundlePath: string;
  history?: unknown;
  coreLogs?: unknown;
  now?: Date;
}

export interface ExportFailureReportResult {
  reportDir: string;
  files: string[];
}

export async function saveFailureBundle(
  options: SaveFailureBundleOptions
): Promise<SaveFailureBundleResult> {
  const createdAt = (options.now ?? new Date()).toISOString();
  const bundleDir = join(
    options.rootDir,
    "bundles",
    sanitizePathSegment(options.profileId),
    `${fileSafeTimestamp(createdAt)}-${sanitizePathSegment(options.sessionId)}`
  );
  const bundlePath = join(bundleDir, "failure.json");
  const bundle = buildFailureBundle(options.result, {
    createdAt,
    profileId: options.profileId,
    sessionId: options.sessionId
  });

  await mkdir(bundleDir, { recursive: true });
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { bundleDir, bundlePath, bundle };
}

export async function exportFailureReport(
  options: ExportFailureReportOptions
): Promise<ExportFailureReportResult> {
  const createdAt = (options.now ?? new Date()).toISOString();
  const reportDir = join(
    options.rootDir,
    "logs",
    "exports",
    sanitizePathSegment(options.profileId),
    `${fileSafeTimestamp(createdAt)}-${sanitizePathSegment(options.sessionId)}`
  );
  const bundlePath = assertInside(
    options.failureBundlePath,
    join(options.rootDir, "logs", "bundles")
  );
  const failureBundle = JSON.parse(await readFile(bundlePath, "utf8")) as unknown;
  const summary = {
    version: 1,
    createdAt,
    profileId: redactString(options.profileId),
    sessionId: redactString(options.sessionId),
    source: "failure-bundle"
  };
  const files = ["summary.json", "failure.json"];

  await mkdir(reportDir, { recursive: true });
  await writeJson(join(reportDir, "summary.json"), summary);
  await writeJson(join(reportDir, "failure.json"), redactJson(failureBundle));

  if (options.history !== undefined) {
    await writeJson(join(reportDir, "history.json"), redactJson(options.history));
    files.push("history.json");
  }

  if (options.coreLogs !== undefined) {
    await writeJson(join(reportDir, "core-logs.json"), redactJson(options.coreLogs));
    files.push("core-logs.json");
  }

  return { reportDir, files };
}

export function buildFailureBundle(
  result: Extract<RenderValidatePromoteAndApplyResult, { ok: false }>,
  metadata: { createdAt: string; profileId: string; sessionId: string }
): FailureBundle {
  return {
    version: 1,
    createdAt: metadata.createdAt,
    profileId: redactString(metadata.profileId),
    sessionId: redactString(metadata.sessionId),
    stage: result.stage,
    error: serializeError(result.error),
    render: redactJson(result.render),
    validation: redactJson(result.validation),
    promotion: redactJson(result.promotion),
    apply: redactJson(result.apply)
  };
}

export function redactJson(value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, child]) => {
      if (isSensitiveKey(key)) {
        acc[key] = "[REDACTED]";
      } else {
        acc[key] = redactJson(child);
      }
      return acc;
    }, {});
  }

  return value;
}

export function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|secret|key|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(secret|token|password|api[_-]?key)\s*[:=]\s*[^,\s}]+/gi, "$1=[REDACTED]");
}

function serializeError(error: Error): SerializedError {
  return {
    name: error.name,
    message: redactString(error.message),
    stack: error.stack ? redactString(error.stack) : undefined
  };
}

function isSensitiveKey(key: string): boolean {
  return /^(authorization|secret|token|password|api[_-]?key)$/i.test(key);
}

function sanitizePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "unknown";
}

function fileSafeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertInside(path: string, parentDir: string): string {
  const resolvedPath = resolve(path);
  const resolvedParent = resolve(parentDir);
  const parentToPath = relative(resolvedParent, resolvedPath);
  if (parentToPath === "" || (!parentToPath.startsWith("..") && !isAbsolute(parentToPath))) {
    return resolvedPath;
  }
  throw new Error("Failure bundle path is outside the managed diagnostics directory");
}
