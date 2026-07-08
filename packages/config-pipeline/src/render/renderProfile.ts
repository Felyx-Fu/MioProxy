import type { JsonObject, MihomoConfig, PipelineWarning } from "../types.js";
import { parseYamlToObject, stringifyStableYaml } from "../config/yaml.js";
import { applyYamlOverride } from "../override/yamlMerge.js";
import { runJsOverride } from "../override/jsRunner.js";
import { sanitizeMihomoConfig } from "../sanitize/mihomoCompat.js";
import {
  downloadSubscription,
  type SubscriptionCache,
  type SubscriptionDownloadResult
} from "../subscription/downloader.js";

export type RenderStage = "download" | "parse" | "yaml-override" | "js-override" | "sanitize" | "serialize";

export interface YamlOverrideRef {
  id: string;
  value: JsonObject;
}

export interface JsOverrideRef {
  id: string;
  script: string;
  timeoutMs?: number;
}

export type ConfigOverrideRef =
  | ({ kind: "yaml" } & YamlOverrideRef)
  | ({ kind: "js" } & JsOverrideRef);

export interface RenderProfileOptions {
  profileId: string;
  subscription: {
    url: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    retries?: number;
    cache: SubscriptionCache;
    fetcher?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  };
  overrides?: ConfigOverrideRef[];
  yamlOverrides?: YamlOverrideRef[];
  jsOverrides?: JsOverrideRef[];
  finalYamlOverrides?: YamlOverrideRef[];
}

export type RenderProfileResult =
  | {
      ok: true;
      rawYaml: string;
      rawSource: "network" | "cache";
      downloadAttempts: number;
      config: MihomoConfig;
      renderedYaml: string;
      warnings: PipelineWarning[];
    }
  | {
      ok: false;
      stage: RenderStage;
      error: Error;
      overrideId?: string;
      downloadAttempts?: number;
    };

export async function renderProfile(options: RenderProfileOptions): Promise<RenderProfileResult> {
  const downloaded = await downloadSubscription({
    profileId: options.profileId,
    ...options.subscription
  });

  if (!downloaded.ok) {
    return fail("download", downloaded.error, { downloadAttempts: downloaded.attempts });
  }

  let config: JsonObject;
  try {
    config = parseYamlToObject(downloaded.contents);
  } catch (error) {
    return fail("parse", toError(error), downloadMeta(downloaded));
  }

  for (const override of orderedOverrides(options)) {
    try {
      if (override.kind === "yaml") {
        config = applyYamlOverride(config, override.value);
      } else {
        config = runJsOverride({
          config,
          script: override.script,
          timeoutMs: override.timeoutMs,
          filename: `${override.id}.js`
        });
      }
    } catch (error) {
      return fail(override.kind === "yaml" ? "yaml-override" : "js-override", toError(error), {
        ...downloadMeta(downloaded),
        overrideId: override.id
      });
    }
  }

  for (const override of options.finalYamlOverrides ?? []) {
    try {
      config = applyYamlOverride(config, override.value);
    } catch (error) {
      return fail("yaml-override", toError(error), {
        ...downloadMeta(downloaded),
        overrideId: override.id
      });
    }
  }

  let sanitized: ReturnType<typeof sanitizeMihomoConfig>;
  try {
    sanitized = sanitizeMihomoConfig(config as MihomoConfig);
  } catch (error) {
    return fail("sanitize", toError(error), downloadMeta(downloaded));
  }

  try {
    return {
      ok: true,
      rawYaml: downloaded.contents,
      rawSource: downloaded.source,
      downloadAttempts: downloaded.attempts,
      config: sanitized.config,
      renderedYaml: stringifyStableYaml(sanitized.config),
      warnings: sanitized.warnings
    };
  } catch (error) {
    return fail("serialize", toError(error), downloadMeta(downloaded));
  }
}

function orderedOverrides(options: RenderProfileOptions): ConfigOverrideRef[] {
  return [
    ...(options.overrides ?? []),
    ...(options.yamlOverrides ?? []).map((override) => ({ ...override, kind: "yaml" as const })),
    ...(options.jsOverrides ?? []).map((override) => ({ ...override, kind: "js" as const }))
  ];
}

function downloadMeta(downloaded: Extract<SubscriptionDownloadResult, { ok: true }>): {
  downloadAttempts: number;
} {
  return { downloadAttempts: downloaded.attempts };
}

function fail(
  stage: RenderStage,
  error: Error,
  extras: { overrideId?: string; downloadAttempts?: number } = {}
): RenderProfileResult {
  return { ok: false, stage, error, ...extras };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
