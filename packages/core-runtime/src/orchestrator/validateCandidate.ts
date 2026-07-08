import type { ConfigStore } from "../store/configStore.js";
import {
  checkMihomoConfig,
  type CheckConfigResult,
  type CheckConfigOptions
} from "../runtime/checker.js";

export interface ValidateCandidateOptions {
  profileId: string;
  store: ConfigStore;
  binaryPath: string;
  dataDir: string;
  timeoutMs?: number;
  runner?: CheckConfigOptions["runner"];
}

export type ValidateCandidateResult =
  | {
      ok: true;
      candidatePath: string;
      stdout: string;
      stderr: string;
    }
  | {
      ok: false;
      stage: "offline-check";
      candidatePath: string;
      error: Error;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    };

export async function validateCandidate(
  options: ValidateCandidateOptions
): Promise<ValidateCandidateResult> {
  const { candidatePath } = options.store.pathsForProfile(options.profileId);
  const result = await checkMihomoConfig({
    binaryPath: options.binaryPath,
    configPath: candidatePath,
    dataDir: options.dataDir,
    timeoutMs: options.timeoutMs,
    runner: options.runner
  });

  return toValidateResult(candidatePath, result);
}

function toValidateResult(
  candidatePath: string,
  result: CheckConfigResult
): ValidateCandidateResult {
  if (result.ok) {
    return {
      ok: true,
      candidatePath,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  return {
    ok: false,
    stage: "offline-check",
    candidatePath,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  };
}
