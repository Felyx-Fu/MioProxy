import {
  createControllerClient,
  type ControllerClient,
  type ControllerClientResult
} from "@mioproxy/core-runtime";
import type {
  ControllerProxyGroupSummary,
  ControllerProxyDelayInput,
  ControllerProxyDelayResponse,
  ControllerProxySnapshotInput,
  ControllerProxySnapshotResponse,
  ControllerProxySwitchInput,
  ControllerProxySwitchResponse
} from "../../shared/pipelineTypes.js";

export interface ControllerProxyServiceOptions {
  clientFactory?: (
    input: ControllerProxySnapshotInput | ControllerProxySwitchInput | ControllerProxyDelayInput
  ) => ControllerClient;
  now?: () => Date;
}

export interface ControllerProxyService {
  snapshot(input: ControllerProxySnapshotInput): Promise<ControllerProxySnapshotResponse>;
  switchProxy(input: ControllerProxySwitchInput): Promise<ControllerProxySwitchResponse>;
  testDelay(input: ControllerProxyDelayInput): Promise<ControllerProxyDelayResponse>;
}

const DEFAULT_GROUP_LIMIT = 20;
const DEFAULT_OPTION_LIMIT = 8;
const DEFAULT_DELAY_TEST_URL = "https://www.gstatic.com/generate_204";
const DEFAULT_DELAY_TIMEOUT_MS = 5_000;

export function createControllerProxyService(
  options: ControllerProxyServiceOptions = {}
): ControllerProxyService {
  const clientFactory =
    options.clientFactory ??
    ((input: ControllerProxySnapshotInput | ControllerProxySwitchInput | ControllerProxyDelayInput) =>
      createControllerClient({
        baseUrl: input.baseUrl,
        secret: input.secret,
        timeoutMs: input.timeoutMs
      }));
  const now = options.now ?? (() => new Date());

  return {
    async snapshot(input: ControllerProxySnapshotInput): Promise<ControllerProxySnapshotResponse> {
      try {
        const client = clientFactory({
          baseUrl: normalizeRequired(input.baseUrl, "baseUrl"),
          secret: normalizeRequired(input.secret, "secret"),
          timeoutMs: input.timeoutMs,
          groupLimit: input.groupLimit,
          optionLimit: input.optionLimit
        });
        const result = await client.getProxies();
        if (!result.ok) {
          return {
            ok: false,
            checkedAt: now().toISOString(),
            error: toViewError(resultError(result)),
            proxiesStatus: result.status
          };
        }

        const proxies = parseProxiesMap(result.body);
        return {
          ok: true,
          checkedAt: now().toISOString(),
          total: proxies.size,
          groups: summarizeGroups(proxies, input.groupLimit, input.optionLimit),
          proxiesStatus: result.status
        };
      } catch (error) {
        return {
          ok: false,
          checkedAt: now().toISOString(),
          error: toViewError(error)
        };
      }
    },

    async switchProxy(input: ControllerProxySwitchInput): Promise<ControllerProxySwitchResponse> {
      const switchedAt = now().toISOString();
      let groupName: string | undefined;
      let proxyName: string | undefined;
      try {
        groupName = normalizeRequired(input.groupName, "groupName");
        proxyName = normalizeRequired(input.proxyName, "proxyName");
        const client = clientFactory({
          baseUrl: normalizeRequired(input.baseUrl, "baseUrl"),
          secret: normalizeRequired(input.secret, "secret"),
          timeoutMs: input.timeoutMs,
          groupName,
          proxyName,
          refresh: input.refresh,
          groupLimit: input.groupLimit,
          optionLimit: input.optionLimit
        });
        const result = await client.switchProxy(groupName, proxyName);
        if (!result.ok) {
          return {
            ok: false,
            switchedAt,
            error: toViewError(resultError(result)),
            status: result.status,
            groupName,
            proxyName
          };
        }

        const response: ControllerProxySwitchResponse = {
          ok: true,
          switchedAt,
          status: result.status,
          groupName,
          proxyName
        };

        if (input.refresh ?? true) {
          const snapshot = await this.snapshot({
            baseUrl: input.baseUrl,
            secret: input.secret,
            timeoutMs: input.timeoutMs,
            groupLimit: input.groupLimit,
            optionLimit: input.optionLimit
          });
          if (snapshot.ok) {
            response.snapshot = snapshot;
          }
        }

        return response;
      } catch (error) {
        return {
          ok: false,
          switchedAt,
          error: toViewError(error),
          groupName,
          proxyName
        };
      }
    },

    async testDelay(input: ControllerProxyDelayInput): Promise<ControllerProxyDelayResponse> {
      const checkedAt = now().toISOString();
      let proxyName: string | undefined;
      let testUrl: string | undefined;
      let timeoutMs: number | undefined;
      try {
        proxyName = normalizeRequired(input.proxyName, "proxyName");
        testUrl = normalizeDelayTestUrl(input.testUrl);
        timeoutMs = normalizeDelayTimeout(input.timeoutMs);
        const client = clientFactory({
          baseUrl: normalizeRequired(input.baseUrl, "baseUrl"),
          secret: normalizeRequired(input.secret, "secret"),
          timeoutMs,
          proxyName,
          testUrl
        });
        const result = await client.testProxyDelay(proxyName, testUrl, timeoutMs);
        if (!result.ok) {
          return {
            ok: false,
            checkedAt,
            error: toViewError(resultError(result)),
            status: result.status,
            proxyName,
            testUrl,
            timeoutMs
          };
        }

        return {
          ok: true,
          checkedAt,
          proxyName,
          delayMs: parseDelay(result.body),
          status: result.status,
          testUrl,
          timeoutMs
        };
      } catch (error) {
        return {
          ok: false,
          checkedAt,
          error: toViewError(error),
          proxyName,
          testUrl,
          timeoutMs
        };
      }
    }
  };
}

function parseProxiesMap(body: string): Map<string, Record<string, unknown>> {
  const parsed = JSON.parse(body) as unknown;
  const root = objectValue(parsed);
  const proxies = objectValue(root?.proxies);
  if (!proxies) {
    throw new Error("Controller proxies response must contain a proxies object");
  }

  return new Map(
    Object.entries(proxies).filter((entry): entry is [string, Record<string, unknown>] =>
      Boolean(objectValue(entry[1]))
    )
  );
}

function summarizeGroups(
  proxies: Map<string, Record<string, unknown>>,
  groupLimitInput: number | undefined,
  optionLimitInput: number | undefined
): ControllerProxyGroupSummary[] {
  const groupLimit = clampLimit(groupLimitInput, DEFAULT_GROUP_LIMIT, 100);
  const optionLimit = clampLimit(optionLimitInput, DEFAULT_OPTION_LIMIT, 50);
  const groups = [...proxies.entries()]
    .map(([name, proxy]) => summarizeGroup(name, proxy, optionLimit))
    .filter((group): group is ControllerProxyGroupSummary => group !== null);

  return groups.slice(0, groupLimit);
}

function summarizeGroup(
  name: string,
  proxy: Record<string, unknown>,
  optionLimit: number
): ControllerProxyGroupSummary | null {
  const all = stringArray(proxy.all);
  if (all.length === 0) {
    return null;
  }

  return {
    name,
    type: stringValue(proxy.type) ?? "unknown",
    current: stringValue(proxy.now),
    optionCount: all.length,
    options: all.slice(0, optionLimit)
  };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(max, Math.trunc(value)));
}

function normalizeDelayTestUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_DELAY_TEST_URL;
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("delay testUrl must use http or https");
  }
  return parsed.toString();
}

function normalizeDelayTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_DELAY_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.min(30_000, Math.trunc(value)));
}

function parseDelay(body: string): number {
  const parsed = JSON.parse(body) as unknown;
  const record = objectValue(parsed);
  const delay = record?.delay;
  if (typeof delay !== "number" || !Number.isFinite(delay)) {
    throw new Error("Controller delay response must contain numeric delay");
  }
  return delay;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
