import { ipcMain } from "electron";
import type { ControllerHealthCheckInput } from "../../shared/pipelineTypes.js";
import {
  createControllerHealthService,
  type ControllerHealthService
} from "../core/controllerHealthService.js";

export const CHECK_CONTROLLER_HEALTH_CHANNEL = "controller-health:check";

export function registerControllerHealthIpc(
  service: ControllerHealthService = createControllerHealthService()
): ControllerHealthService {
  ipcMain.handle(CHECK_CONTROLLER_HEALTH_CHANNEL, (_event, input: ControllerHealthCheckInput) =>
    service.check(input)
  );
  return service;
}
