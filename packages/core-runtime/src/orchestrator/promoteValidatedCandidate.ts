import type { ConfigStore } from "../store/configStore.js";
import type { ValidateCandidateResult } from "./validateCandidate.js";

export interface PromoteValidatedCandidateOptions {
  profileId: string;
  store: ConfigStore;
  validation: ValidateCandidateResult;
}

export type PromoteValidatedCandidateResult =
  | {
      ok: true;
      activePath: string;
      candidatePath: string;
      stdout: string;
      stderr: string;
    }
  | {
      ok: false;
      stage: "offline-check" | "promote-active";
      candidatePath: string;
      error: Error;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
    };

export async function promoteValidatedCandidate(
  options: PromoteValidatedCandidateOptions
): Promise<PromoteValidatedCandidateResult> {
  if (!options.validation.ok) {
    return {
      ok: false,
      stage: "offline-check",
      candidatePath: options.validation.candidatePath,
      error: options.validation.error,
      stdout: options.validation.stdout,
      stderr: options.validation.stderr,
      timedOut: options.validation.timedOut
    };
  }

  try {
    const activePath = await options.store.promoteCandidateToActive(options.profileId);
    return {
      ok: true,
      activePath,
      candidatePath: options.validation.candidatePath,
      stdout: options.validation.stdout,
      stderr: options.validation.stderr
    };
  } catch (error) {
    return {
      ok: false,
      stage: "promote-active",
      candidatePath: options.validation.candidatePath,
      error: toError(error),
      stdout: options.validation.stdout,
      stderr: options.validation.stderr
    };
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
