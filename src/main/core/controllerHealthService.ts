import {
  createControllerClient,
  type ControllerClient,
  type ControllerClientResult
} from "@mioproxy/core-runtime";
import type {
  ControllerHealthCheckInput,
  ControllerHealthResponse
} from "../../shared/pipelineTypes.js";

export interface ControllerHealthServiceOptions {
  clientFactory?: (input: ControllerHealthCheckInput) => ControllerClient;
}

export interface ControllerHealthService {
  check(input: ControllerHealthCheckInput): Promise<ControllerHealthResponse>;
}

export function createControllerHealthService(
  options: ControllerHealthServiceOptions = {}
): ControllerHealthService {
  const clientFactory =
    options.clientFactory ??
    ((input: ControllerHealthCheckInput) =>
      createControllerClient({
        baseUrl: input.baseUrl,
        secret: input.secret,
        timeoutMs: input.timeoutMs
      }));

  return {
    async check(input: ControllerHealthCheckInput): Promise<ControllerHealthResponse> {
      try {
        const client = clientFactory({
          baseUrl: normalizeRequired(input.baseUrl, "baseUrl"),
          secret: normalizeRequired(input.secret, "secret"),
          timeoutMs: input.timeoutMs
        });
        const [versionResult, configsResult] = await Promise.all([
          client.getVersion(),
          client.getConfigs()
        ]);

        if (!versionResult.ok || !configsResult.ok) {
          return {
            ok: false,
            online: false,
            checkedAt: new Date().toISOString(),
            error: toViewError(resultError(versionResult.ok ? configsResult : versionResult)),
            versionStatus: versionResult.status,
            configsStatus: configsResult.status
          };
        }

        return {
          ok: true,
          online: true,
          checkedAt: new Date().toISOString(),
          version: summarizeVersion(parseJsonRecord(versionResult.body)),
          config: summarizeConfig(parseJsonRecord(configsResult.body)),
          versionStatus: versionResult.status,
          configsStatus: configsResult.status
        };
      } catch (error) {
        return {
          ok: false,
          online: false,
          checkedAt: new Date().toISOString(),
          error: toViewError(error)
        };
      }
    }
  };
}

function summarizeVersion(record: Record<string, unknown>) {
  return {
    version: stringValue(record.version),
    meta: booleanValue(record.meta)
  };
}

function summarizeConfig(record: Record<string, unknown>) {
  return {
    mode: stringValue(record.mode),
    logLevel: stringValue(record["log-level"]),
    mixedPort: numberValue(record["mixed-port"]),
    port: numberValue(record.port),
    socksPort: numberValue(record["socks-port"]),
    allowLan: booleanValue(record["allow-lan"]),
    tunEnabled: objectValue(record.tun) ? booleanValue(objectValue(record.tun)?.enable) : undefined
  };
}

function parseJsonRecord(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Controller response must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function resultError(result: ControllerClientResult): Error {
  return result.ok ? new Error("Controller request unexpectedly succeeded") : result.error;
}

function normalizeRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function toViewError(error: unknown): { name: string; message: string } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return { name: normalized.name, message: normalized.message };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
