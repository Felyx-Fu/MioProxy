import {
  createControllerClient,
  type ControllerClient,
  type ControllerClientResult
} from "@mioproxy/core-runtime";
import type {
  ControllerRuleProviderSummary,
  ControllerRulesSnapshotInput,
  ControllerRulesSnapshotResponse,
  ControllerRuleSummary
} from "../../shared/pipelineTypes.js";

export interface ControllerRuleServiceOptions {
  clientFactory?: (input: ControllerRulesSnapshotInput) => ControllerClient;
  now?: () => Date;
}

export interface ControllerRuleService {
  snapshot(input: ControllerRulesSnapshotInput): Promise<ControllerRulesSnapshotResponse>;
}

const DEFAULT_RULE_LIMIT = 20;
const DEFAULT_PROVIDER_LIMIT = 20;

export function createControllerRuleService(
  options: ControllerRuleServiceOptions = {}
): ControllerRuleService {
  const clientFactory =
    options.clientFactory ??
    ((input: ControllerRulesSnapshotInput) =>
      createControllerClient({
        baseUrl: input.baseUrl,
        secret: input.secret,
        timeoutMs: input.timeoutMs
      }));
  const now = options.now ?? (() => new Date());

  return {
    async snapshot(input: ControllerRulesSnapshotInput): Promise<ControllerRulesSnapshotResponse> {
      try {
        const client = clientFactory({
          baseUrl: normalizeRequired(input.baseUrl, "baseUrl"),
          secret: normalizeRequired(input.secret, "secret"),
          timeoutMs: input.timeoutMs,
          ruleLimit: input.ruleLimit,
          providerLimit: input.providerLimit
        });
        const [rulesResult, providersResult] = await Promise.all([
          client.getRules(),
          client.getRuleProviders()
        ]);

        if (!rulesResult.ok || !providersResult.ok) {
          return {
            ok: false,
            checkedAt: now().toISOString(),
            error: toViewError(resultError(rulesResult.ok ? providersResult : rulesResult)),
            rulesStatus: rulesResult.status,
            providersStatus: providersResult.status
          };
        }

        const rules = parseRules(rulesResult.body);
        const providers = parseRuleProviders(providersResult.body);
        return {
          ok: true,
          checkedAt: now().toISOString(),
          rules: {
            total: rules.length,
            items: rules.slice(0, clampLimit(input.ruleLimit, DEFAULT_RULE_LIMIT, 100))
          },
          providers: {
            total: providers.length,
            items: providers.slice(0, clampLimit(input.providerLimit, DEFAULT_PROVIDER_LIMIT, 100))
          },
          rulesStatus: rulesResult.status,
          providersStatus: providersResult.status
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

function parseRules(body: string): ControllerRuleSummary[] {
  const root = parseJsonRecord(body);
  const rules = Array.isArray(root.rules) ? root.rules : [];
  return rules.map((item) => {
    const record = objectValue(item) ?? {};
    return {
      type: stringValue(record.type),
      payload: stringValue(record.payload),
      proxy: stringValue(record.proxy),
      size: numberValue(record.size)
    };
  });
}

function parseRuleProviders(body: string): ControllerRuleProviderSummary[] {
  const root = parseJsonRecord(body);
  const providers = objectValue(root.providers) ?? {};
  return Object.entries(providers)
    .map(([name, value]) => {
      const record = objectValue(value) ?? {};
      return {
        name,
        type: stringValue(record.type),
        behavior: stringValue(record.behavior),
        vehicleType: stringValue(record.vehicleType) ?? stringValue(record["vehicle-type"]),
        ruleCount: numberValue(record.ruleCount) ?? numberValue(record["rule-count"]) ?? ruleCount(record),
        updatedAt:
          stringValue(record.updatedAt) ??
          stringValue(record.updateTime) ??
          stringValue(record.updated)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseJsonRecord(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Controller response must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function ruleCount(record: Record<string, unknown>): number | undefined {
  const rules = record.rules;
  return Array.isArray(rules) ? rules.length : undefined;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(max, Math.trunc(value)));
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
