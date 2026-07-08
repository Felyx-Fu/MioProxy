import { ipcMain } from "electron";
import type { ControllerObservationInput } from "../../shared/pipelineTypes.js";
import { createControllerObservationService } from "../core/controllerObservationService.js";

export const CONTROLLER_OBSERVATION_SNAPSHOT_CHANNEL = "controller-observation:snapshot";

export function registerControllerObservationIpc(): void {
  const service = createControllerObservationService();
  ipcMain.handle(
    CONTROLLER_OBSERVATION_SNAPSHOT_CHANNEL,
    (_event, input: ControllerObservationInput) => service.snapshot(input)
  );
}
