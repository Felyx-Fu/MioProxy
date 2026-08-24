import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { mihomoApi, type CoreMode, type CoreState, type CoreStatus, type CoreUpdateStatus, type MihomoVersion, type Profile, type ProxiesResponse, type ProxyDelayContext, type ProxyPathState, type ProxyState, type ServiceConnectionStatus, type StartupSettings, type SystemProxyStatus, type TunStatusSnapshot, type UpdatePreferences, type UpdateStatus } from "./api/mihomo";
import { Sidebar, type Page } from "./components/Sidebar";
import { ToastHost, type ToastMessage, type ToastTone } from "./components/Feedback";
import { PreviewTitleBar } from "./components/PreviewTitleBar";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { RuntimeStatusBar } from "./components/RuntimeStatusBar";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LogsPage } from "./pages/LogsPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { ProxiesPage } from "./pages/ProxiesPage";
import { RulesPage } from "./pages/RulesPage";
import { DnsPage } from "./pages/DnsPage";
import { OverridesPage } from "./pages/OverridesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TunPage } from "./pages/TunPage";
import { useConnections } from "./hooks/useConnections";
import { useTraffic } from "./hooks/useTraffic";
import { useLogs } from "./hooks/useLogs";
import { isNativeRuntime } from "./appearance/AppearanceProvider";
import { currentNodeDelayContext, proxyDelayBusyKey, proxyDelayKey } from "./utils/latency";

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [coreState, setCoreState] = useState<CoreState>("starting");
  const [version, setVersion] = useState<MihomoVersion | null>(null);
  const [proxies, setProxies] = useState<ProxiesResponse | null>(null);
  const [activeProxyGroup, setActiveProxyGroup] = useState("PROXY");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [appliedProfileSession, setAppliedProfileSession] = useState<{ id: string; name: string } | null>(null);
  const [proxyStatus, setProxyStatus] = useState<SystemProxyStatus | null>(null);
  const [proxyState, setProxyState] = useState<ProxyState>("disabled");
  const [proxyPathState, setProxyPathState] = useState<ProxyPathState>("unknown");
  const [startup, setStartup] = useState<StartupSettings | null>(null);
  const [updatePreferences, setUpdatePreferences] = useState<UpdatePreferences | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [profileBusyId, setProfileBusyId] = useState<string | null>(null);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyBusy, setProxyBusy] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [delayByKey, setDelayByKey] = useState<Record<string, number>>({});
  const [delayStatusByKey, setDelayStatusByKey] = useState<Record<string, "available" | "unavailable">>({});
  const [error, setError] = useState<string | null>(null);
  const [coreRecoveryError, setCoreRecoveryError] = useState<string | null>(null);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ currentVersion: "1.0.1", updating: false, checkpoint: null, recoveryError: null });
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [coreUpdate, setCoreUpdate] = useState<CoreUpdateStatus | null>(null);
  const [coreUpdateBusy, setCoreUpdateBusy] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticPath, setDiagnosticPath] = useState<string | null>(null);
  const [serviceConnection, setServiceConnection] = useState<ServiceConnectionStatus | null>(null);
  const [serviceReconnectVisible, setServiceReconnectVisible] = useState(false);
  const [tunSnapshot, setTunSnapshot] = useState<TunStatusSnapshot | null>(null);
  const [tunBusy, setTunBusy] = useState(false);
  const [tunError, setTunError] = useState<string | null>(null);
  const toastId = useRef(0);
  const serviceWasUnavailable = useRef(false);
  const serviceOutageStartedAt = useRef<number | null>(null);
  const serviceNoticeTimer = useRef<number | null>(null);
  const coreCrashPending = useRef(false);
  const tunActionInFlight = useRef(false);
  const tunRefreshInFlight = useRef<Promise<void> | null>(null);
  const proxyRequestInFlight = useRef(false);
  const modeRequestInFlight = useRef(false);
  const systemProxyRequestInFlight = useRef(false);
  const systemProxyRefreshSequence = useRef(0);
  const coreReady = coreState === "ready";
  const traffic = useTraffic();
  const connections = useConnections(coreReady);
  const logs = useLogs();

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((tone: ToastTone, message: string) => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-3), { id, tone, message }]);
  }, []);

  function errorMessage(value: unknown) {
    return value instanceof Error ? value.message : String(value).replace(/^Error:\s*/, "");
  }

  function isServiceIpcFailure(message: string) {
    return /MioProxy Service|IPC|Named Pipe|命名管道|pipe|服务端身份/i.test(message);
  }

  const applySystemProxyStatus = useCallback((next: SystemProxyStatus) => {
    setProxyStatus(next);
    setProxyState(next.enabled ? "enabled" : "disabled");
  }, []);

  const refreshStatus = useCallback(async (): Promise<CoreStatus | null> => {
    try {
      const next = await mihomoApi.status();
      setStatus(next);
      setCoreState(next.state);
      setCoreRecoveryError(next.recoveryMessage ?? null);
      if (next.state === "ready") {
        setVersion(await mihomoApi.version());
      } else {
        setVersion(null);
      }
      return next;
    } catch (e) {
      const message = errorMessage(e);
      if (isServiceIpcFailure(message)) return null;
      setCoreState("error");
      setCoreRecoveryError(message);
      setError(message);
      return null;
    }
  }, []);

  const refreshProxies = useCallback(async () => {
    setProxyLoading(true);
    try {
      setProxies(await mihomoApi.proxies());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProxyLoading(false);
    }
  }, []);

  const refreshSystemProxy = useCallback(async (force = false) => {
    if (systemProxyRequestInFlight.current && !force) return null;
    const sequence = ++systemProxyRefreshSequence.current;
    try {
      const next = await mihomoApi.systemProxyStatus();
      if (sequence === systemProxyRefreshSequence.current && (force || !systemProxyRequestInFlight.current)) {
        applySystemProxyStatus(next);
      }
      return next;
    } catch (e) {
      if (systemProxyRequestInFlight.current && !force) return null;
      if (isServiceIpcFailure(errorMessage(e))) return null;
      setProxyState("error");
      setError(errorMessage(e));
      return null;
    }
  }, [applySystemProxyStatus]);

  const refreshStartup = useCallback(async () => {
    try {
      setStartup(await mihomoApi.startupStatus());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const refreshTun = useCallback((clearError = true) => {
    if (tunActionInFlight.current) return Promise.resolve();
    if (tunRefreshInFlight.current) return tunRefreshInFlight.current;
    const request = (async () => {
      try {
        setTunSnapshot(await mihomoApi.tunStatus());
        if (clearError) setTunError(null);
      } catch (e) {
        const message = errorMessage(e);
        if (!isServiceIpcFailure(message)) setTunError(message);
      } finally {
        tunRefreshInFlight.current = null;
      }
    })();
    tunRefreshInFlight.current = request;
    return request;
  }, []);

  const refreshServiceConnection = useCallback(async () => {
    try {
      const next = await mihomoApi.serviceStatus();
      const recovered = serviceWasUnavailable.current && next.reachable;
      serviceWasUnavailable.current = !next.reachable && Boolean(next.error);
      setServiceConnection(next);
      if (next.reachable || !next.error) {
        serviceOutageStartedAt.current = null;
        if (serviceNoticeTimer.current !== null) window.clearTimeout(serviceNoticeTimer.current);
        serviceNoticeTimer.current = null;
        setServiceReconnectVisible(false);
      } else if (next.versionMismatch) {
        setServiceReconnectVisible(true);
      } else if (serviceOutageStartedAt.current === null) {
        serviceOutageStartedAt.current = Date.now();
        serviceNoticeTimer.current = window.setTimeout(() => {
          if (serviceWasUnavailable.current) setServiceReconnectVisible(true);
        }, 5000);
      }
      if (recovered) {
        void refreshStatus();
        void refreshSystemProxy();
        void refreshProxies();
        void refreshTun();
      }
    } catch {
      serviceWasUnavailable.current = true;
    }
  }, [refreshProxies, refreshStatus, refreshSystemProxy, refreshTun]);

  useEffect(() => {
    void refreshStatus();
    void refreshSystemProxy();
    void refreshTun();
    void refreshStartup();
    void refreshServiceConnection();
    void mihomoApi.updatePreferencesStatus().then(setUpdatePreferences).catch((e) => setUpdateError(errorMessage(e)));
    void mihomoApi.updateStatus().then(setUpdateStatus).catch((e) => setUpdateError(errorMessage(e)));
    void mihomoApi.coreUpdateStatus().then(setCoreUpdate).catch(() => undefined);
  }, [refreshServiceConnection, refreshStatus, refreshStartup, refreshSystemProxy, refreshTun]);

  const downloadUpdate = useCallback(async (update: Update, silent = false) => {
    setUpdateDownloading(true);
    setUpdateProgress(0);
    setUpdateError(null);
    try {
      let contentLength: number | undefined;
      let downloaded = 0;
      const onEvent = (event: DownloadEvent) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength;
          setUpdateProgress(0);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setUpdateProgress(contentLength ? Math.min(100, Math.round(downloaded / contentLength * 100)) : null);
        } else {
          setUpdateProgress(100);
        }
      };
      await update.download(onEvent);
      setUpdateDownloaded(true);
      if (!silent) pushToast("success", "更新包下载完成");
    } catch (e) {
      const message = errorMessage(e);
      setUpdateError(message);
      if (!silent) pushToast("error", `下载更新失败：${message}`);
      throw e;
    } finally {
      setUpdateDownloading(false);
    }
  }, [pushToast]);

  const checkForUpdate = useCallback(async (silent = false, autoDownload = false) => {
    setUpdateChecking(true);
    setUpdateError(null);
    setUpdateDownloaded(false);
    try {
      const metadata = await mihomoApi.updateCheck();
      const next = metadata ? new Update(metadata) : null;
      setAvailableUpdate(next);
      if (!next && !silent) pushToast("success", "当前已是最新版本");
      if (next && !silent) pushToast("success", `发现 MioProxy ${next.version} 更新`);
      if (next && autoDownload) void downloadUpdate(next, true).catch(() => undefined);
    } catch (e) {
      const message = errorMessage(e);
      setUpdateError(message);
      if (!silent) pushToast("error", `检查更新失败：${message}`);
    } finally {
      setUpdateChecking(false);
    }
  }, [downloadUpdate, pushToast]);

  useEffect(() => {
    if (!updatePreferences?.checkOnStartup) return;
    const timer = window.setTimeout(() => void checkForUpdate(true, updatePreferences.autoDownload), 5000);
    return () => window.clearTimeout(timer);
  }, [checkForUpdate, updatePreferences?.autoDownload, updatePreferences?.checkOnStartup]);

  async function installUpdate() {
    if (!availableUpdate || updateInstalling || updateDownloading) return;
    setUpdateInstalling(true);
    setUpdateError(null);
    try {
      if (!updateDownloaded) await downloadUpdate(availableUpdate);
      await mihomoApi.updatePrepare(availableUpdate.version);
      await availableUpdate.install();
      await relaunch();
    } catch (e) {
      const message = errorMessage(e);
      await mihomoApi.updateMarkFailed(message).catch(() => undefined);
      setUpdateError(message);
      pushToast("error", `更新失败：${message}`);
      setUpdateInstalling(false);
    }
  }

  async function checkCoreUpdate() {
    setCoreUpdateBusy(true);
    try {
      setCoreUpdate(await mihomoApi.coreUpdateCheck());
    } catch (e) {
      const message = errorMessage(e);
      setCoreUpdate((current) => current ? { ...current, phase: "error", error: message } : { currentVersion: null, availableVersion: null, assetName: null, phase: "error", error: message });
      pushToast("error", `检查 Mihomo Core 更新失败：${message}`);
    } finally {
      setCoreUpdateBusy(false);
    }
  }

  async function installCoreUpdate() {
    if (coreUpdateBusy) return;
    setCoreUpdateBusy(true);
    try {
      setCoreUpdate(await mihomoApi.coreUpdateInstall());
      await refreshStatus();
      pushToast("success", "Mihomo Core 更新完成");
    } catch (e) {
      const message = errorMessage(e);
      setCoreUpdate((current) => current ? { ...current, phase: "error", error: message } : current);
      pushToast("error", `Mihomo Core 更新失败：${message}`);
    } finally {
      setCoreUpdateBusy(false);
    }
  }

  async function generateDiagnosticBundle() {
    setDiagnosticBusy(true);
    try {
      const path = await mihomoApi.diagnosticBundleGenerate();
      setDiagnosticPath(path);
      pushToast("success", "脱敏诊断包已生成");
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", `生成诊断包失败：${message}`);
    } finally {
      setDiagnosticBusy(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshStatus();
      void refreshSystemProxy();
      void refreshServiceConnection();
      void refreshTun();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshServiceConnection, refreshStatus, refreshSystemProxy, refreshTun]);

  useEffect(() => {
    if (serviceConnection?.reachable || !serviceConnection?.error) return;
    let cancelled = false;
    void (async () => {
      for (const delay of [250, 500, 1000, 2000, 4000]) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
        if (cancelled) return;
        await refreshServiceConnection();
        if (!serviceWasUnavailable.current) return;
      }
    })();
    return () => { cancelled = true; };
  }, [refreshServiceConnection, serviceConnection?.error, serviceConnection?.reachable]);

  useEffect(() => {
    void mihomoApi.profileList().then((next) => {
      setProfiles(next);
      setSelectedProfileId((current) => current ?? next[0]?.id ?? null);
      setProfilesLoaded(true);
    }).catch((e) => {
      setProfilesLoaded(true);
      setError(errorMessage(e));
    });
  }, []);

  useLayoutEffect(() => {
    setSelectedProfileId((current) => current && profiles.some((profile) => profile.id === current)
      ? current
      : profiles[0]?.id ?? null);
  }, [profiles]);

  useEffect(() => {
    let active = true;
    let unlistenStopped: (() => void) | undefined;
    let unlistenCrashed: (() => void) | undefined;
    void listen("mihomo-stopped", () => {
      if (!active) return;
      if (coreCrashPending.current) {
        coreCrashPending.current = false;
        return;
      }
      setStatus((current) => current ? { ...current, state: "stopped", running: false } : current);
      setCoreState("stopped");
      setCoreRecoveryError(null);
      setProxyState("disabled");
    }).then((stop) => {
      if (active) unlistenStopped = stop;
      else stop();
    });
    void listen("mihomo-crashed", () => {
      if (!active) return;
      const message = "Mihomo 已异常退出，请检查日志或运行配置。";
      coreCrashPending.current = true;
      setStatus((current) => current ? { ...current, state: "error", running: false } : current);
      setCoreState("error");
      setCoreRecoveryError(message);
      setProxyState("disabled");
      setError(message);
      pushToast("error", message);
    }).then((stop) => {
      if (active) unlistenCrashed = stop;
      else stop();
    });
    return () => {
      active = false;
      unlistenStopped?.();
      unlistenCrashed?.();
    };
  }, [pushToast]);

  useEffect(() => {
    if (coreReady) void refreshProxies();
    else {
      setProxies(null);
      setProxyPathState("unknown");
    }
  }, [coreReady, refreshProxies]);

  useEffect(() => {
    if (!coreReady) return;
    const timer = window.setInterval(() => void refreshProxies(), 5000);
    return () => window.clearInterval(timer);
  }, [coreReady, refreshProxies]);

  const selectableProxyGroups = Object.entries(proxies?.proxies ?? {}).filter(([, group]) =>
    ["Selector", "URLTest", "Fallback", "LoadBalance"].includes(group.type ?? "") && Boolean(group.now),
  );
  const resolvedProxyGroup = proxies?.proxies[activeProxyGroup]?.now
    ? activeProxyGroup
    : proxies?.proxies.PROXY?.now
      ? "PROXY"
      : selectableProxyGroups[0]?.[0] ?? null;
  const currentNode = resolvedProxyGroup ? proxies?.proxies[resolvedProxyGroup]?.now ?? null : null;
  const currentDelayContext = useMemo<ProxyDelayContext | null>(() => {
    return currentNodeDelayContext(proxies, resolvedProxyGroup, currentNode);
  }, [
    currentNode,
    proxies?.proxies[currentNode ?? ""]?.type,
    proxies?.proxies[currentNode ?? ""]?.["provider-name"],
    proxies?.proxies[currentNode ?? ""]?.providerName,
    proxies?.proxies[resolvedProxyGroup ?? ""]?.testUrl,
    proxies?.proxies[resolvedProxyGroup ?? ""]?.expectedStatus,
    proxies?.proxies[resolvedProxyGroup ?? ""]?.memberContexts?.[currentNode ?? ""]?.kind,
    proxies?.proxies[resolvedProxyGroup ?? ""]?.memberContexts?.[currentNode ?? ""]?.provider,
    proxies?.proxies[resolvedProxyGroup ?? ""]?.memberContexts?.[currentNode ?? ""]?.providerResolution,
    proxies?.proxies[resolvedProxyGroup ?? ""]?.memberContexts?.[currentNode ?? ""]?.providerCandidates?.join("\u001f"),
    resolvedProxyGroup,
  ]);
  const currentDelayKey = currentDelayContext ? proxyDelayKey(currentDelayContext) : null;
  useEffect(() => {
    if (!coreReady || !currentDelayContext || !currentDelayKey) return;
    let active = true;
    setProxyPathState("unknown");
    void mihomoApi.proxyDelay(currentDelayContext).then((result) => {
      if (!active) return;
      setDelayByKey((current) => ({ ...current, [currentDelayKey]: result.delay }));
      setDelayStatusByKey((current) => ({ ...current, [currentDelayKey]: "available" }));
      setProxyPathState("healthy");
    }).catch(() => {
      if (active) {
        setDelayStatusByKey((current) => ({ ...current, [currentDelayKey]: "unavailable" }));
        setProxyPathState("unavailable");
      }
    });
    return () => { active = false; };
  }, [coreReady, currentDelayContext, currentDelayKey]);

  async function addProfile(name: string, url: string) {
    setError(null);
    try {
      const profile = await mihomoApi.profileAdd(name, url);
      setProfiles((current) => [...current, profile]);
      setSelectedProfileId(profile.id);
      pushToast("success", "Profile 已添加");
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }

  async function downloadProfile(id: string) {
    setProfileBusyId(id);
    setError(null);
    try {
      const profile = await mihomoApi.profileDownload(id);
      setProfiles((current) => current.map((item) => item.id === id ? profile : item));
      pushToast("success", "Profile 更新成功");
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", message);
    } finally {
      setProfileBusyId(null);
    }
  }

  async function applyProfile(id: string) {
    setProfileBusyId(id);
    setError(null);
    try {
      await mihomoApi.profileApply(id);
      setSelectedProfileId(id);
      const applied = profiles.find((profile) => profile.id === id);
      if (applied) setAppliedProfileSession({ id: applied.id, name: applied.name });
      await refreshStatus();
      pushToast("success", "Profile 已通过 Mihomo 校验并加载");
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", message);
    } finally {
      setProfileBusyId(null);
    }
  }

  async function removeProfile(id: string) {
    setProfileBusyId(id);
    setError(null);
    try {
      await mihomoApi.profileRemove(id);
      setProfiles((current) => current.filter((item) => item.id !== id));
      pushToast("success", "Profile 已删除");
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", message);
    } finally {
      setProfileBusyId(null);
    }
  }

  async function selectProxy(group: string, proxy: string) {
    if (proxyRequestInFlight.current) return;
    proxyRequestInFlight.current = true;
    setProxyBusy(`${group}:${proxy}`);
    setError(null);
    try {
      await mihomoApi.selectProxy(group, proxy);
      setActiveProxyGroup(group);
      await refreshProxies();
      setProxyPathState("unknown");
      pushToast("success", `已切换到 ${proxy}`);
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", message);
    } finally {
      proxyRequestInFlight.current = false;
      setProxyBusy(null);
    }
  }

  async function testProxyDelay(context: ProxyDelayContext) {
    if (proxyRequestInFlight.current) return;
    proxyRequestInFlight.current = true;
    const delayKey = proxyDelayKey(context);
    setProxyBusy(proxyDelayBusyKey(context));
    setError(null);
    try {
      const result = await mihomoApi.proxyDelay(context);
      setDelayByKey((current) => ({ ...current, [delayKey]: result.delay }));
      setDelayStatusByKey((current) => ({ ...current, [delayKey]: "available" }));
      if (context.proxy === currentNode && context.group === resolvedProxyGroup) setProxyPathState("healthy");
    } catch (e) {
      setDelayStatusByKey((current) => ({ ...current, [delayKey]: "unavailable" }));
      if (context.proxy === currentNode && context.group === resolvedProxyGroup) setProxyPathState("unavailable");
    } finally {
      proxyRequestInFlight.current = false;
      setProxyBusy(null);
    }
  }

  async function setSystemProxyEnabled(enabled: boolean) {
    setProxyState(enabled ? "enabling" : "disabling");
    setSettingsBusy(true);
    setError(null);
    let commandSucceeded = false;
    try {
      await mihomoApi.systemProxySetEnabled(enabled);
      commandSucceeded = true;
      const observed = await refreshSystemProxy(true);
      if (!observed) {
        throw new Error("系统代理切换后无法刷新权威状态，暂时无法确认结果");
      }
      if (observed.enabled !== enabled) {
        const observedLabel = observed.enabled ? "已开启" : "已关闭";
        const expectedLabel = enabled ? "已开启" : "已关闭";
        const message = `系统代理命令已返回成功，但权威状态仍为${observedLabel}（预期${expectedLabel}）`;
        setError(message);
        pushToast("error", message);
        return;
      }
      pushToast("success", enabled ? "系统代理已开启" : "系统代理已关闭");
    } catch (e) {
      const message = errorMessage(e);
      setProxyState("error");
      setError(message);
      pushToast("error", `系统代理切换失败：${message}`);
      if (!commandSucceeded) await refreshSystemProxy(true);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function toggleStartup(enabled: boolean) {
    if (!startup) return;
    setSettingsBusy(true);
    setError(null);
    try {
      setStartup(await mihomoApi.startupSet(enabled, startup.startMinimized));
      pushToast("success", enabled ? "已开启开机启动" : "已关闭开机启动");
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", message);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function toggleStartMinimized(startMinimized: boolean) {
    if (!startup) return;
    setSettingsBusy(true);
    setError(null);
    try {
      setStartup(await mihomoApi.startupSet(startup.enabled, startMinimized));
      pushToast("success", startMinimized ? "已开启启动时最小化" : "已关闭启动时最小化");
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", message);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function requestSystemProxyTransition() {
    if (settingsBusy || systemProxyRequestInFlight.current) return;
    systemProxyRequestInFlight.current = true;
    systemProxyRefreshSequence.current += 1;
    setSettingsBusy(true);
    try {
      const current = await mihomoApi.systemProxyStatus();
      applySystemProxyStatus(current);
      if (current.owner === "external" || current.actualState === "externalEndpoint" || current.externalDetected) {
        pushToast("info", "检测到外部系统代理；MioProxy 未接管，也不会从此控件覆盖它。");
        return;
      }
      await setSystemProxyEnabled(!current.enabled);
    } catch (e) {
      const message = errorMessage(e);
      setProxyState("error");
      setError(message);
      pushToast("error", `读取系统代理状态失败：${message}`);
    } finally {
      systemProxyRequestInFlight.current = false;
      setSettingsBusy(false);
    }
  }

  async function setCoreMode(mode: CoreMode) {
    if (modeBusy || modeRequestInFlight.current || status?.mode === mode) return;
    modeRequestInFlight.current = true;
    setModeBusy(true);
    setError(null);
    try {
      await mihomoApi.setMode(mode);
      const observed = await refreshStatus();
      if (!observed || observed.mode !== mode) {
        throw new Error(`Mihomo 模式切换后无法确认权威状态（预期 ${mode}）`);
      }
      pushToast("success", `Mihomo 模式已切换为 ${mode}`);
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", message);
    } finally {
      modeRequestInFlight.current = false;
      setModeBusy(false);
    }
  }

  async function requestTunTransition() {
    if (tunActionInFlight.current || tunBusy) return;
    tunActionInFlight.current = true;
    setTunBusy(true);
    setTunError(null);
    let failed = false;
    try {
      const pendingRefresh = tunRefreshInFlight.current;
      if (pendingRefresh) await pendingRefresh;
      const current = await mihomoApi.tunStatus();
      setTunSnapshot(current);
      if (current.owner === "external" || current.actualState === "externalTun" || current.externalDetected) {
        pushToast("info", "检测到外部 TUN；MioProxy 未接管，也不会从此控件覆盖它。");
        return;
      }
      const currentlyOwned = current.owner === "mioproxy" && current.actualState === "mioproxyTun";
      const enabled = !(currentlyOwned || current.desiredEnabled);
      const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
      if (enabled && (!selectedProfile || !selectedProfile.filePath)) {
        setTunError("请先选择并下载一个 Profile，再启用 TUN。");
        return;
      }
      setTunSnapshot({
        ...current,
        status: enabled ? "starting" : "stopping",
        projection: enabled ? "enabling" : "disabling",
        message: null,
        desiredEnabled: enabled,
      });
      const next = await mihomoApi.tunSetEnabled(enabled, enabled ? selectedProfile!.id : current.profileId);
      setTunSnapshot(next);
      if (next.projection === "recovering" || next.projection === "waitingForService") {
        pushToast("info", "Service 正在恢复；已保留 TUN 目标状态，未重复执行未确认的操作。");
      } else if (next.projection === "external") {
        pushToast("info", "检测到外部 TUN；MioProxy 未接管，也不会覆盖它。");
      } else {
        pushToast("success", next.projection === "on" ? "TUN 已开启" : "TUN 已关闭并完成恢复");
      }
    } catch (e) {
      failed = true;
      const message = errorMessage(e);
      setTunError(message);
      pushToast("error", `TUN 切换失败：${message}`);
    } finally {
      tunActionInFlight.current = false;
      setTunBusy(false);
    }
    if (failed) await refreshTun(false);
  }

  async function toggleUpdatePreference(field: keyof UpdatePreferences, enabled: boolean) {
    if (!updatePreferences) return;
    setSettingsBusy(true);
    setError(null);
    try {
      const next = await mihomoApi.updatePreferencesSet(
        field === "checkOnStartup" ? enabled : updatePreferences.checkOnStartup,
        field === "autoDownload" ? enabled : updatePreferences.autoDownload,
      );
      setUpdatePreferences(next);
      pushToast("success", field === "checkOnStartup" ? (enabled ? "已开启启动时检查更新" : "已关闭启动时检查更新") : (enabled ? "已开启自动下载更新" : "已关闭自动下载更新"));
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", `更新设置保存失败：${message}`);
    } finally {
      setSettingsBusy(false);
    }
  }

  useEffect(() => {
    const pages: Page[] = ["home", "proxies", "profiles", "connections", "rules", "logs"];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey) {
        if (/^[1-6]$/.test(event.key)) {
          event.preventDefault();
          setPage(pages[Number(event.key) - 1]);
          return;
        }
        if (event.key === ",") {
          event.preventDefault();
          setPage("settings");
          return;
        }
        if (event.key.toLowerCase() === "f") {
          const search = document.querySelector<HTMLInputElement>("[data-page-search]");
          if (search) {
            event.preventDefault();
            search.focus();
            search.select();
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const connectionCount = connections.data ? connections.data.connections.length : null;

  function handleApplicationContextMenu(event: MouseEvent<HTMLDivElement>) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (
      target?.closest(
        ".window-titlebar, input, textarea, [contenteditable=\"true\"]",
      )
    ) {
      return;
    }
    event.preventDefault();
  }

  return (
    <div className="app-frame" data-context-menu-policy="block-browser" onContextMenu={handleApplicationContextMenu}>
      {isNativeRuntime() ? <WindowTitleBar /> : <PreviewTitleBar />}
      <div className="app-shell">
        <Sidebar page={page} onChange={setPage} />
        <main className="content" id="main-content">
          {page === "home" && <DashboardPage status={status} coreState={coreState} version={version} proxyStatus={proxyStatus} proxyState={proxyState} tunStatus={tunSnapshot} tunBusy={tunBusy} traffic={traffic.snapshot} connectionCount={connectionCount} currentNode={currentNode} delay={currentDelayKey ? delayByKey[currentDelayKey] ?? null : null} proxyPathState={proxyPathState} memory={connections.data?.memory ?? null} selectedProfile={selectedProfile} appliedProfileName={appliedProfileSession?.name ?? null} error={coreRecoveryError ?? error} tunError={tunError} onRequestProxyTransition={() => void requestSystemProxyTransition()} onRequestTunTransition={() => void requestTunTransition()} onNavigate={setPage} />}
          {page === "connections" && <ConnectionsPage state={connections} onRefresh={connections.refresh} onClose={connections.closeConnection} onCloseAll={connections.closeAllConnections} />}
          {page === "logs" && <LogsPage state={logs} />}
          {page === "profiles" && <ProfilesPage profiles={profiles} selectedId={selectedProfileId} appliedId={appliedProfileSession?.id ?? null} busyId={profileBusyId} error={error} onSelect={setSelectedProfileId} onAdd={addProfile} onDownload={downloadProfile} onApply={applyProfile} onRemove={removeProfile} onNavigate={setPage} />}
          {page === "proxies" && <ProxiesPage data={proxies} mode={status?.mode ?? null} modeBusy={modeBusy} loading={proxyLoading} busyProxy={proxyBusy} delayByKey={delayByKey} delayStatusByKey={delayStatusByKey} profilesLoaded={profilesLoaded} profileCount={profiles.length} onRefresh={refreshProxies} onModeChange={setCoreMode} onSelect={selectProxy} onDelay={testProxyDelay} />}
          {page === "rules" && <RulesPage running={coreReady} />}
          {page === "dns" && <DnsPage profileId={selectedProfileId} />}
          {page === "overrides" && <OverridesPage profileId={selectedProfileId} />}
          {page === "tun" && <TunPage profileId={selectedProfileId} coreRunning={coreReady} systemProxyEnabled={Boolean(proxyStatus?.enabled)} snapshot={tunSnapshot} loading={tunBusy} error={tunError} onRequestTransition={() => void requestTunTransition()} onNavigate={setPage} />}
          {page === "settings" && <SettingsPage status={status} coreState={coreState} proxyStatus={proxyStatus} proxyState={proxyState} tunStatus={tunSnapshot} tunBusy={tunBusy} serviceConnection={serviceConnection} startup={startup} updatePreferences={updatePreferences} busy={settingsBusy} onRequestProxyTransition={() => void requestSystemProxyTransition()} onRequestTunTransition={() => void requestTunTransition()} onToggleStartup={toggleStartup} onToggleMinimized={toggleStartMinimized} onToggleUpdatePreference={toggleUpdatePreference} appUpdate={{ ...updateStatus, checking: updateChecking, downloading: updateDownloading, installing: updateInstalling, downloaded: updateDownloaded, progress: updateProgress, availableVersion: availableUpdate?.version ?? null, releaseNotes: availableUpdate?.body ?? null, error: updateError }} onCheckForUpdate={() => void checkForUpdate()} onInstallUpdate={() => void installUpdate()} coreUpdate={coreUpdate} coreUpdateBusy={coreUpdateBusy} onCheckCoreUpdate={() => void checkCoreUpdate()} onInstallCoreUpdate={() => void installCoreUpdate()} diagnosticBusy={diagnosticBusy} diagnosticPath={diagnosticPath} onGenerateDiagnosticBundle={() => void generateDiagnosticBundle()} onNavigate={setPage} />}
        </main>
        <RuntimeStatusBar status={status} coreState={coreState} selectedProfileName={selectedProfile?.name ?? null} appliedProfileName={appliedProfileSession?.name ?? null} currentNode={currentNode} traffic={traffic.snapshot} connectionCount={connectionCount} proxyStatus={proxyStatus} proxyState={proxyState} tunStatus={tunSnapshot} onNavigate={setPage} />
      </div>
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
