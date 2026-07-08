import { access } from "node:fs/promises";
import {
  createConfigStore,
  createCoreLogStore,
  startMihomoCore,
  type MihomoCoreProcess,
  type StartMihomoCoreOptions
} from "@mioproxy/core-runtime";
import type {
  CoreProcessStartInput,
  CoreProcessActionResponse,
  CoreProcessStatusResponse
} from "../../shared/pipelineTypes.js";

export interface CoreProcessServiceOptions {
  appDataDir: string;
  startCore?: (options: StartMihomoCoreOptions) => MihomoCoreProcess;
  now?: () => Date;
}

export interface CoreProcessService {
  start(input: CoreProcessStartInput): Promise<CoreProcessActionResponse>;
  stop(profileId: string): Promise<CoreProcessActionResponse>;
  stopAll(): Promise<CoreProcessStatusResponse[]>;
  status(profileId: string): CoreProcessStatusResponse;
  hasRunning(): boolean;
}

interface RunningCore {
  process: MihomoCoreProcess;
  status: CoreProcessStatusResponse;
}

export function createCoreProcessService(options: CoreProcessServiceOptions): CoreProcessService {
  const configStore = createConfigStore(options.appDataDir);
  const logStore = createCoreLogStore(options.appDataDir);
  const startCore = options.startCore ?? startMihomoCore;
  const now = options.now ?? (() => new Date());
  const running = new Map<string, RunningCore>();
  const lastExits = new Map<string, CoreProcessStatusResponse["lastExit"]>();

  return {
    async start(input: CoreProcessStartInput): Promise<CoreProcessActionResponse> {
      const profileId = normalizeRequired(input.profileId, "profileId");
      const binaryPath = normalizeRequired(input.binaryPath, "binaryPath");
      const dataDir = normalizeRequired(input.dataDir, "dataDir");
      const existing = running.get(profileId);
      if (existing) {
        return { ok: true, status: existing.status };
      }

      const activePath = configStore.pathsForProfile(profileId).activePath;
      try {
        await access(activePath);
        const process = startCore({
          binaryPath,
          configPath: activePath,
          dataDir,
          profileId,
          logStore
        });
        const status: CoreProcessStatusResponse = {
          profileId,
          running: true,
          pid: process.pid,
          activePath,
          startedAt: now().toISOString(),
          lastExit: lastExits.get(profileId)
        };
        running.set(profileId, { process, status });
        void process.waitForExit.then(
          (exit) => {
            lastExits.set(profileId, {
              exitCode: exit.exitCode,
              signal: exit.signal,
              exitedAt: now().toISOString()
            });
            running.delete(profileId);
          },
          (error) => {
            lastExits.set(profileId, {
              exitCode: null,
              signal: null,
              exitedAt: now().toISOString(),
              errorMessage: toError(error).message
            });
            running.delete(profileId);
          }
        );

        return { ok: true, status };
      } catch (error) {
        return { ok: false, error: toViewError(error), status: statusFor(profileId) };
      }
    },

    async stop(profileIdInput: string): Promise<CoreProcessActionResponse> {
      const profileId = normalizeRequired(profileIdInput, "profileId");
      const current = running.get(profileId);
      if (!current) {
        return { ok: true, status: statusFor(profileId) };
      }

      try {
        const exit = await current.process.stop();
        const lastExit = {
          exitCode: exit.exitCode,
          signal: exit.signal,
          exitedAt: now().toISOString()
        };
        lastExits.set(profileId, lastExit);
        running.delete(profileId);
        return { ok: true, status: statusFor(profileId) };
      } catch (error) {
        return { ok: false, error: toViewError(error), status: current.status };
      }
    },

    async stopAll(): Promise<CoreProcessStatusResponse[]> {
      const profileIds = [...running.keys()];
      const results = await Promise.all(profileIds.map((profileId) => this.stop(profileId)));
      return results.map((result) => result.status);
    },

    status(profileIdInput: string): CoreProcessStatusResponse {
      return statusFor(normalizeRequired(profileIdInput, "profileId"));
    },

    hasRunning(): boolean {
      return running.size > 0;
    }
  };

  function statusFor(profileId: string): CoreProcessStatusResponse {
    const current = running.get(profileId);
    if (current) {
      return current.status;
    }

    return {
      profileId,
      running: false,
      activePath: configStore.pathsForProfile(profileId).activePath,
      lastExit: lastExits.get(profileId)
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
