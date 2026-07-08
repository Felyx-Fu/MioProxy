import { ipcMain } from "electron";
import type { SystemProxyEnableInput } from "../../shared/pipelineTypes.js";
import {
  createSystemProxyService,
  type SystemProxyService
} from "../system/systemProxyService.js";

export const SYSTEM_PROXY_STATUS_CHANNEL = "system-proxy:status";
export const ENABLE_SYSTEM_PROXY_CHANNEL = "system-proxy:enable";
export const DISABLE_SYSTEM_PROXY_CHANNEL = "system-proxy:disable";
export const RESTORE_SYSTEM_PROXY_CHANNEL = "system-proxy:restore";

export function registerSystemProxyIpc(
  appDataDir: string,
  service: SystemProxyService = createSystemProxyService({ appDataDir })
): SystemProxyService {
  ipcMain.handle(SYSTEM_PROXY_STATUS_CHANNEL, () => service.status());
  ipcMain.handle(ENABLE_SYSTEM_PROXY_CHANNEL, (_event, input: SystemProxyEnableInput) =>
    service.enable(input)
  );
  ipcMain.handle(DISABLE_SYSTEM_PROXY_CHANNEL, () => service.disable());
  ipcMain.handle(RESTORE_SYSTEM_PROXY_CHANNEL, () => service.restore());
  return service;
}
