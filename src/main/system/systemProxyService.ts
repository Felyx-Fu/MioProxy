import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  SystemProxyActionResponse,
  SystemProxyEnableInput,
  SystemProxyStatusResponse
} from "../../shared/pipelineTypes.js";
import {
  disableWindowsSystemProxy,
  enableWindowsSystemProxy,
  readWindowsSystemProxy,
  restoreWindowsSystemProxy,
  type WindowsSystemProxySnapshot
} from "./windowsSystemProxy.js";

export interface SystemProxyServiceOptions {
  appDataDir: string;
  platform?: NodeJS.Platform;
  manager?: SystemProxyManager;
}

export interface SystemProxyManager {
  read(): Promise<WindowsSystemProxySnapshot>;
  enable(input: SystemProxyEnableInput): Promise<WindowsSystemProxySnapshot>;
  disable(): Promise<WindowsSystemProxySnapshot>;
  restore(snapshot: WindowsSystemProxySnapshot): Promise<WindowsSystemProxySnapshot>;
}

export interface SystemProxyService {
  status(): Promise<SystemProxyStatusResponse>;
  enable(input: SystemProxyEnableInput): Promise<SystemProxyActionResponse>;
  disable(): Promise<SystemProxyActionResponse>;
  restore(): Promise<SystemProxyActionResponse>;
}

export function createSystemProxyService(options: SystemProxyServiceOptions): SystemProxyService {
  const platform = options.platform ?? process.platform;
  const manager = options.manager ?? createWindowsSystemProxyManager();
  const snapshotPath = join(options.appDataDir, "state", "system-proxy-snapshot.json");

  return {
    async status(): Promise<SystemProxyStatusResponse> {
      if (platform !== "win32") {
        return { supported: false, enabled: false, managedSnapshot: false };
      }

      const current = await manager.read();
      return toStatus(current, await hasManagedSnapshot());
    },

    async enable(input: SystemProxyEnableInput): Promise<SystemProxyActionResponse> {
      if (platform !== "win32") {
        return unsupportedResponse();
      }

      let previous: WindowsSystemProxySnapshot | undefined;
      let snapshotSaved = false;
      try {
        previous = await manager.read();
        await saveManagedSnapshot(previous);
        snapshotSaved = true;
        const current = await manager.enable(input);
        return { ok: true, status: toStatus(current, true) };
      } catch (error) {
        if (previous && snapshotSaved) {
          await restoreAfterFailedEnable(previous).catch(() => undefined);
        }
        return { ok: false, error: toViewError(error), status: await bestEffortStatus() };
      }
    },

    async disable(): Promise<SystemProxyActionResponse> {
      if (platform !== "win32") {
        return unsupportedResponse();
      }

      try {
        const current = await manager.disable();
        return { ok: true, status: toStatus(current, await hasManagedSnapshot()) };
      } catch (error) {
        return { ok: false, error: toViewError(error), status: await bestEffortStatus() };
      }
    },

    async restore(): Promise<SystemProxyActionResponse> {
      if (platform !== "win32") {
        return unsupportedResponse();
      }

      try {
        const snapshot = await readManagedSnapshot();
        if (!snapshot) {
          return {
            ok: true,
            status: await bestEffortStatus()
          };
        }

        const current = await manager.restore(snapshot);
        await rm(snapshotPath, { force: true });
        return { ok: true, status: toStatus(current, false) };
      } catch (error) {
        return { ok: false, error: toViewError(error), status: await bestEffortStatus() };
      }
    }
  };

  async function bestEffortStatus(): Promise<SystemProxyStatusResponse> {
    try {
      return toStatus(await manager.read(), await hasManagedSnapshot());
    } catch {
      return { supported: platform === "win32", enabled: false, managedSnapshot: await hasManagedSnapshot() };
    }
  }

  async function saveManagedSnapshot(snapshot: WindowsSystemProxySnapshot): Promise<void> {
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  async function readManagedSnapshot(): Promise<WindowsSystemProxySnapshot | null> {
    try {
      return JSON.parse(await readFile(snapshotPath, "utf8")) as WindowsSystemProxySnapshot;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async function hasManagedSnapshot(): Promise<boolean> {
    return (await readManagedSnapshot()) !== null;
  }

  async function restoreAfterFailedEnable(snapshot: WindowsSystemProxySnapshot): Promise<void> {
    await manager.restore(snapshot);
    await rm(snapshotPath, { force: true });
  }
}

function createWindowsSystemProxyManager(): SystemProxyManager {
  return {
    read: () => readWindowsSystemProxy(),
    enable: (input) => enableWindowsSystemProxy(input),
    disable: () => disableWindowsSystemProxy(),
    restore: (snapshot) => restoreWindowsSystemProxy(snapshot)
  };
}

function toStatus(
  snapshot: WindowsSystemProxySnapshot,
  managedSnapshot: boolean
): SystemProxyStatusResponse {
  return {
    supported: true,
    enabled: snapshot.enabled,
    server: snapshot.server,
    bypass: snapshot.bypass,
    capturedAt: snapshot.capturedAt,
    managedSnapshot
  };
}

function unsupportedResponse(): SystemProxyActionResponse {
  return {
    ok: false,
    error: { name: "UnsupportedPlatformError", message: "Windows system proxy is only supported on Windows" },
    status: { supported: false, enabled: false, managedSnapshot: false }
  };
}

function toViewError(error: unknown): { name: string; message: string } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return { name: normalized.name, message: normalized.message };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
