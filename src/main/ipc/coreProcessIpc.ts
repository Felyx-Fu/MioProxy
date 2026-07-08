import { ipcMain } from "electron";
import type { CoreProcessStartInput } from "../../shared/pipelineTypes.js";
import {
  createCoreProcessService,
  type CoreProcessService
} from "../core/coreProcessService.js";

export const START_CORE_PROCESS_CHANNEL = "core:start";
export const STOP_CORE_PROCESS_CHANNEL = "core:stop";
export const CORE_PROCESS_STATUS_CHANNEL = "core:status";

export function registerCoreProcessIpc(appDataDir: string): CoreProcessService {
  const service = createCoreProcessService({ appDataDir });
  ipcMain.handle(START_CORE_PROCESS_CHANNEL, (_event, input: CoreProcessStartInput) =>
    service.start(input)
  );
  ipcMain.handle(STOP_CORE_PROCESS_CHANNEL, (_event, profileId: string) => service.stop(profileId));
  ipcMain.handle(CORE_PROCESS_STATUS_CHANNEL, (_event, profileId: string) =>
    service.status(profileId)
  );
  return service;
}
