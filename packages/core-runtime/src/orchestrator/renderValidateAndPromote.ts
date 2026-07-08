import type { CommandRunner } from "../types.js";
import type { ConfigStore } from "../store/configStore.js";
import { renderAndStage, type RenderAndStageResult, type RenderForStage } from "./renderAndStage.js";
import { validateCandidate, type ValidateCandidateResult } from "./validateCandidate.js";
import {
  promoteValidatedCandidate,
  type PromoteValidatedCandidateResult
} from "./promoteValidatedCandidate.js";

export interface RenderValidateAndPromoteOptions {
  profileId: string;
  store: ConfigStore;
  render: RenderForStage;
  checker: {
    binaryPath: string;
    dataDir: string;
    timeoutMs?: number;
    runner?: CommandRunner;
  };
}

export type RenderValidateAndPromoteResult =
  | {
      ok: true;
      stage: "promoted";
      render: Extract<RenderAndStageResult, { ok: true }>;
      validation: Extract<ValidateCandidateResult, { ok: true }>;
      promotion: Extract<PromoteValidatedCandidateResult, { ok: true }>;
    }
  | {
      ok: false;
      stage: "render-stage" | "offline-check" | "promote-active";
      error: Error;
      render?: RenderAndStageResult;
      validation?: ValidateCandidateResult;
      promotion?: PromoteValidatedCandidateResult;
    };

export async function renderValidateAndPromote(
  options: RenderValidateAndPromoteOptions
): Promise<RenderValidateAndPromoteResult> {
  const render = await renderAndStage({
    profileId: options.profileId,
    store: options.store,
    render: options.render
  });
  if (!render.ok) {
    return {
      ok: false,
      stage: "render-stage",
      error: render.error,
      render
    };
  }

  const validation = await validateCandidate({
    profileId: options.profileId,
    store: options.store,
    binaryPath: options.checker.binaryPath,
    dataDir: options.checker.dataDir,
    timeoutMs: options.checker.timeoutMs,
    runner: options.checker.runner
  });
  if (!validation.ok) {
    return {
      ok: false,
      stage: "offline-check",
      error: validation.error,
      render,
      validation
    };
  }

  const promotion = await promoteValidatedCandidate({
    profileId: options.profileId,
    store: options.store,
    validation
  });
  if (!promotion.ok) {
    return {
      ok: false,
      stage: "promote-active",
      error: promotion.error,
      render,
      validation,
      promotion
    };
  }

  return {
    ok: true,
    stage: "promoted",
    render,
    validation,
    promotion
  };
}
