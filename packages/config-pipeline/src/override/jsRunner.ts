import vm from "node:vm";
import type { JsonObject } from "../types.js";

export interface JsOverrideOptions {
  script: string;
  config: JsonObject;
  timeoutMs?: number;
  filename?: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;

export function runJsOverride(options: JsOverrideOptions): JsonObject {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const input = cloneObject(options.config);
  const sandbox = {
    config: input,
    structuredClone,
    console: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }
  };
  const context = vm.createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false
    }
  });
  const source = `${options.script}\n;main(config);`;
  const script = new vm.Script(source, {
    filename: options.filename ?? "override.js"
  });

  const result = script.runInContext(context, { timeout: timeoutMs }) as unknown;
  if (!isPlainObject(result)) {
    throw new Error("JS override main(config) must return an object");
  }

  return result;
}

function cloneObject(value: JsonObject): JsonObject {
  return structuredClone(value) as JsonObject;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
