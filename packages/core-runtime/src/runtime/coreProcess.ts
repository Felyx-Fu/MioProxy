import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { CoreLogStore } from "../logging/logStore.js";
import { createProcessLogCollector } from "../logging/processLogCollector.js";

export interface StartMihomoCoreOptions {
  binaryPath: string;
  configPath: string;
  dataDir: string;
  profileId: string;
  logStore: CoreLogStore;
  spawnProcess?: SpawnCoreProcess;
}

export interface MihomoCoreProcess {
  pid?: number;
  waitForExit: Promise<CoreProcessExit>;
  stop(options?: StopCoreProcessOptions): Promise<CoreProcessExit>;
}

export interface StopCoreProcessOptions {
  timeoutMs?: number;
}

export interface CoreProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type SpawnCoreProcess = (
  command: string,
  args: string[],
  options: SpawnCoreProcessOptions
) => SpawnedCoreProcess;

export interface SpawnCoreProcessOptions {
  windowsHide: true;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface SpawnedCoreProcess {
  pid?: number;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "close", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export function startMihomoCore(options: StartMihomoCoreOptions): MihomoCoreProcess {
  const binaryPath = requireNonEmpty(options.binaryPath, "binaryPath");
  const configPath = requireNonEmpty(options.configPath, "configPath");
  const dataDir = requireNonEmpty(options.dataDir, "dataDir");
  const profileId = requireNonEmpty(options.profileId, "profileId");
  const args = ["-d", dataDir, "-f", configPath];
  const child = (options.spawnProcess ?? defaultSpawnProcess)(binaryPath, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = createProcessLogCollector({
    profileId,
    store: options.logStore,
    stdout: child.stdout ?? undefined,
    stderr: child.stderr ?? undefined
  });

  let settled = false;
  const waitForExit = new Promise<CoreProcessExit>((resolve, reject) => {
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      settled = true;
      child.off("error", onError);
      void logs.stop().then(() => resolve({ exitCode, signal }), reject);
    };

    const onError = (error: Error): void => {
      settled = true;
      child.off("close", onClose);
      void logs.stop().then(() => reject(error), reject);
    };

    child.once("close", onClose);
    child.once("error", onError);
  });

  return {
    pid: child.pid,
    waitForExit,
    async stop(stopOptions: StopCoreProcessOptions = {}): Promise<CoreProcessExit> {
      if (settled) {
        return waitForExit;
      }

      child.kill("SIGTERM");
      const exited = await Promise.race([
        waitForExit.then(() => true, () => true),
        delay(stopOptions.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS).then(() => false)
      ]);

      if (!exited && !settled) {
        child.kill("SIGKILL");
      }

      return waitForExit;
    }
  };
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: SpawnCoreProcessOptions
): SpawnedCoreProcess {
  return nodeSpawn(command, args, options);
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, timeoutMs));
  });
}
