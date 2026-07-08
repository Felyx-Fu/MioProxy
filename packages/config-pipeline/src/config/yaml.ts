import YAML from "yaml";
import type { JsonObject, JsonValue } from "../types.js";

export function parseYamlToObject(source: string): JsonObject {
  const parsed = YAML.parse(source) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("YAML root must be an object");
  }
  return parsed as JsonObject;
}

export function stringifyStableYaml(value: JsonObject): string {
  return YAML.stringify(sortKeys(value), {
    lineWidth: 0,
    singleQuote: false
  });
}

function sortKeys(value: JsonValue | undefined): JsonValue {
  if (value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<JsonObject>((acc, key) => {
      const next = value[key];
      if (next !== undefined) {
        acc[key] = sortKeys(next);
      }
      return acc;
    }, {});
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
