import {
  createControllerLogCollector,
  createCoreLogStore,
  type ControllerLogCollector,
  type CreateControllerLogCollectorOptions
} from "@mioproxy/core-runtime";
import type {
  ControllerLogActionResponse,
  ControllerLogStartInput,
  ControllerLogStatusResponse
} from "../../shared/pipelineTypes.js";

export interface ControllerLogServiceOptions {
  appDataDir: string;
  createCollector?: (options: CreateControllerLogCollectorOptions) => ControllerLogCollector;
  now?: () => Date;
}

export interface ControllerLogService {
  start(input: ControllerLogStartInput): Promise<ControllerLogActionResponse>;
  stop(profileId: string): Promise<ControllerLogActionResponse>;
  stopAll(): Promise<ControllerLogStatusResponse[]>;
  status(profileId: string): ControllerLogStatusResponse;
  hasRunning(): boolean;
}

interface RunningControllerLogs {
  collector: ControllerLogCollector;
  status: ControllerLogStatusResponse;
}

export function createControllerLogService(
  options: ControllerLogServiceOptions
): ControllerLogService {
  const store = createCoreLogStore(options.appDataDir);
  const createCollector = options.createCollector ?? createControllerLogCollector;
  const now = options.now ?? (() => new Date());
  const running = new Map<string, RunningControllerLogs>();
  const lastErrors = new Map<string, ControllerLogStatusResponse["lastError"]>();

  return {
    async start(input: ControllerLogStartInput): Promise<ControllerLogActionResponse> {
      const profileId = normalizeRequired(input.profileId, "profileId");
      const existing = running.get(profileId);
      if (existing) {
        return { ok: true, status: existing.status };
      }

      try {
        const collector = createCollector({
          profileId,
          baseUrl: normalizeRequired(input.baseUrl, "baseUrl"),
          secret: normalizeRequired(input.secret, "secret"),
          level: input.level,
          store
        });
        const status: ControllerLogStatusResponse = {
          profileId,
          running: true,
          level: input.level,
          startedAt: now().toISOString(),
          lastError: lastErrors.get(profileId)
        };
        running.set(profileId, { collector, status });
        void collector.done.then(
          () => {
            running.delete(profileId);
          },
          (error) => {
            lastErrors.set(profileId, {
              message: toError(error).message,
              occurredAt: now().toISOString()
            });
            running.delete(profileId);
          }
        );

        return { ok: true, status };
      } catch (error) {
        return { ok: false, error: toViewError(error), status: statusFor(profileId) };
      }
    },

    async stop(profileIdInput: string): Promise<ControllerLogActionResponse> {
      const profileId = normalizeRequired(profileIdInput, "profileId");
      const current = running.get(profileId);
      if (!current) {
        return { ok: true, status: statusFor(profileId) };
      }

      try {
        await current.collector.stop();
        running.delete(profileId);
        return { ok: true, status: statusFor(profileId) };
      } catch (error) {
        return { ok: false, error: toViewError(error), status: current.status };
      }
    },

    async stopAll(): Promise<ControllerLogStatusResponse[]> {
      const profileIds = [...running.keys()];
      const results = await Promise.all(profileIds.map((profileId) => this.stop(profileId)));
      return results.map((result) => result.status);
    },

    status(profileIdInput: string): ControllerLogStatusResponse {
      return statusFor(normalizeRequired(profileIdInput, "profileId"));
    },

    hasRunning(): boolean {
      return running.size > 0;
    }
  };

  function statusFor(profileId: string): ControllerLogStatusResponse {
    const current = running.get(profileId);
    if (current) {
      return current.status;
    }

    return {
      profileId,
      running: false,
      lastError: lastErrors.get(profileId)
    };
  }
}

function normalizeRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function toViewError(error: unknown): { name: string; message: string } {
  const normalized = toError(error);
  return { name: normalized.name, message: normalized.message };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
