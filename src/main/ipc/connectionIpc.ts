import { ipcMain } from "electron";
import type { ActivationStartInput } from "../../shared/pipelineTypes.js";
import {
  createConnectionService,
  type ConnectionServiceOptions
} from "../activation/connectionService.js";

export const CONNECT_PROFILE_CHANNEL = "activation:connect";
export const DISCONNECT_PROFILE_CHANNEL = "activation:disconnect";
export const ACTIVATION_STATUS_CHANNEL = "activation:status";

export function registerConnectionIpc(options: ConnectionServiceOptions): void {
  const service = createConnectionService(options);
  ipcMain.handle(CONNECT_PROFILE_CHANNEL, (_event, input: ActivationStartInput) =>
    service.connect(input)
  );
  ipcMain.handle(DISCONNECT_PROFILE_CHANNEL, (_event, profileId: string) =>
    service.disconnect(profileId)
  );
  ipcMain.handle(ACTIVATION_STATUS_CHANNEL, (_event, profileId: string) =>
    service.status(profileId)
  );
}
