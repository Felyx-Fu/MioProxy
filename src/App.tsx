import { useCallback, useEffect, useState } from "react";
import { mihomoApi, type CoreStatus, type MihomoVersion, type Profile, type ProxiesResponse, type StartupSettings, type SystemProxyStatus } from "./api/mihomo";
import { Sidebar, type Page } from "./components/Sidebar";
import { HomePage } from "./pages/HomePage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { ProxiesPage } from "./pages/ProxiesPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [version, setVersion] = useState<MihomoVersion | null>(null);
  const [proxies, setProxies] = useState<ProxiesResponse | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [proxyStatus, setProxyStatus] = useState<SystemProxyStatus | null>(null);
  const [startup, setStartup] = useState<StartupSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [profileBusyId, setProfileBusyId] = useState<string | null>(null);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyBusy, setProxyBusy] = useState<string | null>(null);
  const [delayByProxy, setDelayByProxy] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await mihomoApi.status();
      setStatus(next);
      if (next.running) {
        setVersion(await mihomoApi.version());
      } else {
        setVersion(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshProxies = useCallback(async () => {
    setProxyLoading(true);
    try {
      setProxies(await mihomoApi.proxies());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setProxyLoading(false);
    }
  }, []);

  const refreshSystemProxy = useCallback(async () => {
    try {
      setProxyStatus(await mihomoApi.systemProxyStatus());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshStartup = useCallback(async () => {
    try {
      setStartup(await mihomoApi.startupStatus());
    } catch (e) {
      setError(String(e));
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
    void mihomoApi.profileList().then(setProfiles).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (page === "proxies" && status?.running) void refreshProxies();
  }, [page, status?.running, refreshProxies]);

  async function toggleCore() {
    setBusy(true);
    setError(null);
    try {
      const next = status?.running ? await mihomoApi.stop() : await mihomoApi.start();
      setStatus(next);
      await new Promise((resolve) => setTimeout(resolve, 450));
      await refreshStatus();
      await refreshSystemProxy();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addProfile(name: string, url: string) {
    setError(null);
    try {
      const profile = await mihomoApi.profileAdd(name, url);
      setProfiles((current) => [...current, profile]);
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }

  async function downloadProfile(id: string) {
    setProfileBusyId(id);
    setError(null);
    try {
      const profile = await mihomoApi.profileDownload(id);
      setProfiles((current) => current.map((item) => item.id === id ? profile : item));
    } catch (e) {
      setError(String(e));
    } finally {
      setProfileBusyId(null);
    }
  }

  async function applyProfile(id: string) {
    setProfileBusyId(id);
    setError(null);
    try {
      await mihomoApi.profileApply(id);
      if (status?.running) await mihomoApi.reload();
      await refreshStatus();
    } catch (e) {
      setError(String(e));
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
    } catch (e) {
      setError(String(e));
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
    } catch (e) {
      setError(String(e));
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
      setError(String(e));
    } finally {
      setProxyBusy(null);
    }
  }

  async function toggleSystemProxy() {
    if (!proxyStatus) return;
    setSettingsBusy(true);
    setError(null);
    try {
      setProxyStatus(await mihomoApi.systemProxySetEnabled(!proxyStatus.enabled));
    } catch (e) {
      setError(String(e));
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
    } catch (e) {
      setError(String(e));
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
    } catch (e) {
      setError(String(e));
    } finally {
      setSettingsBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onChange={setPage} />
      <main className="content">
        {page === "home" && <HomePage status={status} version={version} busy={busy} error={error} onToggle={toggleCore} />}
        {page === "profiles" && <ProfilesPage profiles={profiles} busyId={profileBusyId} error={error} onAdd={addProfile} onDownload={downloadProfile} onApply={applyProfile} onRemove={removeProfile} />}
        {page === "proxies" && <ProxiesPage data={proxies} loading={proxyLoading} busyProxy={proxyBusy} delayByProxy={delayByProxy} onRefresh={refreshProxies} onSelect={selectProxy} onDelay={testProxyDelay} />}
        {page === "settings" && <SettingsPage status={status} proxyStatus={proxyStatus} startup={startup} busy={busy || settingsBusy} onToggleProxy={toggleSystemProxy} onToggleStartup={toggleStartup} onToggleMinimized={toggleStartMinimized} />}
      </main>
    </div>
  );
}
