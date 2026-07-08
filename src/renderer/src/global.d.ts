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
} from "../../shared/pipelineTypes";

declare global {
  interface Window {
    mioproxy: {
      platform: string;
      versions: {
        node: string;
        chrome: string;
        electron: string;
      };
      runProfilePipeline(input: PipelineRunInput): Promise<PipelineRunResponse>;
      prepareProfile(input: PipelineRunInput): Promise<PipelinePrepareResponse>;
      listPipelineHistory(): Promise<PipelineRunHistoryRecord[]>;
      listCoreLogs(profileId: string): Promise<CoreLogViewEvent[]>;
      exportFailureReport(input: FailureReportExportInput): Promise<FailureReportExportResponse>;
      startCore(input: CoreProcessStartInput): Promise<CoreProcessActionResponse>;
      stopCore(profileId: string): Promise<CoreProcessActionResponse>;
      getCoreStatus(profileId: string): Promise<CoreProcessStatusResponse>;
      startControllerLogs(input: ControllerLogStartInput): Promise<ControllerLogActionResponse>;
      stopControllerLogs(profileId: string): Promise<ControllerLogActionResponse>;
      getControllerLogStatus(profileId: string): Promise<ControllerLogStatusResponse>;
      checkControllerHealth(input: ControllerHealthCheckInput): Promise<ControllerHealthResponse>;
      getControllerObservations(input: ControllerObservationInput): Promise<ControllerObservationResponse>;
      getControllerProxies(input: ControllerProxySnapshotInput): Promise<ControllerProxySnapshotResponse>;
      switchControllerProxy(input: ControllerProxySwitchInput): Promise<ControllerProxySwitchResponse>;
      testControllerProxyDelay(input: ControllerProxyDelayInput): Promise<ControllerProxyDelayResponse>;
      getControllerRules(input: ControllerRulesSnapshotInput): Promise<ControllerRulesSnapshotResponse>;
      getSystemProxyStatus(): Promise<SystemProxyStatusResponse>;
      enableSystemProxy(input: SystemProxyEnableInput): Promise<SystemProxyActionResponse>;
      disableSystemProxy(): Promise<SystemProxyActionResponse>;
      restoreSystemProxy(): Promise<SystemProxyActionResponse>;
      connectProfile(input: ActivationStartInput): Promise<ActivationActionResponse>;
      disconnectProfile(profileId: string): Promise<ActivationActionResponse>;
      getActivationStatus(profileId: string): Promise<ActivationStatusResponse>;
      loadProfileSettings(profileId: string): Promise<ProfileSettings | null>;
      saveProfileSettings(input: ProfileSettings): Promise<ProfileSettings>;
      loadSubscriptionSchedule(profileId: string): Promise<SubscriptionUpdateSchedule>;
      saveSubscriptionSchedule(input: SubscriptionScheduleSaveInput): Promise<SubscriptionUpdateSchedule>;
      tickSubscriptionSchedule(input: SubscriptionScheduleTickInput): Promise<SubscriptionScheduleTickResponse>;
      armSubscriptionSchedule(input: SubscriptionScheduleRuntimeInput): Promise<SubscriptionScheduleRuntimeStatus>;
      disarmSubscriptionSchedule(profileId: string): Promise<SubscriptionScheduleRuntimeStatus>;
      getSubscriptionScheduleRuntimeStatus(profileId: string): Promise<SubscriptionScheduleRuntimeStatus>;
      importClashParty(input: ClashPartyImportInput): Promise<ClashPartyImportResult>;
      getOverrideSettings(): Promise<OverrideSettingsState>;
      setOverrideSelection(input: OverrideSelection): Promise<OverrideSettingsState>;
    };
  }
}

export {};
