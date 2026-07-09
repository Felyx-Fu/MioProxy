import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import brandMarkUrl from "../../../assets/icons/Win/mioproxy-app-icon.svg";
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
} from "../../shared/pipelineTypes";
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
} from "./pipelineForm";
import "./styles.css";

const navigationItems = [
  { label: "Dashboard", targetId: "dashboard" },
  { label: "Profiles", targetId: "profile-management", opensManagement: true },
  { label: "Nodes", targetId: "proxy-groups", opensManagement: true },
  { label: "Rules", targetId: "rules", opensManagement: true },
  { label: "Overrides", targetId: "overrides", opensManagement: true },
  { label: "Logs", targetId: "core-logs", opensManagement: true },
  { label: "Settings", targetId: "pipeline-inputs", opensManagement: true }
];

const pipelineSteps = [
  { label: "Download", detail: "subscription cache" },
  { label: "Override", detail: "YAML / JS" },
  { label: "Sanitize", detail: "Mihomo compat" },
  { label: "Stage", detail: "candidate.yaml" },
  { label: "Validate", detail: "mihomo -t" },
  { label: "Promote", detail: "active.yaml" },
  { label: "Apply", detail: "reload / restart" },
  { label: "Rollback", detail: "last-known-good" }
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
  }
];

function App() {
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
  const [profileSettingsResult, setProfileSettingsResult] = useState<string>("Profile settings not loaded");
  const [schedule, setSchedule] = useState<SubscriptionUpdateSchedule | null>(null);
  const [scheduleRuntimeStatus, setScheduleRuntimeStatus] =
    useState<SubscriptionScheduleRuntimeStatus | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleIntervalMinutes, setScheduleIntervalMinutes] = useState("1440");
  const [scheduleResult, setScheduleResult] = useState<string>("Subscription schedule not loaded");
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
  const [diagnosticResult, setDiagnosticResult] = useState<string>("No diagnostic report exported");
  const [isManagementOpen, setIsManagementOpen] = useState(false);

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

  function navigateToSection(targetId: string, opensManagement?: boolean) {
    if (opensManagement) {
      setIsManagementOpen(true);
    }
    window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({
        block: "start",
        behavior: "smooth"
      });
    });
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
    setSchedule(next);
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
    const globalIds = overrideState?.items
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
      setSystemProxyResult(response.ok ? formatSystemProxyStatus(response.status) : response.error.message);
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
      setSystemProxyResult(response.ok ? formatSystemProxyStatus(response.status) : response.error.message);
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
      setSystemProxyResult(response.ok ? formatSystemProxyStatus(response.status) : response.error.message);
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
      setActivationResult(response.ok ? formatActivationStatus(response.status) : response.error.message);
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
  const systemProxyLabel = systemProxyStatus?.supported === false
    ? "Unsupported"
    : systemProxyStatus?.enabled
      ? "Enabled"
      : "Disabled";
  const activityItems = history.length
    ? history.slice(0, 4).map((item) => ({
        title: item.ok ? "Pipeline completed" : "Pipeline failed",
        detail: `${item.profileId} / ${item.stage} / ${new Date(item.createdAt).toLocaleString()}`,
        tone: item.ok ? ("success" as const) : ("warning" as const)
      }))
    : fallbackActivityItems;

  return (
    <AppShell onNavigate={navigateToSection}>
      <header className="dashboard-header" id="dashboard">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h2>Dashboard</h2>
          <p>Monitor profiles, core status, and recent configuration activity.</p>
        </div>
        <div className="header-badges" aria-label="Application status">
          <span className="status-badge">MVP</span>
          <span className={`status-badge ${coreStatus?.running ? "success" : "neutral"}`}>
            {coreStatusLabel}
          </span>
        </div>
      </header>

      <section className="status-grid" aria-label="Runtime overview">
        <StatusCard
          title="Core Status"
          value={coreStatusLabel}
          detail={coreStatus?.pid ? `PID ${coreStatus.pid}` : "No core process is active"}
          tone={coreStatus?.running ? "success" : "neutral"}
        />
        <StatusCard
          title="Active Profile"
          value={form.profileId || "default"}
          detail={lastUpdated}
        />
        <StatusCard
          title="Config Health"
          value={configHealthLabel}
          detail={configStatus}
          tone={latestRun?.ok ? "success" : latestRun ? "warning" : "neutral"}
        />
        <StatusCard
          title="System Proxy"
          value={systemProxyLabel}
          detail={
            systemProxyStatus?.managedSnapshot
              ? "Managed snapshot available"
              : "No managed snapshot"
          }
          tone={systemProxyStatus?.enabled ? "success" : "neutral"}
        />
      </section>

      <section className="dashboard-grid">
        <ProfileSummaryCard
          profileId={form.profileId}
          controllerBaseUrl={form.controllerBaseUrl}
          lastUpdated={lastUpdated}
          configStatus={configStatus}
          onUpdate={() => void updateSubscriptionNow()}
          updateDisabled={isScheduleBusy}
          updateLabel={isScheduleBusy ? "Updating" : "Update Now"}
          onValidate={() => void validateProfile()}
          validateDisabled={isRunning}
          onReload={() => void runPipeline()}
          reloadDisabled={isRunning}
        />
        <ActivityList items={activityItems} />
        <PipelineStepper steps={pipelineSteps} />
      </section>

      <form
        className="management-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runPipeline();
        }}
      >
        <details
          className="profile-management-panel"
          id="profile-management"
          open={isManagementOpen}
          onToggle={(event) => setIsManagementOpen(event.currentTarget.open)}
        >
          <summary>
            <span>
              <strong>Profile Management</strong>
              <small>Profile settings, schedules, overrides, controller tools, and logs</small>
            </span>
            <span className="summary-action">Open panel</span>
          </summary>

          <div className="management-grid">
            <section className="management-card profile-settings-section">
              <div className="section-title-row">
                <h3>Profile settings</h3>
                <div className="inline-actions">
                  <button
                    type="button"
                    onClick={() => void loadProfileSettings()}
                    disabled={isProfileSettingsBusy}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveProfileSettings()}
                    disabled={isProfileSettingsBusy}
                  >
                    Save
                  </button>
                </div>
              </div>
              <label>
                Profile
                <input
                  value={form.profileId}
                  onChange={(event) => updateField("profileId", event.target.value)}
                />
              </label>
              <label>
                Clash Party source
                <input
                  value={form.clashPartySourceDir}
                  onChange={(event) => updateField("clashPartySourceDir", event.target.value)}
                  placeholder="Clash Party data directory"
                />
              </label>
              <button
                type="button"
                onClick={() => void importClashParty()}
                disabled={isImportBusy}
              >
                {isImportBusy ? "Importing" : "Import Clash Party"}
              </button>
              <pre className="result-box compact">{profileSettingsResult}</pre>
            </section>

            <section className="management-card subscription-schedule-section">
              <div className="section-title-row">
                <h3>Subscription schedule</h3>
                <div className="inline-actions">
                  <button
                    type="button"
                    onClick={() => void loadSubscriptionSchedule()}
                    disabled={isScheduleBusy}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveSubscriptionSchedule()}
                    disabled={isScheduleBusy}
                  >
                    Save
                  </button>
                </div>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={scheduleEnabled}
                  onChange={(event) => setScheduleEnabled(event.target.checked)}
                />
                <span>Enabled</span>
              </label>
              <label>
                Interval minutes
                <input
                  value={scheduleIntervalMinutes}
                  onChange={(event) => setScheduleIntervalMinutes(event.target.value)}
                  inputMode="numeric"
                />
              </label>
              <button
                type="button"
                onClick={() => void updateSubscriptionNow()}
                disabled={isScheduleBusy}
              >
                {isScheduleBusy ? "Updating" : "Update now"}
              </button>
              <p>
                Runtime: <strong>{scheduleRuntimeStatus?.armed ? "armed" : "not armed"}</strong>
              </p>
              <pre className="result-box compact">{scheduleResult}</pre>
            </section>

            <section className="management-card override-section" id="overrides">
              <div className="section-title-row">
                <h3>Overrides</h3>
                <div className="inline-actions">
                  <button type="button" onClick={() => void refreshOverrideSettings()}>
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveOverrideSelection()}
                    disabled={isOverrideBusy || overrideState === null}
                  >
                    Save
                  </button>
                </div>
              </div>
              {overrideState?.items.length ? (
                <ol className="override-list">
                  {overrideState.items.map((item) => (
                    <li key={item.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={activeOverrideIds().includes(item.id)}
                          disabled={item.global}
                          onChange={() => toggleOverrideSelection(item.id)}
                        />
                        <span>{item.name}</span>
                      </label>
                      <small>
                        {item.ext}
                        {item.global ? " global" : ""}
                        {item.path ? "" : " missing"}
                      </small>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No imported overrides</p>
              )}
              <pre className="result-box compact">{overrideResult}</pre>
            </section>

            <section className="management-card pipeline-inputs-section" id="pipeline-inputs">
              <div className="section-title-row">
                <h3>Pipeline inputs</h3>
                <button type="submit" disabled={isRunning}>
                  {isRunning ? "Running" : "Run pipeline"}
                </button>
              </div>
              <label>
                Subscription URL
                <input
                  value={form.subscriptionUrl}
                  onChange={(event) => updateField("subscriptionUrl", event.target.value)}
                  placeholder="https://example.test/sub.yaml"
                />
              </label>
              <label>
                Mihomo binary
                <input
                  value={form.mihomoBinaryPath}
                  onChange={(event) => updateField("mihomoBinaryPath", event.target.value)}
                />
              </label>
              <label>
                Mihomo data dir
                <input
                  value={form.mihomoDataDir}
                  onChange={(event) => updateField("mihomoDataDir", event.target.value)}
                />
              </label>
              <label>
                Controller URL
                <input
                  value={form.controllerBaseUrl}
                  onChange={(event) => updateField("controllerBaseUrl", event.target.value)}
                />
              </label>
              <label>
                Controller secret
                <input
                  type="password"
                  value={form.controllerSecret}
                  onChange={(event) => updateField("controllerSecret", event.target.value)}
                />
              </label>
              <div className="field-row">
                <label>
                  System proxy host
                  <input
                    value={form.systemProxyHost}
                    onChange={(event) => updateField("systemProxyHost", event.target.value)}
                  />
                </label>
                <label>
                  System proxy port
                  <input
                    value={form.systemProxyPort}
                    onChange={(event) => updateField("systemProxyPort", event.target.value)}
                  />
                </label>
              </div>
              <label>
                System proxy bypass
                <input
                  value={form.systemProxyBypass}
                  onChange={(event) => updateField("systemProxyBypass", event.target.value)}
                />
              </label>
              <pre className="result-box">{result}</pre>
            </section>

            <section className="management-card activation-section">
              <div className="section-title-row">
                <h3>Activation</h3>
                <button type="button" onClick={() => void refreshActivationStatus()}>
                  Status
                </button>
              </div>
              <div className="core-actions">
                <button
                  type="button"
                  onClick={() => void connectProfile()}
                  disabled={isActivationBusy || activationStatus?.connected === true}
                >
                  Connect
                </button>
                <button
                  type="button"
                  onClick={() => void disconnectProfile()}
                  disabled={isActivationBusy}
                >
                  Disconnect
                </button>
              </div>
              <pre className="result-box compact">{activationResult}</pre>
            </section>

            <section className="management-card health-section">
              <div className="section-title-row">
                <h3>Controller health</h3>
                <button
                  type="button"
                  onClick={() => void checkControllerHealth()}
                  disabled={isHealthChecking}
                >
                  {isHealthChecking ? "Checking" : "Check"}
                </button>
              </div>
              <pre className="result-box compact">{healthResult}</pre>
            </section>

            <section className="management-card observation-section">
              <div className="section-title-row">
                <h3>Controller observations</h3>
                <button
                  type="button"
                  onClick={() => void checkControllerObservations()}
                  disabled={isObservationChecking}
                >
                  {isObservationChecking ? "Reading" : "Read"}
                </button>
              </div>
              <pre className="result-box compact">{observationResult}</pre>
            </section>

            <section className="management-card proxy-groups-section" id="proxy-groups">
              <div className="section-title-row">
                <h3>Proxy groups</h3>
                <button
                  type="button"
                  onClick={() => void checkControllerProxies()}
                  disabled={isProxyChecking}
                >
                  {isProxyChecking ? "Reading" : "Read"}
                </button>
              </div>
              <div className="field-row">
                <label>
                  Group
                  <input
                    value={proxySwitchGroup}
                    onChange={(event) => setProxySwitchGroup(event.target.value)}
                    placeholder="GLOBAL"
                  />
                </label>
                <label>
                  Proxy
                  <input
                    value={proxySwitchTarget}
                    onChange={(event) => setProxySwitchTarget(event.target.value)}
                    placeholder="DIRECT"
                  />
                </label>
              </div>
              <div className="core-actions">
                <button
                  type="button"
                  onClick={() => void switchControllerProxy()}
                  disabled={isProxySwitching}
                >
                  {isProxySwitching ? "Switching" : "Switch proxy"}
                </button>
                <button
                  type="button"
                  onClick={() => void testControllerProxyDelay()}
                  disabled={isProxyDelayChecking}
                >
                  {isProxyDelayChecking ? "Testing" : "Test delay"}
                </button>
              </div>
              <pre className="result-box compact">{proxyResult}</pre>
            </section>

            <section className="management-card rules-section" id="rules">
              <div className="section-title-row">
                <h3>Rules</h3>
                <button
                  type="button"
                  onClick={() => void checkControllerRules()}
                  disabled={isRuleChecking}
                >
                  {isRuleChecking ? "Reading" : "Read"}
                </button>
              </div>
              <pre className="result-box compact">{ruleResult}</pre>
            </section>

            <section className="management-card system-proxy-section">
              <div className="section-title-row">
                <h3>System proxy</h3>
                <button type="button" onClick={() => void refreshSystemProxyStatus()}>
                  Status
                </button>
              </div>
              <div className="proxy-actions">
                <button
                  type="button"
                  onClick={() => void enableSystemProxy()}
                  disabled={isSystemProxyBusy || systemProxyStatus?.supported === false}
                >
                  Enable
                </button>
                <button
                  type="button"
                  onClick={() => void disableSystemProxy()}
                  disabled={isSystemProxyBusy || systemProxyStatus?.supported === false}
                >
                  Disable
                </button>
                <button
                  type="button"
                  onClick={() => void restoreSystemProxy()}
                  disabled={
                    isSystemProxyBusy ||
                    systemProxyStatus?.supported === false ||
                    systemProxyStatus?.managedSnapshot !== true
                  }
                >
                  Restore
                </button>
              </div>
              <pre className="result-box compact">{systemProxyResult}</pre>
            </section>

            <section className="management-card core-section">
              <div className="section-title-row">
                <h3>Core process</h3>
                <button type="button" onClick={() => void refreshCoreStatus()}>
                  Status
                </button>
              </div>
              <div className="core-actions">
                <button
                  type="button"
                  onClick={() => void startCore()}
                  disabled={isCoreBusy || coreStatus?.running === true}
                >
                  Start core
                </button>
                <button
                  type="button"
                  onClick={() => void stopCore()}
                  disabled={isCoreBusy || coreStatus?.running !== true}
                >
                  Stop core
                </button>
              </div>
              <pre className="result-box compact">{coreResult}</pre>
            </section>

            <section className="management-card history-section">
              <h3>Recent runs</h3>
              <pre className="result-box compact">{diagnosticResult}</pre>
              {history.length === 0 ? (
                <p>No runs yet</p>
              ) : (
                <ol>
                  {history.slice(0, 5).map((item) => (
                    <li key={item.id}>
                      <strong>{item.ok ? "Applied" : "Failed"}</strong>
                      <span>{item.profileId}</span>
                      <span>{item.stage}</span>
                      {!item.ok && item.failureBundlePath ? (
                        <button
                          type="button"
                          onClick={() => void exportFailureReport(item.id)}
                          disabled={exportingHistoryId !== null}
                        >
                          {exportingHistoryId === item.id ? "Exporting" : "Export report"}
                        </button>
                      ) : null}
                      <time>{new Date(item.createdAt).toLocaleString()}</time>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="management-card logs-section" id="core-logs">
              <div className="section-title-row">
                <h3>Core logs</h3>
                <div className="inline-actions">
                  <button type="button" onClick={() => void refreshControllerLogStatus()}>
                    Status
                  </button>
                  <button type="button" onClick={() => void refreshLogs()}>
                    Refresh
                  </button>
                </div>
              </div>
              <div className="core-actions">
                <button
                  type="button"
                  onClick={() => void startControllerLogs()}
                  disabled={isControllerLogBusy || controllerLogStatus?.running === true}
                >
                  Start controller logs
                </button>
                <button
                  type="button"
                  onClick={() => void stopControllerLogs()}
                  disabled={isControllerLogBusy || controllerLogStatus?.running !== true}
                >
                  Stop controller logs
                </button>
              </div>
              <pre className="result-box compact">{controllerLogResult}</pre>
              {logs.length === 0 ? (
                <p>No logs yet</p>
              ) : (
                <ol>
                  {logs.slice(-20).map((item, index) => (
                    <li key={`${item.time}-${index}`} data-level={item.level}>
                      <span>{item.level}</span>
                      <span>{item.source}</span>
                      <time>{new Date(item.time).toLocaleTimeString()}</time>
                      <p>{item.message}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        </details>
      </form>
    </AppShell>
  );
}

function AppShell({
  children,
  onNavigate
}: {
  children: ReactNode;
  onNavigate: (targetId: string, opensManagement?: boolean) => void;
}) {
  return (
    <main className="app-shell">
      <Sidebar onNavigate={onNavigate} />
      <section className="content">{children}</section>
    </main>
  );
}

function Sidebar({
  onNavigate
}: {
  onNavigate: (targetId: string, opensManagement?: boolean) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <img src={brandMarkUrl} alt="" className="brand-mark" />
        <div>
          <h1>MioProxy</h1>
          <p>Windows-first Mihomo Controller</p>
        </div>
      </div>
      <nav className="sidebar-nav" aria-label="Primary">
        {navigationItems.map((item) => (
          <button
            key={item.label}
            type="button"
            className={item.label === "Dashboard" ? "active" : ""}
            aria-current={item.label === "Dashboard" ? "page" : undefined}
            onClick={() => onNavigate(item.targetId, item.opensManagement)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span>MVP channel</span>
        <strong>Local runtime</strong>
      </div>
    </aside>
  );
}

function StatusCard({
  title,
  value,
  detail,
  tone = "neutral"
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <article className={`status-card tone-${tone}`}>
      <div className="status-card-topline">
        <span>{title}</span>
        <i aria-hidden="true" />
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function ActivityList({
  items
}: {
  items: Array<{
    title: string;
    detail: string;
    tone: "neutral" | "success" | "warning";
  }>;
}) {
  return (
    <section className="dashboard-card activity-card">
      <div className="card-heading">
        <div>
          <h3>Recent Activity</h3>
          <p>Latest configuration pipeline events.</p>
        </div>
      </div>
      <ol className="activity-list">
        {items.map((item) => (
          <li key={`${item.title}-${item.detail}`} className={`tone-${item.tone}`}>
            <span aria-hidden="true" />
            <div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PipelineStepper({
  steps
}: {
  steps: Array<{
    label: string;
    detail: string;
  }>;
}) {
  return (
    <section className="dashboard-card pipeline-stepper-card">
      <div className="card-heading">
        <div>
          <h3>Pipeline</h3>
          <p>Compact render, validate, promote, and apply flow.</p>
        </div>
      </div>
      <ol className="pipeline-stepper">
        {steps.map((step, index) => (
          <li key={step.label}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.label}</strong>
            <p>{step.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ProfileSummaryCard({
  profileId,
  controllerBaseUrl,
  lastUpdated,
  configStatus,
  onUpdate,
  updateDisabled,
  updateLabel,
  onValidate,
  validateDisabled,
  onReload,
  reloadDisabled
}: {
  profileId: string;
  controllerBaseUrl: string;
  lastUpdated: string;
  configStatus: string;
  onUpdate: () => void;
  updateDisabled: boolean;
  updateLabel: string;
  onValidate: () => void;
  validateDisabled: boolean;
  onReload: () => void;
  reloadDisabled: boolean;
}) {
  return (
    <section className="dashboard-card profile-summary-card">
      <div className="card-heading">
        <div>
          <h3>Active Profile</h3>
          <p>{controllerBaseUrl || "Controller URL not configured"}</p>
        </div>
        <span className="card-badge">Current</span>
      </div>
      <div className="profile-summary-body">
        <div>
          <span>Profile</span>
          <strong>{profileId || "default"}</strong>
        </div>
        <div>
          <span>Last update</span>
          <strong>{lastUpdated}</strong>
        </div>
        <div>
          <span>Configuration check</span>
          <strong>{configStatus}</strong>
        </div>
      </div>
      <div className="profile-actions">
        <button type="button" onClick={onUpdate} disabled={updateDisabled}>
          {updateLabel}
        </button>
        <button type="button" onClick={onValidate} disabled={validateDisabled}>
          Validate & Promote
        </button>
        <button type="button" onClick={onReload} disabled={reloadDisabled}>
          Run Pipeline
        </button>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);

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
    const rule = item.rule ? `${item.rule}${item.rulePayload ? `:${item.rulePayload}` : ""}` : "no rule";
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
