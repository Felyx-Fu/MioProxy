import {
  createControllerClient,
  type ControllerClient,
  type ControllerClientResult
} from "@mioproxy/core-runtime";
import type {
  ControllerConnectionSummary,
  ControllerConnectionsSummary,
  ControllerObservationInput,
  ControllerObservationResponse
} from "../../shared/pipelineTypes.js";

export interface ControllerObservationServiceOptions {
  clientFactory?: (input: ControllerObservationInput) => ControllerClient;
  now?: () => Date;
}

export interface ControllerObservationService {
  snapshot(input: ControllerObservationInput): Promise<ControllerObservationResponse>;
}

const DEFAULT_CONNECTION_LIMIT = 12;

export function createControllerObservationService(
  options: ControllerObservationServiceOptions = {}
): ControllerObservationService {
  const clientFactory =
    options.clientFactory ??
    ((input: ControllerObservationInput) =>
      createControllerClient({
        baseUrl: input.baseUrl,
        secret: input.secret,
        timeoutMs: input.timeoutMs
      }));
  const now = options.now ?? (() => new Date());

  return {
    async snapshot(input: ControllerObservationInput): Promise<ControllerObservationResponse> {
      try {
        const client = clientFactory({
          baseUrl: normalizeRequired(input.baseUrl, "baseUrl"),
          secret: normalizeRequired(input.secret, "secret"),
          timeoutMs: input.timeoutMs,
          connectionLimit: input.connectionLimit
        });
        const [trafficResult, connectionsResult] = await Promise.all([
          client.getTraffic(),
          client.getConnections()
        ]);

        if (!trafficResult.ok || !connectionsResult.ok) {
          return {
            ok: false,
            checkedAt: now().toISOString(),
            error: toViewError(resultError(trafficResult.ok ? connectionsResult : trafficResult)),
            trafficStatus: trafficResult.status,
            connectionsStatus: connectionsResult.status
          };
        }

        const traffic = parseJsonRecord(trafficResult.body);
        const connections = parseJsonRecord(connectionsResult.body);
        return {
          ok: true,
          checkedAt: now().toISOString(),
          traffic: {
            upload: numberValue(traffic.up),
            download: numberValue(traffic.down)
          },
          connections: summarizeConnections(connections, input.connectionLimit),
          trafficStatus: trafficResult.status,
          connectionsStatus: connectionsResult.status
        };
      } catch (error) {
        return {
          ok: false,
          checkedAt: now().toISOString(),
          error: toViewError(error)
        };
      }
    }
  };
}

function summarizeConnections(
  record: Record<string, unknown>,
  limitInput: number | undefined
): ControllerConnectionsSummary {
  const connections = Array.isArray(record.connections) ? record.connections : [];
  const limit = clampConnectionLimit(limitInput);
  return {
    uploadTotal: numberValue(record.uploadTotal),
    downloadTotal: numberValue(record.downloadTotal),
    count: connections.length,
    items: connections.slice(0, limit).map((item) => summarizeConnection(item))
  };
}

function summarizeConnection(value: unknown): ControllerConnectionSummary {
  const record = objectValue(value) ?? {};
  const metadata = objectValue(record.metadata) ?? {};
  const host = stringValue(metadata.host) ?? stringValue(metadata.destinationIP);
  const destinationPort = numberOrString(metadata.destinationPort);
  const destination =
    host && destinationPort !== undefined ? `${host}:${destinationPort}` : host;

  return {
    id: stringValue(record.id),
    network: stringValue(metadata.network),
    type: stringValue(metadata.type),
    host: stringValue(metadata.host),
    destination,
    rule: stringValue(record.rule),
    rulePayload: stringValue(record.rulePayload),
    chain: stringArray(record.chains),
    upload: numberValue(record.upload),
    download: numberValue(record.download),
    start: stringValue(record.start),
    process: stringValue(metadata.process)
  };
}

function parseJsonRecord(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Controller response must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function clampConnectionLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CONNECTION_LIMIT;
  }
  return Math.max(0, Math.min(50, Math.trunc(value)));
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrString(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
