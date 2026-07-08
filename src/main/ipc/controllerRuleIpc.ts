import { ipcMain } from "electron";
import type { ControllerRulesSnapshotInput } from "../../shared/pipelineTypes.js";
import { createControllerRuleService } from "../core/controllerRuleService.js";

export const CONTROLLER_RULES_SNAPSHOT_CHANNEL = "controller-rules:snapshot";

export function registerControllerRuleIpc(): void {
  const service = createControllerRuleService();
  ipcMain.handle(CONTROLLER_RULES_SNAPSHOT_CHANNEL, (_event, input: ControllerRulesSnapshotInput) =>
    service.snapshot(input)
  );
}
