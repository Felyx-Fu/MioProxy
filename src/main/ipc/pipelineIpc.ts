import { ipcMain } from "electron";
import { createProfilePipelineService } from "../pipeline/profilePipelineService.js";
import type { FailureReportExportInput, PipelineRunInput } from "../../shared/pipelineTypes.js";

export const RUN_PROFILE_PIPELINE_CHANNEL = "pipeline:run-profile";
export const PREPARE_PROFILE_CHANNEL = "pipeline:prepare-profile";
export const LIST_PIPELINE_HISTORY_CHANNEL = "pipeline:list-history";
export const LIST_CORE_LOGS_CHANNEL = "pipeline:list-core-logs";
export const EXPORT_FAILURE_REPORT_CHANNEL = "pipeline:export-failure-report";

export function registerPipelineIpc(appDataDir: string): void {
  const service = createProfilePipelineService({ appDataDir });
  ipcMain.handle(RUN_PROFILE_PIPELINE_CHANNEL, (_event, input: PipelineRunInput) =>
    service.runProfilePipeline(input)
  );
  ipcMain.handle(PREPARE_PROFILE_CHANNEL, (_event, input: PipelineRunInput) =>
    service.prepareProfile(input)
  );
  ipcMain.handle(LIST_PIPELINE_HISTORY_CHANNEL, () => service.listPipelineHistory());
  ipcMain.handle(LIST_CORE_LOGS_CHANNEL, (_event, profileId: string) =>
    service.listCoreLogs(profileId)
  );
  ipcMain.handle(EXPORT_FAILURE_REPORT_CHANNEL, (_event, input: FailureReportExportInput) =>
    service.exportFailureReport(input)
  );
}
