import type { ConfigStore } from "../store/configStore.js";

export type RenderAndStageStage =
  | "download"
  | "parse"
  | "yaml-override"
  | "js-override"
  | "sanitize"
  | "serialize"
  | "stage-candidate";

export interface PipelineWarning {
  code: string;
  message: string;
  path: string;
}

export type RenderForStageResult =
  | {
      ok: true;
      renderedYaml: string;
      rawSource: "network" | "cache";
      downloadAttempts: number;
      warnings: PipelineWarning[];
    }
  | {
      ok: false;
      stage: Exclude<RenderAndStageStage, "stage-candidate">;
      error: Error;
      overrideId?: string;
      downloadAttempts?: number;
    };

export type RenderForStage = () => Promise<RenderForStageResult>;

export interface RenderAndStageOptions {
  profileId: string;
  store: ConfigStore;
  render: RenderForStage;
}

export type RenderAndStageResult =
  | {
      ok: true;
      candidatePath: string;
      rawSource: "network" | "cache";
      downloadAttempts: number;
      warnings: PipelineWarning[];
    }
  | {
      ok: false;
      stage: RenderAndStageStage;
      error: Error;
      overrideId?: string;
      downloadAttempts?: number;
    };

export async function renderAndStage(options: RenderAndStageOptions): Promise<RenderAndStageResult> {
  const rendered = await options.render();
  if (!rendered.ok) {
    return renderFailure(rendered);
  }

  try {
    const candidatePath = await options.store.writeCandidate(options.profileId, rendered.renderedYaml);
    return {
      ok: true,
      candidatePath,
      rawSource: rendered.rawSource,
      downloadAttempts: rendered.downloadAttempts,
      warnings: rendered.warnings
    };
  } catch (error) {
    return {
      ok: false,
      stage: "stage-candidate",
      error: toError(error),
      downloadAttempts: rendered.downloadAttempts
    };
  }
}

function renderFailure(rendered: Extract<RenderForStageResult, { ok: false }>): RenderAndStageResult {
  return {
    ok: false,
    stage: rendered.stage,
    error: rendered.error,
    overrideId: rendered.overrideId,
    downloadAttempts: rendered.downloadAttempts
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
