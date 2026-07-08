import { ipcMain } from "electron";
import type { ControllerLogStartInput } from "../../shared/pipelineTypes.js";
import {
  createControllerLogService,
  type ControllerLogService
} from "../core/controllerLogService.js";

export const START_CONTROLLER_LOGS_CHANNEL = "controller-logs:start";
export const STOP_CONTROLLER_LOGS_CHANNEL = "controller-logs:stop";
export const CONTROLLER_LOGS_STATUS_CHANNEL = "controller-logs:status";

export function registerControllerLogIpc(appDataDir: string): ControllerLogService {
  const service = createControllerLogService({ appDataDir });
  ipcMain.handle(START_CONTROLLER_LOGS_CHANNEL, (_event, input: ControllerLogStartInput) =>
    service.start(input)
  );
  ipcMain.handle(STOP_CONTROLLER_LOGS_CHANNEL, (_event, profileId: string) =>
    service.stop(profileId)
  );
  ipcMain.handle(CONTROLLER_LOGS_STATUS_CHANNEL, (_event, profileId: string) =>
    service.status(profileId)
  );
  return service;
}
