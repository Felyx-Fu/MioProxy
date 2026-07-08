import { ipcMain } from "electron";
import type {
  ControllerProxyDelayInput,
  ControllerProxySnapshotInput,
  ControllerProxySwitchInput
} from "../../shared/pipelineTypes.js";
import { createControllerProxyService } from "../core/controllerProxyService.js";

export const CONTROLLER_PROXY_SNAPSHOT_CHANNEL = "controller-proxies:snapshot";
export const CONTROLLER_PROXY_SWITCH_CHANNEL = "controller-proxies:switch";
export const CONTROLLER_PROXY_DELAY_CHANNEL = "controller-proxies:delay";

export function registerControllerProxyIpc(): void {
  const service = createControllerProxyService();
  ipcMain.handle(CONTROLLER_PROXY_SNAPSHOT_CHANNEL, (_event, input: ControllerProxySnapshotInput) =>
    service.snapshot(input)
  );
  ipcMain.handle(CONTROLLER_PROXY_SWITCH_CHANNEL, (_event, input: ControllerProxySwitchInput) =>
    service.switchProxy(input)
  );
  ipcMain.handle(CONTROLLER_PROXY_DELAY_CHANNEL, (_event, input: ControllerProxyDelayInput) =>
    service.testDelay(input)
  );
}
