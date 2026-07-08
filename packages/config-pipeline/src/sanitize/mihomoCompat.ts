import type { JsonObject, JsonValue, MihomoConfig, MihomoProxyGroup, PipelineWarning } from "../types.js";

const GROUP_ONLY_REMOVED_FIELDS = ["routing-mark", "interface-name", "dialer-proxy"] as const;
const DEFAULT_HEALTH_URL = "https://www.gstatic.com/generate_204";

export interface SanitizeResult {
  config: MihomoConfig;
  warnings: PipelineWarning[];
}

export function sanitizeMihomoConfig(input: MihomoConfig): SanitizeResult {
  const warnings: PipelineWarning[] = [];
  const config = cloneObject(input) as MihomoConfig;

  if ("global-client-fingerprint" in config) {
    delete config["global-client-fingerprint"];
    warnings.push({
      code: "deprecated.global-client-fingerprint",
      message: "Removed deprecated global-client-fingerprint from root config.",
      path: "$.global-client-fingerprint"
    });
  }

  if (Array.isArray(config["proxy-groups"])) {
    config["proxy-groups"] = config["proxy-groups"].map((group, index) =>
      sanitizeProxyGroup(group, index, warnings)
    );
  }

  return { config, warnings };
}

function sanitizeProxyGroup(
  group: MihomoProxyGroup,
  index: number,
  warnings: PipelineWarning[]
): MihomoProxyGroup {
  const next = cloneObject(group) as MihomoProxyGroup;
  const basePath = `$.proxy-groups[${index}]`;

  for (const field of GROUP_ONLY_REMOVED_FIELDS) {
    if (field in next) {
      delete next[field];
      warnings.push({
        code: `removed.proxy-group.${field}`,
        message: `Removed ${field} from proxy group because Mihomo rejects it at group level.`,
        path: `${basePath}.${field}`
      });
    }
  }

  if (next.type === "smart") {
    next.type = hasUsableMembers(next) ? "url-test" : "select";
    next.url = typeof next.url === "string" ? next.url : DEFAULT_HEALTH_URL;
    next.interval = typeof next.interval === "number" ? next.interval : 300;
    next.tolerance = typeof next.tolerance === "number" ? next.tolerance : 50;
    warnings.push({
      code: "compat.smart-downgrade",
      message: "Downgraded smart proxy group for stable-core compatibility.",
      path: `${basePath}.type`
    });
  }

  if (next.type === "relay") {
    next.type = "select";
    warnings.push({
      code: "removed.proxy-group.relay",
      message: "Downgraded removed relay proxy group to select.",
      path: `${basePath}.type`
    });
  }

  return next;
}

function hasUsableMembers(group: MihomoProxyGroup): boolean {
  return (
    (Array.isArray(group.proxies) && group.proxies.length > 0) ||
    (Array.isArray(group.use) && group.use.length > 0)
  );
}

function cloneObject(value: JsonObject): JsonObject {
  return Object.entries(value).reduce<JsonObject>((acc, [key, child]) => {
    acc[key] = cloneValue(child);
    return acc;
  }, {});
}

function cloneValue(value: JsonObject[string]): JsonValue {
  if (value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }

  if (typeof value === "object" && value !== null) {
    return cloneObject(value as JsonObject);
  }

  return value;
}
