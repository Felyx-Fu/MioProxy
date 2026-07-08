import { ipcMain } from "electron";
import type { OverrideSelection } from "../../shared/pipelineTypes.js";
import { createOverrideSettingsStore } from "../state/overrideSettingsStore.js";

export const GET_OVERRIDE_SETTINGS_CHANNEL = "overrides:get-state";
export const SET_OVERRIDE_SELECTION_CHANNEL = "overrides:set-selection";

export function registerOverrideSettingsIpc(appDataDir: string): void {
  const store = createOverrideSettingsStore(appDataDir);
  ipcMain.handle(GET_OVERRIDE_SETTINGS_CHANNEL, () => store.getState());
  ipcMain.handle(SET_OVERRIDE_SELECTION_CHANNEL, (_event, input: OverrideSelection) =>
    store.setSelection(input)
  );
}
