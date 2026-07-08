import { contextBridge, ipcRenderer } from "electron";
import type {
  ActivationActionResponse,
  ActivationStartInput,
  ActivationStatusResponse,
  ClashPartyImportInput,
  ClashPartyImportResult,
  ControllerHealthCheckInput,
  ControllerHealthResponse,
  ControllerLogActionResponse,
  ControllerLogStartInput,
  ControllerLogStatusResponse,
  ControllerObservationInput,
  ControllerObservationResponse,
  ControllerProxyDelayInput,
  ControllerProxyDelayResponse,
  ControllerProxySnapshotInput,
  ControllerProxySnapshotResponse,
  ControllerProxySwitchInput,
  ControllerProxySwitchResponse,
  ControllerRulesSnapshotInput,
  ControllerRulesSnapshotResponse,
  CoreProcessActionResponse,
  CoreProcessStartInput,
  CoreProcessStatusResponse,
  CoreLogViewEvent,
  FailureReportExportInput,
  FailureReportExportResponse,
  OverrideSelection,
  OverrideSettingsState,
  PipelineRunHistoryRecord,
  PipelineRunInput,
  PipelinePrepareResponse,
  PipelineRunResponse,
  ProfileSettings,
  SubscriptionScheduleRuntimeInput,
  SubscriptionScheduleRuntimeStatus,
  SubscriptionScheduleSaveInput,
  SubscriptionScheduleTickInput,
  SubscriptionScheduleTickResponse,
  SubscriptionUpdateSchedule,
  SystemProxyActionResponse,
  SystemProxyEnableInput,
  SystemProxyStatusResponse
} from "../shared/pipelineTypes.js";

const RUN_PROFILE_PIPELINE_CHANNEL = "pipeline:run-profile";
const PREPARE_PROFILE_CHANNEL = "pipeline:prepare-profile";
const LIST_PIPELINE_HISTORY_CHANNEL = "pipeline:list-history";
const LIST_CORE_LOGS_CHANNEL = "pipeline:list-core-logs";
const EXPORT_FAILURE_REPORT_CHANNEL = "pipeline:export-failure-report";
const START_CORE_PROCESS_CHANNEL = "core:start";
const STOP_CORE_PROCESS_CHANNEL = "core:stop";
const CORE_PROCESS_STATUS_CHANNEL = "core:status";
const START_CONTROLLER_LOGS_CHANNEL = "controller-logs:start";
const STOP_CONTROLLER_LOGS_CHANNEL = "controller-logs:stop";
const CONTROLLER_LOGS_STATUS_CHANNEL = "controller-logs:status";
const CHECK_CONTROLLER_HEALTH_CHANNEL = "controller-health:check";
const CONTROLLER_OBSERVATION_SNAPSHOT_CHANNEL = "controller-observation:snapshot";
const CONTROLLER_PROXY_SNAPSHOT_CHANNEL = "controller-proxies:snapshot";
const CONTROLLER_PROXY_SWITCH_CHANNEL = "controller-proxies:switch";
const CONTROLLER_PROXY_DELAY_CHANNEL = "controller-proxies:delay";
const CONTROLLER_RULES_SNAPSHOT_CHANNEL = "controller-rules:snapshot";
const SYSTEM_PROXY_STATUS_CHANNEL = "system-proxy:status";
const ENABLE_SYSTEM_PROXY_CHANNEL = "system-proxy:enable";
const DISABLE_SYSTEM_PROXY_CHANNEL = "system-proxy:disable";
const RESTORE_SYSTEM_PROXY_CHANNEL = "system-proxy:restore";
const CONNECT_PROFILE_CHANNEL = "activation:connect";
const DISCONNECT_PROFILE_CHANNEL = "activation:disconnect";
const ACTIVATION_STATUS_CHANNEL = "activation:status";
const LOAD_PROFILE_SETTINGS_CHANNEL = "profile-settings:load";
const SAVE_PROFILE_SETTINGS_CHANNEL = "profile-settings:save";
const LOAD_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:load";
const SAVE_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:save";
const TICK_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:tick";
const ARM_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:arm";
const DISARM_SUBSCRIPTION_SCHEDULE_CHANNEL = "subscription-schedule:disarm";
const SUBSCRIPTION_SCHEDULE_RUNTIME_STATUS_CHANNEL =
  "subscription-schedule:runtime-status";
const IMPORT_CLASH_PARTY_CHANNEL = "clash-party:import";
const GET_OVERRIDE_SETTINGS_CHANNEL = "overrides:get-state";
const SET_OVERRIDE_SELECTION_CHANNEL = "overrides:set-selection";

contextBridge.exposeInMainWorld("mioproxy", {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  runProfilePipeline(input: PipelineRunInput): Promise<PipelineRunResponse> {
    return ipcRenderer.invoke(RUN_PROFILE_PIPELINE_CHANNEL, input) as Promise<PipelineRunResponse>;
  },
  prepareProfile(input: PipelineRunInput): Promise<PipelinePrepareResponse> {
    return ipcRenderer.invoke(PREPARE_PROFILE_CHANNEL, input) as Promise<PipelinePrepareResponse>;
  },
  listPipelineHistory(): Promise<PipelineRunHistoryRecord[]> {
    return ipcRenderer.invoke(LIST_PIPELINE_HISTORY_CHANNEL) as Promise<PipelineRunHistoryRecord[]>;
  },
  listCoreLogs(profileId: string): Promise<CoreLogViewEvent[]> {
    return ipcRenderer.invoke(LIST_CORE_LOGS_CHANNEL, profileId) as Promise<CoreLogViewEvent[]>;
  },
  exportFailureReport(input: FailureReportExportInput): Promise<FailureReportExportResponse> {
    return ipcRenderer.invoke(EXPORT_FAILURE_REPORT_CHANNEL, input) as Promise<FailureReportExportResponse>;
  },
  startCore(input: CoreProcessStartInput): Promise<CoreProcessActionResponse> {
    return ipcRenderer.invoke(START_CORE_PROCESS_CHANNEL, input) as Promise<CoreProcessActionResponse>;
  },
  stopCore(profileId: string): Promise<CoreProcessActionResponse> {
    return ipcRenderer.invoke(STOP_CORE_PROCESS_CHANNEL, profileId) as Promise<CoreProcessActionResponse>;
  },
  getCoreStatus(profileId: string): Promise<CoreProcessStatusResponse> {
    return ipcRenderer.invoke(CORE_PROCESS_STATUS_CHANNEL, profileId) as Promise<CoreProcessStatusResponse>;
  },
  startControllerLogs(input: ControllerLogStartInput): Promise<ControllerLogActionResponse> {
    return ipcRenderer.invoke(START_CONTROLLER_LOGS_CHANNEL, input) as Promise<ControllerLogActionResponse>;
  },
  stopControllerLogs(profileId: string): Promise<ControllerLogActionResponse> {
    return ipcRenderer.invoke(STOP_CONTROLLER_LOGS_CHANNEL, profileId) as Promise<ControllerLogActionResponse>;
  },
  getControllerLogStatus(profileId: string): Promise<ControllerLogStatusResponse> {
    return ipcRenderer.invoke(CONTROLLER_LOGS_STATUS_CHANNEL, profileId) as Promise<ControllerLogStatusResponse>;
  },
  checkControllerHealth(input: ControllerHealthCheckInput): Promise<ControllerHealthResponse> {
    return ipcRenderer.invoke(CHECK_CONTROLLER_HEALTH_CHANNEL, input) as Promise<ControllerHealthResponse>;
  },
  getControllerObservations(input: ControllerObservationInput): Promise<ControllerObservationResponse> {
    return ipcRenderer.invoke(CONTROLLER_OBSERVATION_SNAPSHOT_CHANNEL, input) as Promise<ControllerObservationResponse>;
  },
  getControllerProxies(input: ControllerProxySnapshotInput): Promise<ControllerProxySnapshotResponse> {
    return ipcRenderer.invoke(CONTROLLER_PROXY_SNAPSHOT_CHANNEL, input) as Promise<ControllerProxySnapshotResponse>;
  },
  switchControllerProxy(input: ControllerProxySwitchInput): Promise<ControllerProxySwitchResponse> {
    return ipcRenderer.invoke(CONTROLLER_PROXY_SWITCH_CHANNEL, input) as Promise<ControllerProxySwitchResponse>;
  },
  testControllerProxyDelay(input: ControllerProxyDelayInput): Promise<ControllerProxyDelayResponse> {
    return ipcRenderer.invoke(CONTROLLER_PROXY_DELAY_CHANNEL, input) as Promise<ControllerProxyDelayResponse>;
  },
  getControllerRules(input: ControllerRulesSnapshotInput): Promise<ControllerRulesSnapshotResponse> {
    return ipcRenderer.invoke(CONTROLLER_RULES_SNAPSHOT_CHANNEL, input) as Promise<ControllerRulesSnapshotResponse>;
  },
  getSystemProxyStatus(): Promise<SystemProxyStatusResponse> {
    return ipcRenderer.invoke(SYSTEM_PROXY_STATUS_CHANNEL) as Promise<SystemProxyStatusResponse>;
  },
  enableSystemProxy(input: SystemProxyEnableInput): Promise<SystemProxyActionResponse> {
    return ipcRenderer.invoke(ENABLE_SYSTEM_PROXY_CHANNEL, input) as Promise<SystemProxyActionResponse>;
  },
  disableSystemProxy(): Promise<SystemProxyActionResponse> {
    return ipcRenderer.invoke(DISABLE_SYSTEM_PROXY_CHANNEL) as Promise<SystemProxyActionResponse>;
  },
  restoreSystemProxy(): Promise<SystemProxyActionResponse> {
    return ipcRenderer.invoke(RESTORE_SYSTEM_PROXY_CHANNEL) as Promise<SystemProxyActionResponse>;
  },
  connectProfile(input: ActivationStartInput): Promise<ActivationActionResponse> {
    return ipcRenderer.invoke(CONNECT_PROFILE_CHANNEL, input) as Promise<ActivationActionResponse>;
  },
  disconnectProfile(profileId: string): Promise<ActivationActionResponse> {
    return ipcRenderer.invoke(DISCONNECT_PROFILE_CHANNEL, profileId) as Promise<ActivationActionResponse>;
  },
  getActivationStatus(profileId: string): Promise<ActivationStatusResponse> {
    return ipcRenderer.invoke(ACTIVATION_STATUS_CHANNEL, profileId) as Promise<ActivationStatusResponse>;
  },
  loadProfileSettings(profileId: string): Promise<ProfileSettings | null> {
    return ipcRenderer.invoke(LOAD_PROFILE_SETTINGS_CHANNEL, profileId) as Promise<ProfileSettings | null>;
  },
  saveProfileSettings(input: ProfileSettings): Promise<ProfileSettings> {
    return ipcRenderer.invoke(SAVE_PROFILE_SETTINGS_CHANNEL, input) as Promise<ProfileSettings>;
  },
  loadSubscriptionSchedule(profileId: string): Promise<SubscriptionUpdateSchedule> {
    return ipcRenderer.invoke(LOAD_SUBSCRIPTION_SCHEDULE_CHANNEL, profileId) as Promise<SubscriptionUpdateSchedule>;
  },
  saveSubscriptionSchedule(input: SubscriptionScheduleSaveInput): Promise<SubscriptionUpdateSchedule> {
    return ipcRenderer.invoke(SAVE_SUBSCRIPTION_SCHEDULE_CHANNEL, input) as Promise<SubscriptionUpdateSchedule>;
  },
  tickSubscriptionSchedule(input: SubscriptionScheduleTickInput): Promise<SubscriptionScheduleTickResponse> {
    return ipcRenderer.invoke(TICK_SUBSCRIPTION_SCHEDULE_CHANNEL, input) as Promise<SubscriptionScheduleTickResponse>;
  },
  armSubscriptionSchedule(input: SubscriptionScheduleRuntimeInput): Promise<SubscriptionScheduleRuntimeStatus> {
    return ipcRenderer.invoke(ARM_SUBSCRIPTION_SCHEDULE_CHANNEL, input) as Promise<SubscriptionScheduleRuntimeStatus>;
  },
  disarmSubscriptionSchedule(profileId: string): Promise<SubscriptionScheduleRuntimeStatus> {
    return ipcRenderer.invoke(DISARM_SUBSCRIPTION_SCHEDULE_CHANNEL, profileId) as Promise<SubscriptionScheduleRuntimeStatus>;
  },
  getSubscriptionScheduleRuntimeStatus(profileId: string): Promise<SubscriptionScheduleRuntimeStatus> {
    return ipcRenderer.invoke(SUBSCRIPTION_SCHEDULE_RUNTIME_STATUS_CHANNEL, profileId) as Promise<SubscriptionScheduleRuntimeStatus>;
  },
  importClashParty(input: ClashPartyImportInput): Promise<ClashPartyImportResult> {
    return ipcRenderer.invoke(IMPORT_CLASH_PARTY_CHANNEL, input) as Promise<ClashPartyImportResult>;
  },
  getOverrideSettings(): Promise<OverrideSettingsState> {
    return ipcRenderer.invoke(GET_OVERRIDE_SETTINGS_CHANNEL) as Promise<OverrideSettingsState>;
  },
  setOverrideSelection(input: OverrideSelection): Promise<OverrideSettingsState> {
    return ipcRenderer.invoke(SET_OVERRIDE_SELECTION_CHANNEL, input) as Promise<OverrideSettingsState>;
  }
});
