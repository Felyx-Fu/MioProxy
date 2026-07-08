import {
  renderValidatePromoteAndApply,
  type RenderValidatePromoteAndApplyOptions,
  type RenderValidatePromoteAndApplyResult
} from "./renderValidatePromoteAndApply.js";
import {
  saveFailureBundle,
  type SaveFailureBundleResult
} from "../diagnostics/failureBundle.js";

export interface RunProfilePipelineOptions extends RenderValidatePromoteAndApplyOptions {
  diagnostics: {
    rootDir: string;
    sessionId: string;
    now?: Date;
  };
}

export type RunProfilePipelineResult =
  | {
      ok: true;
      result: Extract<RenderValidatePromoteAndApplyResult, { ok: true }>;
      failureBundle?: undefined;
    }
  | {
      ok: false;
      result: Extract<RenderValidatePromoteAndApplyResult, { ok: false }>;
      failureBundle: SaveFailureBundleResult;
    };

export async function runProfilePipeline(
  options: RunProfilePipelineOptions
): Promise<RunProfilePipelineResult> {
  const result = await renderValidatePromoteAndApply(options);
  if (result.ok) {
    return { ok: true, result };
  }

  const failureBundle = await saveFailureBundle({
    rootDir: options.diagnostics.rootDir,
    profileId: options.profileId,
    sessionId: options.diagnostics.sessionId,
    now: options.diagnostics.now,
    result
  });

  return { ok: false, result, failureBundle };
}
