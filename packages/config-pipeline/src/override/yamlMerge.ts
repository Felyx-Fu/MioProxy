import type { JsonObject, JsonValue } from "../types.js";

export function applyYamlOverride(base: JsonObject, override: JsonObject): JsonObject {
  return mergeObject(cloneObject(base), override);
}

function mergeObject(base: JsonObject, override: JsonObject): JsonObject {
  const output = cloneObject(base);

  for (const [rawKey, overrideValue] of Object.entries(override)) {
    if (rawKey.endsWith("!")) {
      output[rawKey.slice(0, -1)] = cloneValue(overrideValue);
      continue;
    }

    if (rawKey.startsWith("+")) {
      const key = rawKey.slice(1);
      output[key] = mergeArrayEdge(output[key], overrideValue, "prepend", key);
      continue;
    }

    if (rawKey.endsWith("+")) {
      const key = rawKey.slice(0, -1);
      output[key] = mergeArrayEdge(output[key], overrideValue, "append", key);
      continue;
    }

    const current = output[rawKey];
    if (isPlainObject(current) && isPlainObject(overrideValue)) {
      output[rawKey] = mergeObject(current, overrideValue);
      continue;
    }

    output[rawKey] = cloneValue(overrideValue);
  }

  return output;
}

function mergeArrayEdge(
  current: JsonValue | undefined,
  next: JsonValue | undefined,
  mode: "prepend" | "append",
  key: string
): JsonValue[] {
  if (!Array.isArray(next)) {
    throw new Error(`Override key ${mode === "prepend" ? "+" : ""}${key}${mode === "append" ? "+" : ""} must be an array`);
  }

  const currentArray = Array.isArray(current) ? current : [];
  const clonedNext = next.map((item) => cloneValue(item));
  const clonedCurrent = currentArray.map((item) => cloneValue(item));
  return mode === "prepend" ? [...clonedNext, ...clonedCurrent] : [...clonedCurrent, ...clonedNext];
}

function cloneObject(value: JsonObject): JsonObject {
  return cloneValue(value) as JsonObject;
}

function cloneValue(value: JsonValue | undefined): JsonValue {
  if (value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }

  if (isPlainObject(value)) {
    return Object.entries(value).reduce<JsonObject>((acc, [key, child]) => {
      acc[key] = cloneValue(child);
      return acc;
    }, {});
  }

  return value;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
