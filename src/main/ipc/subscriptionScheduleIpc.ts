import { ipcMain } from "electron";
import type {
  SubscriptionScheduleRuntimeInput,
  SubscriptionScheduleSaveInput,
  SubscriptionScheduleTickInput
} from "../../shared/pipelineTypes.js";
import { createSubscriptionUpdateService } from "../schedule/subscriptionUpdateService.js";

export const LOAD_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:load";
export const SAVE_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:save";
export const TICK_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:tick";
export const ARM_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:arm";
export const DISARM_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:disarm";
export const SUBSCRIPTION_SCHEDULE_RUNTIME_STATUS_CHANNEL =
  "subscription-schedule:runtime-status";

export function registerSubscriptionScheduleIpc(appDataDir: string): ReturnType<typeof createSubscriptionUpdateService> {
  const service = createSubscriptionUpdateService({ appDataDir });
  ipcMain.handle(LOAD_SUBSCRIPTION_SCHEDULE_CHANNEL, (_event, profileId: string) =>
    service.loadSchedule(profileId)
  );
  ipcMain.handle(SAVE_SUBSCRIPTION_SCHEDULE_CHANNEL, (_event, input: SubscriptionScheduleSaveInput) =>
    service.saveSchedule(input)
  );
  ipcMain.handle(TICK_SUBSCRIPTION_SCHEDULE_CHANNEL, (_event, input: SubscriptionScheduleTickInput) =>
    service.tick(input)
  );
  ipcMain.handle(ARM_SUBSCRIPTION_SCHEDULE_CHANNEL, (_event, input: SubscriptionScheduleRuntimeInput) =>
    service.arm(input)
  );
  ipcMain.handle(DISARM_SUBSCRIPTION_SCHEDULE_CHANNEL, (_event, profileId: string) =>
    service.disarm(profileId)
  );
  ipcMain.handle(SUBSCRIPTION_SCHEDULE_RUNTIME_STATUS_CHANNEL, (_event, profileId: string) =>
    service.getRuntimeStatus(profileId)
  );
  service.start();
  return service;
}
