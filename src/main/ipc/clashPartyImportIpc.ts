import { ipcMain } from "electron";
import type { ClashPartyImportInput } from "../../shared/pipelineTypes.js";
import { createClashPartyImportService } from "../migration/clashPartyImportService.js";

export const IMPORT_CLASH_PARTY_CHANNEL = "clash-party:import";

export function registerClashPartyImportIpc(appDataDir: string): void {
  const service = createClashPartyImportService({ appDataDir });
  ipcMain.handle(IMPORT_CLASH_PARTY_CHANNEL, (_event, input: ClashPartyImportInput) =>
    service.importFrom(input)
  );
}
