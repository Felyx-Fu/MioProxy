import type {
  ActivationActionResponse,
  ActivationStartInput,
  ActivationStatusResponse,
  ControllerHealthResponse
} from "../../shared/pipelineTypes.js";
import type { ConfigStore } from "@mioproxy/core-runtime";
import type { ControllerHealthService } from "../core/controllerHealthService.js";
import type { ControllerLogService } from "../core/controllerLogService.js";
import type { CoreProcessService } from "../core/coreProcessService.js";
import type { SystemProxyService } from "../system/systemProxyService.js";

export interface ConnectionServiceOptions {
  core: CoreProcessService;
  controllerHealth: ControllerHealthService;
  controllerLogs: ControllerLogService;
  systemProxy: SystemProxyService;
  configStore?: ConfigStore;
  sleep?: (timeoutMs: number) => Promise<void>;
}

type ActivationStep = ActivationStatusResponse["steps"][number];
type ActivationRollback = NonNullable<ActivationStatusResponse["rollback"]>;

export function createConnectionService(options: ConnectionServiceOptions) {
  const sleep = options.sleep ?? ((timeoutMs: number) => new Promise((resolve) => setTimeout(resolve, timeoutMs)));
  let lastStatus: ActivationStatusResponse = {
    profileId: "",
    connected: false,
    steps: []
  };

  return {
    status(profileId: string): ActivationStatusResponse {
      if (lastStatus.profileId !== profileId) {
        return {
          profileId,
          connected: false,
          steps: []
        };
      }
      return lastStatus;
    },

    async connect(input: ActivationStartInput): Promise<ActivationActionResponse> {
      const profileId = normalizeRequired(input.profileId, "profileId");
      const steps: ActivationStep[] = [];
      let coreStarted = false;
      let logsStarted = false;
      let proxyEnabled = false;

      const update = (step: ActivationStep): void => {
        steps.push(step);
        lastStatus = {
          profileId,
          connected: false,
          steps: [...steps]
        };
      };

      try {
        const coreResult = await options.core.start({
          profileId,
          binaryPath: input.binaryPath,
          dataDir: input.dataDir
        });
        if (!coreResult.ok) {
          update(failedStep("start-core", coreResult.error.message));
          throw new Error(coreResult.error.message);
        }
        coreStarted = true;
        update({ name: "start-core", ok: true });

        const health = await waitForHealthyController(input, update, sleep, options.controllerHealth);
        if (!health.ok) {
          throw new Error(health.error.message);
        }

        if (input.startControllerLogs !== false) {
          const logsResult = await options.controllerLogs.start({
            profileId,
            baseUrl: input.controller.baseUrl,
            secret: input.controller.secret,
            level: "info"
          });
          if (!logsResult.ok) {
            update(failedStep("start-controller-logs", logsResult.error.message));
            throw new Error(logsResult.error.message);
          }
          logsStarted = true;
          update({ name: "start-controller-logs", ok: true });
        } else {
          update({ name: "start-controller-logs", ok: true, skipped: true });
        }

        if (input.enableSystemProxy !== false) {
          const proxyResult = await options.systemProxy.enable(input.systemProxy);
          if (!proxyResult.ok) {
            update(failedStep("enable-system-proxy", proxyResult.error.message));
            throw new Error(proxyResult.error.message);
          }
          proxyEnabled = true;
          update({ name: "enable-system-proxy", ok: true });
        } else {
          update({ name: "enable-system-proxy", ok: true, skipped: true });
        }

        if (options.configStore) {
          try {
            await options.configStore.markLastKnownGood(profileId);
          } catch (error) {
            const message = toViewError(error).message;
            update(failedStep("mark-last-known-good", message));
            throw new Error(message);
          }
          update({ name: "mark-last-known-good", ok: true });
        } else {
          update({ name: "mark-last-known-good", ok: true, skipped: true });
        }

        lastStatus = {
          profileId,
          connected: true,
          steps: [...steps],
          health
        };
        return { ok: true, status: lastStatus };
      } catch (error) {
        const rollback = await rollbackConnection({
          profileId,
          proxyEnabled,
          logsStarted,
          coreStarted,
          systemProxy: options.systemProxy,
          controllerLogs: options.controllerLogs,
          core: options.core,
          configStore: options.configStore
        });
        lastStatus = {
          profileId,
          connected: false,
          steps: [...steps],
          rollback
        };
        return { ok: false, error: toViewError(error), status: lastStatus };
      }
    },

    async disconnect(profileIdInput: string): Promise<ActivationActionResponse> {
      const profileId = normalizeRequired(profileIdInput, "profileId");
      const rollback = await rollbackConnection({
        profileId,
        proxyEnabled: true,
        logsStarted: true,
        coreStarted: true,
        systemProxy: options.systemProxy,
        controllerLogs: options.controllerLogs,
        core: options.core,
        configStore: options.configStore
      });
      lastStatus = {
        profileId,
        connected: false,
        steps: [
          { name: "restore-system-proxy", ok: rollback.systemProxy.ok },
          { name: "stop-controller-logs", ok: rollback.controllerLogs.ok },
          { name: "stop-core", ok: rollback.core.ok },
          { name: "restore-active-config", ok: rollback.config.ok }
        ],
        rollback
      };

      if (
        !rollback.systemProxy.ok ||
        !rollback.controllerLogs.ok ||
        !rollback.core.ok ||
        !rollback.config.ok
      ) {
        return {
          ok: false,
          error: { name: "DisconnectError", message: "One or more disconnect steps failed" },
          status: lastStatus
        };
      }

      return { ok: true, status: lastStatus };
    }
  };
}

async function waitForHealthyController(
  input: ActivationStartInput,
  update: (step: ActivationStep) => void,
  sleep: (timeoutMs: number) => Promise<void>,
  controllerHealth: ControllerHealthService
): Promise<ControllerHealthResponse> {
  const attempts = Math.max(1, input.health?.attempts ?? 5);
  const delayMs = Math.max(0, input.health?.delayMs ?? 500);
  let last: ControllerHealthResponse | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await controllerHealth.check({
      baseUrl: input.controller.baseUrl,
      secret: input.controller.secret,
      timeoutMs: input.controller.timeoutMs
    });
    if (last.ok) {
      update({ name: "controller-health", ok: true });
      return last;
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  const message = last && !last.ok ? last.error.message : "Controller health check failed";
  update(failedStep("controller-health", message));
  return last ?? {
    ok: false,
    online: false,
    checkedAt: new Date().toISOString(),
    error: { name: "ControllerHealthError", message }
  };
}

async function rollbackConnection(options: {
  profileId: string;
  proxyEnabled: boolean;
  logsStarted: boolean;
  coreStarted: boolean;
  systemProxy: SystemProxyService;
  controllerLogs: ControllerLogService;
  core: CoreProcessService;
  configStore?: ConfigStore;
}): Promise<ActivationRollback> {
  const systemProxy = options.proxyEnabled
    ? await options.systemProxy.restore()
    : { ok: true as const, status: await options.systemProxy.status() };
  const controllerLogs = options.logsStarted
    ? await options.controllerLogs.stop(options.profileId)
    : { ok: true as const, status: options.controllerLogs.status(options.profileId) };
  const core = options.coreStarted
    ? await options.core.stop(options.profileId)
    : { ok: true as const, status: options.core.status(options.profileId) };
  const config = await restoreActiveConfig(options.configStore, options.profileId);

  return {
    systemProxy: { ok: systemProxy.ok, errorMessage: systemProxy.ok ? undefined : systemProxy.error.message },
    controllerLogs: {
      ok: controllerLogs.ok,
      errorMessage: controllerLogs.ok ? undefined : controllerLogs.error.message
    },
    core: { ok: core.ok, errorMessage: core.ok ? undefined : core.error.message },
    config
  };
}

async function restoreActiveConfig(
  configStore: ConfigStore | undefined,
  profileId: string
): Promise<{ ok: boolean; errorMessage?: string }> {
  if (!configStore) {
    return { ok: true };
  }

  try {
    await configStore.rollbackToLastKnownGood(profileId);
    return { ok: true };
  } catch (error) {
    return { ok: false, errorMessage: toViewError(error).message };
  }
}

function failedStep(name: ActivationStep["name"], message: string): ActivationStep {
  return {
    name,
    ok: false,
    errorMessage: message
  };
}

function normalizeRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function toViewError(error: unknown): { name: string; message: string } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return { name: normalized.name, message: normalized.message };
}
