import { ipcMain } from "electron";
import type { ProfileSettings } from "../../shared/pipelineTypes.js";
import { createProfileSettingsStore } from "../state/profileSettingsStore.js";

export const LOAD_PROFILE_SETTINGS_CHANNEL = "profile-settings:load";
export const SAVE_PROFILE_SETTINGS_CHANNEL = "profile-settings:save";

export function registerProfileSettingsIpc(appDataDir: string): void {
  const store = createProfileSettingsStore(appDataDir);
  ipcMain.handle(LOAD_PROFILE_SETTINGS_CHANNEL, (_event, profileId: string) =>
    store.load(profileId)
  );
  ipcMain.handle(SAVE_PROFILE_SETTINGS_CHANNEL, (_event, input: ProfileSettings) =>
    store.save({
      ...input,
      updatedAt: new Date().toISOString()
    })
  );
}
