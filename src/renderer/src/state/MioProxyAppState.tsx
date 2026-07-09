import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type {
  ActivationStatusResponse,
  ControllerHealthResponse,
  ControllerObservationResponse,
  ControllerProxyDelayResponse,
  ControllerProxySnapshotResponse,
  ControllerRulesSnapshotResponse,
  CoreLogViewEvent,
  CoreProcessStatusResponse,
  ControllerLogStatusResponse,
  OverrideSettingsState,
  PipelineRunHistoryRecord,
  SubscriptionScheduleRuntimeStatus,
  SubscriptionUpdateSchedule,
  SystemProxyStatusResponse
} from "../../../shared/pipelineTypes";
import {
  applyProfileSettings,
  buildActivationStartInput,
  buildControllerHealthInput,
  buildControllerLogStartInput,
  buildCoreStartInput,
  buildPipelineInput,
  buildProfileSettings,
  buildSystemProxyEnableInput,
  defaultPipelineFormState,
  type PipelineFormState
} from "../pipelineForm";

export type ActivityTone = "neutral" | "success" | "warning";

export const pipelineSteps = [
  { label: "Cache", detail: "subscription" },
  { label: "Overrides", detail: "YAML / JS" },
  { label: "Sanitize", detail: "Mihomo compat" },
  { label: "Validate", detail: "mihomo -t" },
  { label: "Promote", detail: "active.yaml" },
  { label: "Reload", detail: "hot reload" }
];

const fallbackActivityItems = [
  {
    title: "Subscription cache ready",
    detail: "Waiting for the first render",
    tone: "neutral" as const
  },
  {
    title: "Override chain available",
    detail: "YAML/JS overrides will run during validation",
    tone: "neutral" as const
  },
  {
    title: "Compatibility sanitizer ready",
    detail: "Mihomo downgrade checks run before staging",
    tone: "neutral" as const
  },
  {
    title: "Rollback path available",
    detail: "Successful applies update last-known-good",
    tone: "neutral" as const
  },
  {
    title: "Diagnostics ready",
    detail: "Failed runs can export redacted reports",
    tone: "neutral" as const
  }
];

function useMioProxyAppStateValue() {
  const [form, setForm] = useState<PipelineFormState>(defaultPipelineFormState);
  const [isRunning, setIsRunning] = useState(false);
  const [isCoreBusy, setIsCoreBusy] = useState(false);
  const [isControllerLogBusy, setIsControllerLogBusy] = useState(false);
  const [isHealthChecking, setIsHealthChecking] = useState(false);
  const [isObservationChecking, setIsObservationChecking] = useState(false);
  const [isProxyChecking, setIsProxyChecking] = useState(false);
  const [isProxySwitching, setIsProxySwitching] = useState(false);
  const [isProxyDelayChecking, setIsProxyDelayChecking] = useState(false);
  const [isRuleChecking, setIsRuleChecking] = useState(false);
  const [isSystemProxyBusy, setIsSystemProxyBusy] = useState(false);
  const [isActivationBusy, setIsActivationBusy] = useState(false);
  const [isProfileSettingsBusy, setIsProfileSettingsBusy] = useState(false);
  const [isScheduleBusy, setIsScheduleBusy] = useState(false);
  const [isImportBusy, setIsImportBusy] = useState(false);
  const [isOverrideBusy, setIsOverrideBusy] = useState(false);
  const [exportingHistoryId, setExportingHistoryId] = useState<string | null>(null);
  const [result, setResult] = useState<string>("Idle");
  const [profileSettingsResult, setProfileSettingsResult] =
    useState<string>("Profile settings not loaded");
  const [scheduleRuntimeStatus, setScheduleRuntimeStatus] =
    useState<SubscriptionScheduleRuntimeStatus | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleIntervalMinutes, setScheduleIntervalMinutes] = useState("1440");
  const [scheduleResult, setScheduleResult] =
    useState<string>("Subscription schedule not loaded");
  const [overrideState, setOverrideState] = useState<OverrideSettingsState | null>(null);
  const [overrideResult, setOverrideResult] = useState<string>("Overrides not loaded");
  const [activationStatus, setActivationStatus] = useState<ActivationStatusResponse | null>(null);
  const [activationResult, setActivationResult] = useState<string>("Not connected");
  const [healthResult, setHealthResult] = useState<string>("Controller health not checked");
  const [observationResult, setObservationResult] =
    useState<string>("Controller observations not checked");
  const [proxyResult, setProxyResult] = useState<string>("Controller proxies not checked");
  const [ruleResult, setRuleResult] = useState<string>("Controller rules not checked");
  const [proxySwitchGroup, setProxySwitchGroup] = useState("");
  const [proxySwitchTarget, setProxySwitchTarget] = useState("");
  const [systemProxyStatus, setSystemProxyStatus] = useState<SystemProxyStatusResponse | null>(null);
  const [systemProxyResult, setSystemProxyResult] = useState<string>("System proxy not checked");
  const [coreStatus, setCoreStatus] = useState<CoreProcessStatusResponse | null>(null);
  const [coreResult, setCoreResult] = useState<string>("Core idle");
  const [controllerLogStatus, setControllerLogStatus] =
    useState<ControllerLogStatusResponse | null>(null);
  const [controllerLogResult, setControllerLogResult] = useState<string>("Controller logs idle");
  const [history, setHistory] = useState<PipelineRunHistoryRecord[]>([]);
  const [logs, setLogs] = useState<CoreLogViewEvent[]>([]);
  const [diagnosticResult, setDiagnosticResult] =
    useState<string>("No diagnostic report exported");

  useEffect(() => {
    void refreshHistory();
    void refreshLogs();
    void refreshCoreStatus();
    void refreshControllerLogStatus();
    void refreshSystemProxyStatus();
    void refreshActivationStatus();
    void refreshOverrideSettings();
  }, []);

  useEffect(() => {
    if (overrideState) {
      setOverrideResult(formatOverrideState(overrideState, form.profileId));
    }
  }, [overrideState, form.profileId]);

  function updateField<K extends keyof PipelineFormState>(key: K, value: PipelineFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function runPipeline() {
    setIsRunning(true);
    setResult("Running");
    try {
      const response = await window.mioproxy.runProfilePipeline(buildPipelineInput(form));
      if (response.ok) {
        setResult(
          `Applied by ${response.mode}\nactive: ${response.activePath}\nlast-known-good: ${response.lastKnownGoodPath}`
        );
      } else {
        setResult(
          `Failed at ${response.stage}\n${response.error.message}\nbundle: ${response.failureBundlePath}`
        );
      }
      await refreshHistory();
      await refreshLogs();
      await refreshCoreStatus();
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunning(false);
    }
  }

  async function validateProfile() {
    setIsRunning(true);
    setResult("Validating");
    try {
      const response = await window.mioproxy.prepareProfile(buildPipelineInput(form));
      if (response.ok) {
        setResult(`Validated and promoted\nactive: ${response.activePath}`);
      } else {
        setResult(`Validation failed at ${response.stage}\n${response.error.message}`);
      }
      await Promise.all([refreshHistory(), refreshLogs(), refreshCoreStatus()]);
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunning(false);
    }
  }

  async function loadProfileSettings() {
    setIsProfileSettingsBusy(true);
    try {
      const settings = await window.mioproxy.loadProfileSettings(form.profileId);
      if (!settings) {
        setProfileSettingsResult("No saved settings");
        return;
      }
      setForm((current) => applyProfileSettings(current, settings));
      setProfileSettingsResult(`Loaded ${settings.profileId}\nupdated: ${settings.updatedAt}`);
      await refreshOverrideSettings();
    } catch (error) {
      setProfileSettingsResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsProfileSettingsBusy(false);
    }
  }

  async function saveProfileSettings() {
    setIsProfileSettingsBusy(true);
    try {
      const settings = await window.mioproxy.saveProfileSettings(buildProfileSettings(form));
      setProfileSettingsResult(`Saved ${settings.profileId}\nupdated: ${settings.updatedAt}`);
    } catch (error) {
      setProfileSettingsResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsProfileSettingsBusy(false);
    }
  }

  async function loadSubscriptionSchedule() {
    setIsScheduleBusy(true);
    try {
      const loaded = await window.mioproxy.loadSubscriptionSchedule(form.profileId);
      const runtime = await window.mioproxy.getSubscriptionScheduleRuntimeStatus(form.profileId);
      applySubscriptionSchedule(loaded);
      setScheduleRuntimeStatus(runtime);
      setScheduleResult(`${formatSubscriptionSchedule(loaded)}\n${formatSubscriptionRuntime(runtime)}`);
    } catch (error) {
      setScheduleResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsScheduleBusy(false);
    }
  }

  async function saveSubscriptionSchedule() {
    setIsScheduleBusy(true);
    try {
      const runtimeInput = scheduleEnabled ? buildPipelineInput(form) : null;
      const saved = await window.mioproxy.saveSubscriptionSchedule({
        profileId: form.profileId,
        enabled: scheduleEnabled,
        intervalMinutes: Number.parseInt(scheduleIntervalMinutes, 10)
      });
      const runtime = runtimeInput
        ? await window.mioproxy.armSubscriptionSchedule({
            profileId: saved.profileId,
            pipelineInput: runtimeInput
          })
        : await window.mioproxy.disarmSubscriptionSchedule(saved.profileId);
      applySubscriptionSchedule(saved);
      setScheduleRuntimeStatus(runtime);
      setScheduleResult(`${formatSubscriptionSchedule(saved)}\n${formatSubscriptionRuntime(runtime)}`);
    } catch (error) {
      setScheduleResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsScheduleBusy(false);
    }
  }

  async function updateSubscriptionNow() {
    setIsScheduleBusy(true);
    try {
      const pipelineInput = buildPipelineInput(form);
      const response = await window.mioproxy.tickSubscriptionSchedule({
        profileId: form.profileId,
        pipelineInput,
        force: true
      });
      const runtime = response.schedule.enabled
        ? await window.mioproxy.armSubscriptionSchedule({
            profileId: response.schedule.profileId,
            pipelineInput
          })
        : await window.mioproxy.getSubscriptionScheduleRuntimeStatus(form.profileId);
      applySubscriptionSchedule(response.schedule);
      setScheduleRuntimeStatus(runtime);
      if (response.status === "success" && response.prepare?.ok) {
        setScheduleResult(
          `updated\nactive: ${response.prepare.activePath}\n${formatSubscriptionSchedule(response.schedule)}\n${formatSubscriptionRuntime(runtime)}`
        );
      } else if (response.status === "failed") {
        setScheduleResult(
          `failed at ${response.stage ?? "unknown"}\n${response.error?.message ?? "unknown error"}\n${formatSubscriptionSchedule(response.schedule)}\n${formatSubscriptionRuntime(runtime)}`
        );
      } else {
        setScheduleResult(
          `skipped: ${response.reason ?? "unknown"}\n${formatSubscriptionSchedule(response.schedule)}\n${formatSubscriptionRuntime(runtime)}`
        );
      }
      await Promise.all([refreshCoreStatus(), refreshLogs()]);
    } catch (error) {
      setScheduleResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsScheduleBusy(false);
    }
  }

  function applySubscriptionSchedule(next: SubscriptionUpdateSchedule) {
    setScheduleEnabled(next.enabled);
    setScheduleIntervalMinutes(String(next.intervalMinutes));
  }

  async function importClashParty() {
    setIsImportBusy(true);
    try {
      const sourceDir = form.clashPartySourceDir.trim();
      if (!sourceDir) {
        throw new Error("Clash Party source directory is required");
      }

      const result = await window.mioproxy.importClashParty({ sourceDir });
      const firstProfile = result.profiles[0];
      if (firstProfile) {
        setForm((current) => applyProfileSettings(current, firstProfile));
      }
      setProfileSettingsResult(
        [
          `Imported profiles: ${result.profiles.length}`,
          `Imported overrides: ${result.overrides.length}`,
          ...result.warnings.map((warning) => `warning: ${warning}`)
        ].join("\n")
      );
      await refreshOverrideSettings();
    } catch (error) {
      setProfileSettingsResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsImportBusy(false);
    }
  }

  async function refreshHistory() {
    setHistory(await window.mioproxy.listPipelineHistory());
  }

  async function exportFailureReport(historyId: string) {
    setExportingHistoryId(historyId);
    try {
      const response = await window.mioproxy.exportFailureReport({ historyId });
      setDiagnosticResult(
        response.ok
          ? `report: ${response.reportDir}\nfiles: ${response.files.join(", ")}`
          : response.error.message
      );
    } catch (error) {
      setDiagnosticResult(error instanceof Error ? error.message : String(error));
    } finally {
      setExportingHistoryId(null);
    }
  }

  async function refreshLogs() {
    setLogs(await window.mioproxy.listCoreLogs(form.profileId));
  }

  async function refreshCoreStatus() {
    setCoreStatus(await window.mioproxy.getCoreStatus(form.profileId));
  }

  async function refreshControllerLogStatus() {
    setControllerLogStatus(await window.mioproxy.getControllerLogStatus(form.profileId));
  }

  async function refreshSystemProxyStatus() {
    const status = await window.mioproxy.getSystemProxyStatus();
    setSystemProxyStatus(status);
    setSystemProxyResult(formatSystemProxyStatus(status));
  }

  async function refreshActivationStatus() {
    const status = await window.mioproxy.getActivationStatus(form.profileId);
    setActivationStatus(status);
    setActivationResult(formatActivationStatus(status));
  }

  async function refreshOverrideSettings() {
    const state = await window.mioproxy.getOverrideSettings();
    setOverrideState(state);
    setOverrideResult(formatOverrideState(state, form.profileId));
  }

  function profileSelectedOverrideIds(): string[] {
    return overrideState?.selections[form.profileId] ?? [];
  }

  function activeOverrideIds(): string[] {
    const globalIds =
      overrideState?.items
        .filter((item) => item.global)
        .map((item) => item.id) ?? [];
    return [...new Set([...globalIds, ...profileSelectedOverrideIds()])];
  }

  function toggleOverrideSelection(id: string) {
    setOverrideState((current) => {
      if (!current) {
        return current;
      }
      if (current.items.find((item) => item.id === id)?.global) {
        return current;
      }
      const selected = new Set(current.selections[form.profileId] ?? []);
      if (selected.has(id)) {
        selected.delete(id);
      } else {
        selected.add(id);
      }
      return {
        ...current,
        selections: {
          ...current.selections,
          [form.profileId]: [...selected]
        }
      };
    });
  }

  async function saveOverrideSelection() {
    setIsOverrideBusy(true);
    try {
      const state = await window.mioproxy.setOverrideSelection({
        profileId: form.profileId,
        selectedIds: profileSelectedOverrideIds().filter(
          (id) => !overrideState?.items.find((item) => item.id === id)?.global
        )
      });
      setOverrideState(state);
      setOverrideResult(formatOverrideState(state, form.profileId));
    } catch (error) {
      setOverrideResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsOverrideBusy(false);
    }
  }

  async function startCore() {
    setIsCoreBusy(true);
    try {
      const response = await window.mioproxy.startCore(buildCoreStartInput(form));
      setCoreStatus(response.status);
      setCoreResult(response.ok ? formatCoreStatus(response.status) : response.error.message);
      await refreshLogs();
    } catch (error) {
      setCoreResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCoreBusy(false);
    }
  }

  async function stopCore() {
    setIsCoreBusy(true);
    try {
      const response = await window.mioproxy.stopCore(form.profileId);
      setCoreStatus(response.status);
      setCoreResult(response.ok ? formatCoreStatus(response.status) : response.error.message);
      await refreshLogs();
    } catch (error) {
      setCoreResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCoreBusy(false);
    }
  }

  async function startControllerLogs() {
    setIsControllerLogBusy(true);
    try {
      const response = await window.mioproxy.startControllerLogs(buildControllerLogStartInput(form));
      setControllerLogStatus(response.status);
      setControllerLogResult(
        response.ok ? formatControllerLogStatus(response.status) : response.error.message
      );
      await refreshLogs();
    } catch (error) {
      setControllerLogResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsControllerLogBusy(false);
    }
  }

  async function stopControllerLogs() {
    setIsControllerLogBusy(true);
    try {
      const response = await window.mioproxy.stopControllerLogs(form.profileId);
      setControllerLogStatus(response.status);
      setControllerLogResult(
        response.ok ? formatControllerLogStatus(response.status) : response.error.message
      );
      await refreshLogs();
    } catch (error) {
      setControllerLogResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsControllerLogBusy(false);
    }
  }

  async function checkControllerHealth() {
    setIsHealthChecking(true);
    try {
      const response = await window.mioproxy.checkControllerHealth(buildControllerHealthInput(form));
      setHealthResult(formatControllerHealth(response));
    } catch (error) {
      setHealthResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsHealthChecking(false);
    }
  }

  async function checkControllerObservations() {
    setIsObservationChecking(true);
    try {
      const controller = buildControllerHealthInput(form);
      const response = await window.mioproxy.getControllerObservations({
        ...controller,
        connectionLimit: 8
      });
      setObservationResult(formatControllerObservations(response));
    } catch (error) {
      setObservationResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsObservationChecking(false);
    }
  }

  async function checkControllerProxies() {
    setIsProxyChecking(true);
    try {
      const controller = buildControllerHealthInput(form);
      const response = await window.mioproxy.getControllerProxies({
        ...controller,
        groupLimit: 12,
        optionLimit: 6
      });
      setProxyResult(formatControllerProxies(response));
    } catch (error) {
      setProxyResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsProxyChecking(false);
    }
  }

  async function switchControllerProxy() {
    setIsProxySwitching(true);
    try {
      const controller = buildControllerHealthInput(form);
      const response = await window.mioproxy.switchControllerProxy({
        ...controller,
        groupName: proxySwitchGroup,
        proxyName: proxySwitchTarget,
        refresh: true,
        groupLimit: 12,
        optionLimit: 6
      });
      if (response.ok && response.snapshot) {
        setProxyResult(
          `switched ${response.groupName} -> ${response.proxyName}\n${formatControllerProxies(response.snapshot)}`
        );
      } else {
        setProxyResult(
          response.ok
            ? `switched ${response.groupName} -> ${response.proxyName}`
            : `switch failed\n${response.error.message}`
        );
      }
    } catch (error) {
      setProxyResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsProxySwitching(false);
    }
  }

  async function testControllerProxyDelay() {
    setIsProxyDelayChecking(true);
    try {
      const controller = buildControllerHealthInput(form);
      const response = await window.mioproxy.testControllerProxyDelay({
        ...controller,
        proxyName: proxySwitchTarget
      });
      setProxyResult(formatControllerProxyDelay(response));
    } catch (error) {
      setProxyResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsProxyDelayChecking(false);
    }
  }

  async function checkControllerRules() {
    setIsRuleChecking(true);
    try {
      const controller = buildControllerHealthInput(form);
      const response = await window.mioproxy.getControllerRules({
        ...controller,
        ruleLimit: 12,
        providerLimit: 12
      });
      setRuleResult(formatControllerRules(response));
    } catch (error) {
      setRuleResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRuleChecking(false);
    }
  }

  async function enableSystemProxy() {
    setIsSystemProxyBusy(true);
    try {
      const response = await window.mioproxy.enableSystemProxy(buildSystemProxyEnableInput(form));
      setSystemProxyStatus(response.status);
      setSystemProxyResult(
        response.ok ? formatSystemProxyStatus(response.status) : response.error.message
      );
    } catch (error) {
      setSystemProxyResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSystemProxyBusy(false);
    }
  }

  async function disableSystemProxy() {
    setIsSystemProxyBusy(true);
    try {
      const response = await window.mioproxy.disableSystemProxy();
      setSystemProxyStatus(response.status);
      setSystemProxyResult(
        response.ok ? formatSystemProxyStatus(response.status) : response.error.message
      );
    } catch (error) {
      setSystemProxyResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSystemProxyBusy(false);
    }
  }

  async function restoreSystemProxy() {
    setIsSystemProxyBusy(true);
    try {
      const response = await window.mioproxy.restoreSystemProxy();
      setSystemProxyStatus(response.status);
      setSystemProxyResult(
        response.ok ? formatSystemProxyStatus(response.status) : response.error.message
      );
    } catch (error) {
      setSystemProxyResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSystemProxyBusy(false);
    }
  }

  async function connectProfile() {
    setIsActivationBusy(true);
    try {
      setActivationResult("Preparing active config");
      const prepared = await window.mioproxy.prepareProfile(buildPipelineInput(form));
      if (!prepared.ok) {
        setActivationResult(`Prepare failed at ${prepared.stage}\n${prepared.error.message}`);
        return;
      }

      const response = await window.mioproxy.connectProfile(buildActivationStartInput(form));
      setActivationStatus(response.status);
      setActivationResult(
        response.ok
          ? `prepared: ${prepared.activePath}\n${formatActivationStatus(response.status)}`
          : response.error.message
      );
      await Promise.all([
        refreshCoreStatus(),
        refreshControllerLogStatus(),
        refreshSystemProxyStatus(),
        refreshLogs()
      ]);
    } catch (error) {
      setActivationResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsActivationBusy(false);
    }
  }

  async function disconnectProfile() {
    setIsActivationBusy(true);
    try {
      const response = await window.mioproxy.disconnectProfile(form.profileId);
      setActivationStatus(response.status);
      setActivationResult(
        response.ok ? formatActivationStatus(response.status) : response.error.message
      );
      await Promise.all([
        refreshCoreStatus(),
        refreshControllerLogStatus(),
        refreshSystemProxyStatus(),
        refreshLogs()
      ]);
    } catch (error) {
      setActivationResult(error instanceof Error ? error.message : String(error));
    } finally {
      setIsActivationBusy(false);
    }
  }

  const latestRun = history.find((item) => item.profileId === form.profileId) ?? history[0];
  const lastUpdated = latestRun
    ? new Date(latestRun.createdAt).toLocaleString()
    : "No pipeline runs yet";
  const configStatus = latestRun
    ? latestRun.ok
      ? `Passed: ${latestRun.stage}`
      : `Failed: ${latestRun.stage}`
    : "Not checked";
  const coreStatusLabel = coreStatus?.running ? "Running" : "Stopped";
  const configHealthLabel = latestRun ? (latestRun.ok ? "Healthy" : "Needs attention") : "Unchecked";
  const systemProxyLabel =
    systemProxyStatus?.supported === false
      ? "Unsupported"
      : systemProxyStatus?.enabled
        ? "Enabled"
        : "Disabled";
  const activityItems = history.length
    ? history.slice(0, 5).map((item) => ({
        title: item.ok ? "Pipeline completed" : "Pipeline failed",
        detail: `${item.profileId} / ${item.stage} / ${new Date(item.createdAt).toLocaleString()}`,
        tone: item.ok ? ("success" as const) : ("warning" as const)
      }))
    : fallbackActivityItems;

  return {
    form,
    updateField,
    isRunning,
    isCoreBusy,
    isControllerLogBusy,
    isHealthChecking,
    isObservationChecking,
    isProxyChecking,
    isProxySwitching,
    isProxyDelayChecking,
    isRuleChecking,
    isSystemProxyBusy,
    isActivationBusy,
    isProfileSettingsBusy,
    isScheduleBusy,
    isImportBusy,
    isOverrideBusy,
    exportingHistoryId,
    result,
    profileSettingsResult,
    scheduleRuntimeStatus,
    scheduleEnabled,
    setScheduleEnabled,
    scheduleIntervalMinutes,
    setScheduleIntervalMinutes,
    scheduleResult,
    overrideState,
    overrideResult,
    activationStatus,
    activationResult,
    healthResult,
    observationResult,
    proxyResult,
    ruleResult,
    proxySwitchGroup,
    setProxySwitchGroup,
    proxySwitchTarget,
    setProxySwitchTarget,
    systemProxyStatus,
    systemProxyResult,
    coreStatus,
    coreResult,
    controllerLogStatus,
    controllerLogResult,
    history,
    logs,
    diagnosticResult,
    latestRun,
    lastUpdated,
    configStatus,
    coreStatusLabel,
    configHealthLabel,
    systemProxyLabel,
    activityItems,
    runPipeline,
    validateProfile,
    loadProfileSettings,
    saveProfileSettings,
    loadSubscriptionSchedule,
    saveSubscriptionSchedule,
    updateSubscriptionNow,
    importClashParty,
    refreshHistory,
    exportFailureReport,
    refreshLogs,
    refreshCoreStatus,
    refreshControllerLogStatus,
    refreshSystemProxyStatus,
    refreshActivationStatus,
    refreshOverrideSettings,
    activeOverrideIds,
    toggleOverrideSelection,
    saveOverrideSelection,
    startCore,
    stopCore,
    startControllerLogs,
    stopControllerLogs,
    checkControllerHealth,
    checkControllerObservations,
    checkControllerProxies,
    switchControllerProxy,
    testControllerProxyDelay,
    checkControllerRules,
    enableSystemProxy,
    disableSystemProxy,
    restoreSystemProxy,
    connectProfile,
    disconnectProfile
  };
}

export type MioProxyAppState = ReturnType<typeof useMioProxyAppStateValue>;

const MioProxyAppStateContext = createContext<MioProxyAppState | null>(null);

export function MioProxyAppProvider({ children }: { children: ReactNode }) {
  const value = useMioProxyAppStateValue();
  return (
    <MioProxyAppStateContext.Provider value={value}>
      {children}
    </MioProxyAppStateContext.Provider>
  );
}

export function useMioProxyApp() {
  const context = useContext(MioProxyAppStateContext);
  if (!context) {
    throw new Error("useMioProxyApp must be used within MioProxyAppProvider");
  }
  return context;
}

function formatCoreStatus(status: CoreProcessStatusResponse): string {
  const lines = [
    status.running ? "running" : "stopped",
    `profile: ${status.profileId}`,
    status.pid ? `pid: ${status.pid}` : undefined,
    status.activePath ? `active: ${status.activePath}` : undefined,
    status.startedAt ? `started: ${status.startedAt}` : undefined,
    status.lastExit
      ? `last exit: ${status.lastExit.exitCode ?? "null"} ${status.lastExit.signal ?? ""}`.trim()
      : undefined,
    status.lastExit?.errorMessage ? `error: ${status.lastExit.errorMessage}` : undefined
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function formatControllerLogStatus(status: ControllerLogStatusResponse): string {
  const lines = [
    status.running ? "collecting" : "stopped",
    `profile: ${status.profileId}`,
    status.level ? `level: ${status.level}` : undefined,
    status.startedAt ? `started: ${status.startedAt}` : undefined,
    status.lastError ? `last error: ${status.lastError.message}` : undefined
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function formatSubscriptionSchedule(schedule: SubscriptionUpdateSchedule): string {
  const lines = [
    schedule.enabled ? "enabled" : "disabled",
    `profile: ${schedule.profileId}`,
    `interval: ${schedule.intervalMinutes} minutes`,
    schedule.nextRunAt ? `next: ${new Date(schedule.nextRunAt).toLocaleString()}` : undefined,
    schedule.lastRunAt ? `last: ${new Date(schedule.lastRunAt).toLocaleString()}` : undefined,
    schedule.lastStatus ? `last status: ${schedule.lastStatus}` : undefined,
    schedule.lastStage ? `last stage: ${schedule.lastStage}` : undefined,
    schedule.lastErrorMessage ? `last error: ${schedule.lastErrorMessage}` : undefined,
    `updated: ${new Date(schedule.updatedAt).toLocaleString()}`
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function formatSubscriptionRuntime(status: SubscriptionScheduleRuntimeStatus): string {
  const lines = [
    status.armed ? "runtime: armed" : "runtime: not armed",
    status.armedAt ? `armed: ${new Date(status.armedAt).toLocaleString()}` : undefined,
    status.lastTickAt ? `runtime tick: ${new Date(status.lastTickAt).toLocaleString()}` : undefined,
    status.lastTickStatus ? `runtime status: ${status.lastTickStatus}` : undefined,
    status.lastErrorMessage ? `runtime error: ${status.lastErrorMessage}` : undefined
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function formatControllerHealth(response: ControllerHealthResponse): string {
  if (!response.ok) {
    return [
      "offline",
      `checked: ${response.checkedAt}`,
      response.versionStatus ? `version status: ${response.versionStatus}` : undefined,
      response.configsStatus ? `configs status: ${response.configsStatus}` : undefined,
      `error: ${response.error.message}`
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  const config = response.config;
  return [
    "online",
    `checked: ${response.checkedAt}`,
    response.version.version ? `version: ${response.version.version}` : undefined,
    response.version.meta !== undefined ? `meta: ${String(response.version.meta)}` : undefined,
    config.mode ? `mode: ${config.mode}` : undefined,
    config.logLevel ? `log-level: ${config.logLevel}` : undefined,
    config.mixedPort !== undefined ? `mixed-port: ${config.mixedPort}` : undefined,
    config.port !== undefined ? `port: ${config.port}` : undefined,
    config.socksPort !== undefined ? `socks-port: ${config.socksPort}` : undefined,
    config.allowLan !== undefined ? `allow-lan: ${String(config.allowLan)}` : undefined,
    config.tunEnabled !== undefined ? `tun: ${String(config.tunEnabled)}` : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatControllerObservations(response: ControllerObservationResponse): string {
  if (!response.ok) {
    return [
      "unavailable",
      `checked: ${response.checkedAt}`,
      response.trafficStatus ? `traffic status: ${response.trafficStatus}` : undefined,
      response.connectionsStatus ? `connections status: ${response.connectionsStatus}` : undefined,
      `error: ${response.error.message}`
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  const connectionLines = response.connections.items.map((item) => {
    const target = item.destination ?? item.host ?? "unknown";
    const chain = item.chain.length > 0 ? item.chain.join(" > ") : "no chain";
    const rule = item.rule
      ? `${item.rule}${item.rulePayload ? `:${item.rulePayload}` : ""}`
      : "no rule";
    return `- ${target} ${formatBytes(item.download)} down / ${formatBytes(item.upload)} up ${rule} ${chain}`;
  });

  return [
    "observed",
    `checked: ${response.checkedAt}`,
    `traffic: ${formatBytes(response.traffic.download)}/s down, ${formatBytes(response.traffic.upload)}/s up`,
    `totals: ${formatBytes(response.connections.downloadTotal)} down, ${formatBytes(response.connections.uploadTotal)} up`,
    `active connections: ${response.connections.count}`,
    ...connectionLines
  ].join("\n");
}

function formatControllerProxies(response: ControllerProxySnapshotResponse): string {
  if (!response.ok) {
    return [
      "unavailable",
      `checked: ${response.checkedAt}`,
      response.proxiesStatus ? `proxies status: ${response.proxiesStatus}` : undefined,
      `error: ${response.error.message}`
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  const groupLines = response.groups.map((group) => {
    const options = group.options.length > 0 ? group.options.join(", ") : "no options";
    const current = group.current ? ` current: ${group.current}` : "";
    return `- ${group.name} [${group.type}]${current} options: ${group.optionCount} (${options})`;
  });

  return [
    "loaded",
    `checked: ${response.checkedAt}`,
    `proxies: ${response.total}`,
    `groups: ${response.groups.length}`,
    ...groupLines
  ].join("\n");
}

function formatControllerProxyDelay(response: ControllerProxyDelayResponse): string {
  if (!response.ok) {
    return [
      "delay failed",
      `checked: ${response.checkedAt}`,
      response.status ? `status: ${response.status}` : undefined,
      response.proxyName ? `proxy: ${response.proxyName}` : undefined,
      `error: ${response.error.message}`
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  return [
    "delay ok",
    `checked: ${response.checkedAt}`,
    `proxy: ${response.proxyName}`,
    `delay: ${response.delayMs} ms`,
    `timeout: ${response.timeoutMs} ms`,
    `url: ${response.testUrl}`
  ].join("\n");
}

function formatControllerRules(response: ControllerRulesSnapshotResponse): string {
  if (!response.ok) {
    return [
      "unavailable",
      `checked: ${response.checkedAt}`,
      response.rulesStatus ? `rules status: ${response.rulesStatus}` : undefined,
      response.providersStatus ? `providers status: ${response.providersStatus}` : undefined,
      `error: ${response.error.message}`
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  const ruleLines = response.rules.items.map((rule) => {
    const target = rule.payload ? ` ${rule.payload}` : "";
    const proxy = rule.proxy ? ` -> ${rule.proxy}` : "";
    const size = rule.size !== undefined ? ` size:${rule.size}` : "";
    return `- ${rule.type ?? "RULE"}${target}${proxy}${size}`;
  });
  const providerLines = response.providers.items.map((provider) => {
    const behavior = provider.behavior ? ` ${provider.behavior}` : "";
    const count = provider.ruleCount !== undefined ? ` rules:${provider.ruleCount}` : "";
    return `- ${provider.name} [${provider.type ?? "unknown"}${behavior}]${count}`;
  });

  return [
    "loaded",
    `checked: ${response.checkedAt}`,
    `rules: ${response.rules.total}`,
    ...ruleLines,
    `providers: ${response.providers.total}`,
    ...providerLines
  ].join("\n");
}

function formatSystemProxyStatus(status: SystemProxyStatusResponse): string {
  if (!status.supported) {
    return "unsupported";
  }

  return [
    status.enabled ? "enabled" : "disabled",
    status.server ? `server: ${status.server}` : undefined,
    status.bypass ? `bypass: ${status.bypass}` : undefined,
    status.capturedAt ? `checked: ${status.capturedAt}` : undefined,
    `managed snapshot: ${String(status.managedSnapshot)}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatActivationStatus(status: ActivationStatusResponse): string {
  const lines = [
    status.connected ? "connected" : "disconnected",
    `profile: ${status.profileId}`,
    ...status.steps.map((step) =>
      `${step.ok ? "ok" : "failed"} ${step.name}${step.skipped ? " skipped" : ""}${
        step.errorMessage ? `: ${step.errorMessage}` : ""
      }`
    ),
    status.rollback
      ? `rollback system proxy: ${String(status.rollback.systemProxy.ok)}`
      : undefined,
    status.rollback
      ? `rollback controller logs: ${String(status.rollback.controllerLogs.ok)}`
      : undefined,
    status.rollback ? `rollback core: ${String(status.rollback.core.ok)}` : undefined,
    status.rollback ? `rollback active config: ${String(status.rollback.config.ok)}` : undefined
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function formatOverrideState(state: OverrideSettingsState, profileId: string): string {
  const global = state.items.filter((item) => item.global).map((item) => item.id);
  const selected = state.selections[profileId] ?? [];
  const active = [...new Set([...global, ...selected])];
  return [
    `available: ${state.items.length}`,
    `profile: ${profileId}`,
    `active: ${active.length}`,
    global.length > 0 ? `global: ${global.length}` : undefined,
    active.length > 0 ? active.join(", ") : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
