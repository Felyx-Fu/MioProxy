import type { ConfigStore } from "../store/configStore.js";
import type { ControllerClient, ControllerClientResult } from "../runtime/controllerClient.js";

export interface ApplyActiveConfigOptions {
  profileId: string;
  activePath: string;
  store: ConfigStore;
  controller: ControllerClient;
}

export type ApplyActiveConfigResult =
  | {
      ok: true;
      mode: "hot-reload" | "restart";
      activePath: string;
      lastKnownGoodPath: string;
      controllerResult: ControllerClientResult;
    }
  | {
      ok: false;
      stage: "hot-reload" | "restart" | "mark-last-known-good" | "rollback" | "rollback-restart";
      activePath: string;
      error: Error;
      reloadResult?: ControllerClientResult;
      restartResult?: ControllerClientResult;
      rollbackPath?: string;
      rollbackRestartResult?: ControllerClientResult;
      rolledBack: boolean;
    };

export async function applyActiveConfig(
  options: ApplyActiveConfigOptions
): Promise<ApplyActiveConfigResult> {
  const reloadResult = await options.controller.reloadConfig(options.activePath);
  if (reloadResult.ok) {
    return markAppliedConfigGood({
      profileId: options.profileId,
      activePath: options.activePath,
      store: options.store,
      mode: "hot-reload",
      controllerResult: reloadResult
    });
  }

  const restartResult = await options.controller.restart(options.activePath);
  if (restartResult.ok) {
    return markAppliedConfigGood({
      profileId: options.profileId,
      activePath: options.activePath,
      store: options.store,
      mode: "restart",
      controllerResult: restartResult
    });
  }

  return rollbackAfterApplyFailure({
    profileId: options.profileId,
    activePath: options.activePath,
    store: options.store,
    controller: options.controller,
    reloadResult,
    restartResult
  });
}

async function markAppliedConfigGood(options: {
  profileId: string;
  activePath: string;
  store: ConfigStore;
  mode: "hot-reload" | "restart";
  controllerResult: ControllerClientResult;
}): Promise<ApplyActiveConfigResult> {
  try {
    const lastKnownGoodPath = await options.store.markLastKnownGood(options.profileId);
    return {
      ok: true,
      mode: options.mode,
      activePath: options.activePath,
      lastKnownGoodPath,
      controllerResult: options.controllerResult
    };
  } catch (error) {
    return {
      ok: false,
      stage: "mark-last-known-good",
      activePath: options.activePath,
      error: toError(error),
      rolledBack: false
    };
  }
}

async function rollbackAfterApplyFailure(options: {
  profileId: string;
  activePath: string;
  store: ConfigStore;
  controller: ControllerClient;
  reloadResult: ControllerClientResult;
  restartResult: ControllerClientResult;
}): Promise<ApplyActiveConfigResult> {
  const rollbackPath = await options.store.rollbackToLastKnownGood(options.profileId);
  if (!rollbackPath) {
    return {
      ok: false,
      stage: "restart",
      activePath: options.activePath,
      error: resultError(options.restartResult),
      reloadResult: options.reloadResult,
      restartResult: options.restartResult,
      rolledBack: false
    };
  }

  const rollbackRestartResult = await options.controller.restart(rollbackPath);
  if (!rollbackRestartResult.ok) {
    return {
      ok: false,
      stage: "rollback-restart",
      activePath: options.activePath,
      error: resultError(rollbackRestartResult),
      reloadResult: options.reloadResult,
      restartResult: options.restartResult,
      rollbackPath,
      rollbackRestartResult,
      rolledBack: true
    };
  }

  return {
    ok: false,
    stage: "restart",
    activePath: options.activePath,
    error: resultError(options.restartResult),
    reloadResult: options.reloadResult,
    restartResult: options.restartResult,
    rollbackPath,
    rollbackRestartResult,
    rolledBack: true
  };
}

function resultError(result: ControllerClientResult): Error {
  return result.ok ? new Error("Controller operation unexpectedly succeeded") : result.error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
