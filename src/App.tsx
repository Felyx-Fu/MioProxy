import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { mihomoApi, type CoreState, type CoreStatus, type MihomoVersion, type Profile, type ProxiesResponse, type ProxyState, type StartupSettings, type SystemProxyStatus } from "./api/mihomo";
import { Sidebar, type Page } from "./components/Sidebar";
import { ToastHost, type ToastMessage, type ToastTone } from "./components/Feedback";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LogsPage } from "./pages/LogsPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { ProxiesPage } from "./pages/ProxiesPage";
import { RulesPage } from "./pages/RulesPage";
import { DnsPage } from "./pages/DnsPage";
import { OverridesPage } from "./pages/OverridesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useConnections } from "./hooks/useConnections";
import { useTraffic } from "./hooks/useTraffic";

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [coreState, setCoreState] = useState<CoreState>("stopped");
  const [version, setVersion] = useState<MihomoVersion | null>(null);
  const [proxies, setProxies] = useState<ProxiesResponse | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [proxyStatus, setProxyStatus] = useState<SystemProxyStatus | null>(null);
  const [proxyState, setProxyState] = useState<ProxyState>("disabled");
  const [startup, setStartup] = useState<StartupSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [profileBusyId, setProfileBusyId] = useState<string | null>(null);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyBusy, setProxyBusy] = useState<string | null>(null);
  const [delayByProxy, setDelayByProxy] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastId = useRef(0);
  const traffic = useTraffic();
  const connections = useConnections(Boolean(status?.running));

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

  const refreshStatus = useCallback(async () => {
    try {
      const next = await mihomoApi.status();
      setStatus(next);
      setCoreState((current) => current === "error" && !next.running ? "error" : next.running ? "running" : "stopped");
      if (next.running) {
        setVersion(await mihomoApi.version());
      } else {
        setVersion(null);
      }
    } catch (e) {
      const message = errorMessage(e);
      setCoreState("error");
      setError(message);
    }
  }, []);

  const refreshProxies = useCallback(async () => {
    setProxyLoading(true);
    try {
      setProxies(await mihomoApi.proxies());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProxyLoading(false);
    }
  }, []);

  const refreshSystemProxy = useCallback(async () => {
    try {
      const next = await mihomoApi.systemProxyStatus();
      setProxyStatus(next);
      setProxyState((current) => current === "error" && !next.enabled ? "error" : next.enabled ? "enabled" : "disabled");
    } catch (e) {
      setProxyState("error");
      setError(errorMessage(e));
    }
  }, []);

  const refreshStartup = useCallback(async () => {
    try {
      setStartup(await mihomoApi.startupStatus());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshSystemProxy();
    void refreshStartup();
  }, [refreshStatus, refreshStartup, refreshSystemProxy]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshStatus();
      void refreshSystemProxy();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshStatus, refreshSystemProxy]);

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

  useEffect(() => {
    let active = true;
    let unlistenStopped: (() => void) | undefined;
    let unlistenCrashed: (() => void) | undefined;
    void listen("mihomo-stopped", () => {
      if (!active) return;
      setStatus((current) => current ? { ...current, running: false } : current);
      setCoreState((current) => current === "stopping" ? "stopped" : "error");
      setProxyState("disabled");
    }).then((stop) => {
      if (active) unlistenStopped = stop;
      else stop();
    });
    void listen("mihomo-crashed", () => {
      if (!active) return;
      const message = "Mihomo 已异常退出，请检查日志或运行配置。";
      setStatus((current) => current ? { ...current, running: false } : current);
      setCoreState("error");
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
    if (status?.running) void refreshProxies();
    else setProxies(null);
  }, [status?.running, refreshProxies]);

  useEffect(() => {
    if (!status?.running) return;
    const timer = window.setInterval(() => void refreshProxies(), 5000);
    return () => window.clearInterval(timer);
  }, [status?.running, refreshProxies]);

  const currentNode = proxies?.proxies.PROXY?.now ?? null;
  useEffect(() => {
    if (!status?.running || !currentNode) return;
    let active = true;
    void mihomoApi.proxyDelay(currentNode).then((result) => {
      if (active) setDelayByProxy((current) => ({ ...current, [currentNode]: result.delay }));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [currentNode, status?.running]);

  async function toggleCore() {
    if (coreState === "starting" || coreState === "stopping" || coreState === "reloading") return;
    const willRun = !status?.running;
    setCoreState(willRun ? "starting" : "stopping");
    setBusy(true);
    setError(null);
    try {
      const next = status?.running ? await mihomoApi.stop() : await mihomoApi.start();
      setStatus(next);
      await new Promise((resolve) => setTimeout(resolve, 450));
      await refreshStatus();
      await refreshSystemProxy();
      pushToast("success", willRun ? "Mihomo 已启动" : "Mihomo 已停止");
    } catch (e) {
      const message = errorMessage(e);
      setCoreState("error");
      setError(message);
      pushToast("error", message);
    } finally {
      setBusy(false);
    }
  }

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
      const nextProfiles = profiles.filter((item) => item.id !== id);
      setProfiles(nextProfiles);
      setSelectedProfileId((selected) => selected === id ? nextProfiles[0]?.id ?? null : selected);
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
    setProxyBusy(`${group}:${proxy}`);
    setError(null);
    try {
      await mihomoApi.selectProxy(group, proxy);
      await refreshProxies();
      pushToast("success", `已切换到 ${proxy}`);
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", message);
    } finally {
      setProxyBusy(null);
    }
  }

  async function testProxyDelay(proxy: string) {
    setProxyBusy(`delay:${proxy}`);
    setError(null);
    try {
      const result = await mihomoApi.proxyDelay(proxy);
      setDelayByProxy((current) => ({ ...current, [proxy]: result.delay }));
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      pushToast("error", message);
    } finally {
      setProxyBusy(null);
    }
  }

  async function toggleSystemProxy() {
    if (!proxyStatus) return;
    const willEnable = !proxyStatus.enabled;
    setProxyState(willEnable ? "enabling" : "disabling");
    setSettingsBusy(true);
    setError(null);
    try {
      const next = await mihomoApi.systemProxySetEnabled(willEnable);
      setProxyStatus(next);
      setProxyState(next.enabled ? "enabled" : "disabled");
      pushToast("success", next.enabled ? "系统代理已开启" : "系统代理已关闭");
    } catch (e) {
      const message = errorMessage(e);
      setProxyState("error");
      setError(message);
      pushToast("error", `系统代理切换失败：${message}`);
      await refreshSystemProxy();
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

  return (
    <div className="app-shell">
      <Sidebar page={page} onChange={setPage} />
      <main className="content">
        {page === "home" && <DashboardPage status={status} coreState={coreState} version={version} proxyStatus={proxyStatus} proxyState={proxyState} traffic={traffic.snapshot} connectionCount={connections.data?.connections.length ?? 0} currentNode={currentNode} delay={currentNode ? delayByProxy[currentNode] ?? null : null} memory={connections.data?.memory ?? null} busy={busy} error={error} onToggle={toggleCore} onToggleProxy={toggleSystemProxy} />}
        {page === "connections" && <ConnectionsPage state={connections} onRefresh={connections.refresh} onClose={connections.closeConnection} onCloseAll={connections.closeAllConnections} />}
        {page === "logs" && <LogsPage />}
        {page === "profiles" && <ProfilesPage profiles={profiles} selectedId={selectedProfileId} busyId={profileBusyId} error={error} onAdd={addProfile} onDownload={downloadProfile} onApply={applyProfile} onRemove={removeProfile} />}
        {page === "proxies" && <ProxiesPage data={proxies} loading={proxyLoading} busyProxy={proxyBusy} delayByProxy={delayByProxy} profilesLoaded={profilesLoaded} profileCount={profiles.length} onRefresh={refreshProxies} onSelect={selectProxy} onDelay={testProxyDelay} />}
        {page === "rules" && <RulesPage running={Boolean(status?.running)} />}
        {page === "dns" && <DnsPage profileId={selectedProfileId} />}
        {page === "overrides" && <OverridesPage profileId={selectedProfileId} />}
        {page === "settings" && <SettingsPage status={status} coreState={coreState} proxyStatus={proxyStatus} proxyState={proxyState} startup={startup} busy={busy || settingsBusy} onToggleProxy={toggleSystemProxy} onToggleStartup={toggleStartup} onToggleMinimized={toggleStartMinimized} />}
      </main>
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
