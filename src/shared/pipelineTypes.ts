import type { JsOverrideRef, YamlOverrideRef } from "@mioproxy/config-pipeline";

export interface PipelineRunInput {
  profileId: string;
  subscription: {
    url: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    retries?: number;
  };
  yamlOverrides?: YamlOverrideRef[];
  jsOverrides?: JsOverrideRef[];
  checker: {
    binaryPath: string;
    dataDir: string;
    timeoutMs?: number;
  };
  controller: {
    baseUrl: string;
    secret: string;
    timeoutMs?: number;
  };
  diagnostics?: {
    sessionId?: string;
  };
}

export type PipelineRunResponse =
  | {
      ok: true;
      stage: "applied";
      mode: "hot-reload" | "restart";
      activePath: string;
      lastKnownGoodPath: string;
      warnings: Array<{ code: string; message: string; path: string }>;
    }
  | {
      ok: false;
      stage: string;
      error: { name: string; message: string };
      failureBundlePath: string;
    };

export type PipelinePrepareResponse =
  | {
      ok: true;
      stage: "promoted";
      activePath: string;
      candidatePath: string;
      warnings: Array<{ code: string; message: string; path: string }>;
    }
  | {
      ok: false;
      stage: string;
      error: { name: string; message: string };
    };

export interface PipelineRunHistoryRecord {
  id: string;
  createdAt: string;
  profileId: string;
  subscriptionHost: string;
  ok: boolean;
  stage: string;
  mode?: "hot-reload" | "restart";
  activePath?: string;
  lastKnownGoodPath?: string;
  failureBundlePath?: string;
  errorMessage?: string;
}

export interface FailureReportExportInput {
  historyId: string;
}

export type FailureReportExportResponse =
  | {
      ok: true;
      reportDir: string;
      files: string[];
    }
  | {
      ok: false;
      error: { name: string; message: string };
    };

export type CoreLogViewLevel = "debug" | "info" | "warning" | "error" | "unknown";

export interface CoreLogViewEvent {
  time: string;
  source: "process-stdout" | "process-stderr" | "controller-logs";
  level: CoreLogViewLevel;
  message: string;
}

export interface CoreProcessStartInput {
  profileId: string;
  binaryPath: string;
  dataDir: string;
}

export interface CoreProcessStatusResponse {
  profileId: string;
  running: boolean;
  pid?: number;
  activePath?: string;
  startedAt?: string;
  lastExit?: {
    exitCode: number | null;
    signal: string | null;
    exitedAt: string;
    errorMessage?: string;
  };
}

export type CoreProcessActionResponse =
  | {
      ok: true;
      status: CoreProcessStatusResponse;
    }
  | {
      ok: false;
      error: { name: string; message: string };
      status: CoreProcessStatusResponse;
    };

export interface ControllerLogStartInput {
  profileId: string;
  baseUrl: string;
  secret: string;
  level?: "debug" | "info" | "warning" | "error";
}

export interface ControllerLogStatusResponse {
  profileId: string;
  running: boolean;
  level?: "debug" | "info" | "warning" | "error";
  startedAt?: string;
  lastError?: {
    message: string;
    occurredAt: string;
  };
}

export type ControllerLogActionResponse =
  | {
      ok: true;
      status: ControllerLogStatusResponse;
    }
  | {
      ok: false;
      error: { name: string; message: string };
      status: ControllerLogStatusResponse;
    };

export interface ControllerHealthCheckInput {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
}

export type ControllerHealthResponse =
  | {
      ok: true;
      online: true;
      checkedAt: string;
      version: {
        version?: string;
        meta?: boolean;
      };
      config: {
        mode?: string;
        logLevel?: string;
        mixedPort?: number;
        port?: number;
        socksPort?: number;
        allowLan?: boolean;
        tunEnabled?: boolean;
      };
      versionStatus: number;
      configsStatus: number;
    }
  | {
      ok: false;
      online: false;
      checkedAt: string;
      error: { name: string; message: string };
      versionStatus?: number;
      configsStatus?: number;
    };

export interface ControllerObservationInput {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  connectionLimit?: number;
}

export interface ControllerConnectionSummary {
  id?: string;
  network?: string;
  type?: string;
  host?: string;
  destination?: string;
  rule?: string;
  rulePayload?: string;
  chain: string[];
  upload: number;
  download: number;
  start?: string;
  process?: string;
}

export interface ControllerConnectionsSummary {
  uploadTotal: number;
  downloadTotal: number;
  count: number;
  items: ControllerConnectionSummary[];
}

export type ControllerObservationResponse =
  | {
      ok: true;
      checkedAt: string;
      traffic: {
        upload: number;
        download: number;
      };
      connections: ControllerConnectionsSummary;
      trafficStatus: number;
      connectionsStatus: number;
    }
  | {
      ok: false;
      checkedAt: string;
      error: { name: string; message: string };
      trafficStatus?: number;
      connectionsStatus?: number;
    };

export interface ControllerProxySnapshotInput {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  groupLimit?: number;
  optionLimit?: number;
}

export interface ControllerProxyGroupSummary {
  name: string;
  type: string;
  current?: string;
  optionCount: number;
  options: string[];
}

export type ControllerProxySnapshotResponse =
  | {
      ok: true;
      checkedAt: string;
      total: number;
      groups: ControllerProxyGroupSummary[];
      proxiesStatus: number;
    }
  | {
      ok: false;
      checkedAt: string;
      error: { name: string; message: string };
      proxiesStatus?: number;
    };

export interface ControllerProxySwitchInput {
  baseUrl: string;
  secret: string;
  groupName: string;
  proxyName: string;
  timeoutMs?: number;
  refresh?: boolean;
  groupLimit?: number;
  optionLimit?: number;
}

export type ControllerProxySwitchResponse =
  | {
      ok: true;
      switchedAt: string;
      status: number;
      groupName: string;
      proxyName: string;
      snapshot?: Extract<ControllerProxySnapshotResponse, { ok: true }>;
    }
  | {
      ok: false;
      switchedAt: string;
      error: { name: string; message: string };
      status?: number;
      groupName?: string;
      proxyName?: string;
    };

export interface ControllerProxyDelayInput {
  baseUrl: string;
  secret: string;
  proxyName: string;
  testUrl?: string;
  timeoutMs?: number;
}

export type ControllerProxyDelayResponse =
  | {
      ok: true;
      checkedAt: string;
      proxyName: string;
      delayMs: number;
      status: number;
      testUrl: string;
      timeoutMs: number;
    }
  | {
      ok: false;
      checkedAt: string;
      error: { name: string; message: string };
      status?: number;
      proxyName?: string;
      testUrl?: string;
      timeoutMs?: number;
    };

export interface ControllerRulesSnapshotInput {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  ruleLimit?: number;
  providerLimit?: number;
}

export interface ControllerRuleSummary {
  type?: string;
  payload?: string;
  proxy?: string;
  size?: number;
}

export interface ControllerRuleProviderSummary {
  name: string;
  type?: string;
  behavior?: string;
  vehicleType?: string;
  ruleCount?: number;
  updatedAt?: string;
}

export type ControllerRulesSnapshotResponse =
  | {
      ok: true;
      checkedAt: string;
      rules: {
        total: number;
        items: ControllerRuleSummary[];
      };
      providers: {
        total: number;
        items: ControllerRuleProviderSummary[];
      };
      rulesStatus: number;
      providersStatus: number;
    }
  | {
      ok: false;
      checkedAt: string;
      error: { name: string; message: string };
      rulesStatus?: number;
      providersStatus?: number;
    };

export interface SystemProxyEnableInput {
  host: string;
  port: number;
  bypass?: string;
}

export interface SystemProxyStatusResponse {
  supported: boolean;
  enabled: boolean;
  server?: string;
  bypass?: string;
  capturedAt?: string;
  managedSnapshot: boolean;
}

export type SystemProxyActionResponse =
  | {
      ok: true;
      status: SystemProxyStatusResponse;
    }
  | {
      ok: false;
      error: { name: string; message: string };
      status: SystemProxyStatusResponse;
    };

export interface ActivationStartInput {
  profileId: string;
  binaryPath: string;
  dataDir: string;
  controller: {
    baseUrl: string;
    secret: string;
    timeoutMs?: number;
  };
  systemProxy: SystemProxyEnableInput;
  startControllerLogs?: boolean;
  enableSystemProxy?: boolean;
  health?: {
    attempts?: number;
    delayMs?: number;
  };
}

export interface ActivationStatusResponse {
  profileId: string;
  connected: boolean;
  steps: Array<{
    name:
      | "start-core"
      | "controller-health"
      | "start-controller-logs"
      | "enable-system-proxy"
      | "mark-last-known-good"
      | "restore-system-proxy"
      | "stop-controller-logs"
      | "stop-core"
      | "restore-active-config";
    ok: boolean;
    skipped?: boolean;
    errorMessage?: string;
  }>;
  health?: ControllerHealthResponse;
  rollback?: {
    systemProxy: { ok: boolean; errorMessage?: string };
    controllerLogs: { ok: boolean; errorMessage?: string };
    core: { ok: boolean; errorMessage?: string };
    config: { ok: boolean; errorMessage?: string };
  };
}

export type ActivationActionResponse =
  | {
      ok: true;
      status: ActivationStatusResponse;
    }
  | {
      ok: false;
      error: { name: string; message: string };
      status: ActivationStatusResponse;
    };

export interface ProfileSettings {
  profileId: string;
  subscriptionUrl: string;
  mihomoBinaryPath: string;
  mihomoDataDir: string;
  controllerBaseUrl: string;
  systemProxyHost: string;
  systemProxyPort: string;
  systemProxyBypass: string;
  updatedAt: string;
}

export type SubscriptionScheduleStatus = "success" | "failed" | "skipped";

export interface SubscriptionUpdateSchedule {
  profileId: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: SubscriptionScheduleStatus;
  lastStage?: string;
  lastErrorMessage?: string;
  updatedAt: string;
}

export interface SubscriptionScheduleSaveInput {
  profileId: string;
  enabled: boolean;
  intervalMinutes: number;
}

export interface SubscriptionScheduleTickInput {
  profileId: string;
  pipelineInput: PipelineRunInput;
  force?: boolean;
}

export interface SubscriptionScheduleRuntimeInput {
  profileId: string;
  pipelineInput: PipelineRunInput;
}

export interface SubscriptionScheduleRuntimeStatus {
  profileId: string;
  armed: boolean;
  armedAt?: string;
  lastTickAt?: string;
  lastTickStatus?: SubscriptionScheduleStatus;
  lastErrorMessage?: string;
}

export type SubscriptionScheduleTickResponse = {
  ok: boolean;
  status: SubscriptionScheduleStatus;
  reason?: "disabled" | "not-due";
  stage?: string;
  error?: { name: string; message: string };
  prepare?: PipelinePrepareResponse;
  schedule: SubscriptionUpdateSchedule;
};

export interface ClashPartyImportInput {
  sourceDir: string;
}

export interface ClashPartyImportedProfile extends ProfileSettings {
  name: string;
  sourceId?: string;
  sourceType?: string;
  overrideIds: string[];
  cacheImported: boolean;
}

export interface ClashPartyImportedOverride {
  id: string;
  name: string;
  type?: string;
  ext: "js" | "yaml";
  global: boolean;
  path?: string;
}

export interface ClashPartyImportResult {
  ok: true;
  sourceDir: string;
  profiles: ClashPartyImportedProfile[];
  overrides: ClashPartyImportedOverride[];
  warnings: string[];
}

export interface OverrideMetadata {
  id: string;
  name: string;
  type?: string;
  ext: "js" | "yaml";
  global: boolean;
  path?: string;
  importedFrom?: string;
}

export interface OverrideSelection {
  profileId: string;
  selectedIds: string[];
}

export interface OverrideSettingsState {
  items: OverrideMetadata[];
  selections: Record<string, string[]>;
}
