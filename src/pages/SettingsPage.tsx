import { Download, FileDown, FolderCog, Info, LockKeyhole, Monitor, Network, Power, Rocket, Route, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { ReactNode, useEffect, useMemo, useState } from "react";
import type { CoreState, CoreStatus, CoreUpdateStatus, ProxyState, ServiceConnectionStatus, StartupSettings, SystemProxyStatus, TunStatusSnapshot, UpdatePreferences, UpdateStatus } from "../api/mihomo";
import type { Page } from "../components/Sidebar";

type AppUpdateState = UpdateStatus & {
  checking: boolean;
  installing: boolean;
  downloading: boolean;
  downloaded: boolean;
  progress: number | null;
  availableVersion: string | null;
  releaseNotes: string | null;
  error: string | null;
};

type Category = "general" | "network" | "core" | "appearance" | "updates" | "advanced" | "about";
const CATEGORIES: Array<{ id: Category; label: string }> = [
  { id: "general", label: "General" },
  { id: "network", label: "Network" },
  { id: "core", label: "Core" },
  { id: "appearance", label: "Appearance" },
  { id: "updates", label: "Updates" },
  { id: "advanced", label: "Advanced" },
  { id: "about", label: "About" },
];

type SettingsPageProps = {
  status: CoreStatus | null;
  coreState: CoreState;
  proxyStatus: SystemProxyStatus | null;
  proxyState: ProxyState;
  tunStatus: TunStatusSnapshot | null;
  tunBusy: boolean;
  serviceConnection: ServiceConnectionStatus | null;
  startup: StartupSettings | null;
  updatePreferences: UpdatePreferences | null;
  busy: boolean;
  onRequestProxyTransition: () => void;
  onRequestTunTransition: () => void;
  onToggleStartup: (enabled: boolean) => void;
  onToggleMinimized: (enabled: boolean) => void;
  onToggleUpdatePreference: (field: keyof UpdatePreferences, enabled: boolean) => void;
  appUpdate: AppUpdateState;
  onCheckForUpdate: () => void;
  onInstallUpdate: () => void;
  coreUpdate: CoreUpdateStatus | null;
  coreUpdateBusy: boolean;
  onCheckCoreUpdate: () => void;
  onInstallCoreUpdate: () => void;
  diagnosticBusy: boolean;
  diagnosticPath: string | null;
  onGenerateDiagnosticBundle: () => void;
  onNavigate: (page: Page) => void;
};

function SettingRow({ icon, title, description, value, control }: { icon: ReactNode; title: string; description: string; value?: string; control?: ReactNode }) {
  return (
    <article className="setting-row">
      <span className="setting-icon">{icon}</span>
      <div className="setting-copy"><strong>{title}</strong><span>{description}</span>{value && <small>{value}</small>}</div>
      {control && <div className="setting-control">{control}</div>}
    </article>
  );
}

export function SettingsPage(props: SettingsPageProps) {
  const {
    status, coreState, proxyStatus, proxyState, tunStatus, tunBusy, serviceConnection, startup, updatePreferences, busy,
    onRequestProxyTransition, onRequestTunTransition, onToggleStartup, onToggleMinimized, onToggleUpdatePreference,
    appUpdate, onCheckForUpdate, onInstallUpdate, coreUpdate, coreUpdateBusy, onCheckCoreUpdate, onInstallCoreUpdate,
    diagnosticBusy, diagnosticPath, onGenerateDiagnosticBundle, onNavigate,
  } = props;
  const [category, setCategory] = useState<Category>("general");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const saved = window.sessionStorage.getItem("mioproxy.preview.theme");
    return saved === "dark" || saved === "system" ? saved : "light";
  });
  const searching = Boolean(query.trim());
  const proxyExternal = Boolean(proxyStatus?.owner === "external" || proxyStatus?.actualState === "externalEndpoint" || proxyStatus?.externalDetected);
  const tunExternal = Boolean(tunStatus?.owner === "external" || tunStatus?.actualState === "externalTun" || tunStatus?.externalDetected);
  const tunOwned = Boolean(tunStatus?.owner === "mioproxy" && tunStatus?.actualState === "mioproxyTun");
  const tunWillDisable = !tunExternal && Boolean(tunOwned || tunStatus?.desiredEnabled);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    window.sessionStorage.setItem("mioproxy.preview.theme", theme);
  }, [theme]);

  const content: Record<Category, Array<{ search: string; node: ReactNode }>> = useMemo(() => ({
    general: [
      { search: "start windows launch startup 开机启动", node: <SettingRow key="startup" icon={<Rocket size={16} />} title="Start with Windows" description="Launch MioProxy automatically for the current Windows user." value={startup ? startup.enabled ? "Enabled" : "Disabled" : "Checking"} control={<button className="setting-toggle" type="button" onClick={() => onToggleStartup(!(startup?.enabled ?? false))} disabled={busy || !startup}>{startup?.enabled ? "Turn off" : "Turn on"}</button>} /> },
      { search: "minimize tray startup 最小化 托盘", node: <SettingRow key="minimized" icon={<Monitor size={16} />} title="Minimize to system tray" description="Keep MioProxy available in the notification area after launch." value={startup ? startup.startMinimized ? "Enabled" : "Disabled" : "Checking"} control={<button className="setting-toggle" type="button" onClick={() => onToggleMinimized(!(startup?.startMinimized ?? false))} disabled={busy || !startup?.enabled}>{startup?.startMinimized ? "Turn off" : "Turn on"}</button>} /> },
    ],
    network: [
      { search: "system proxy windows network 系统代理", node: <SettingRow key="proxy" icon={<Power size={16} />} title="System Proxy" description={proxyExternal ? "An external proxy owns the current Windows setting; MioProxy will not take it over here." : "MioProxy restores the original Windows setting when it releases ownership."} value={!proxyStatus ? "Checking" : proxyExternal ? "External owner" : proxyStatus.enabled ? `On · 127.0.0.1:${proxyStatus.mixedPort}` : "Off"} control={<button className="setting-toggle" type="button" onClick={onRequestProxyTransition} disabled={coreState !== "ready" || busy || proxyExternal}>{proxyState === "enabling" || proxyState === "disabling" ? "Working…" : proxyExternal ? "External" : proxyStatus?.enabled ? "Turn off" : "Turn on"}</button>} /> },
      { search: "tun transparent route network 透明代理", node: <SettingRow key="tun" icon={<Route size={16} />} title="TUN" description={tunExternal ? "An external TUN is active; MioProxy leaves it untouched." : "Route traffic through the MioProxy-managed Mihomo TUN."} value={!tunStatus ? "Checking" : tunExternal ? "External owner" : tunStatus.status === "running" ? "On" : tunStatus.status === "error" ? "Error" : tunStatus.status === "starting" || tunStatus.status === "stopping" ? "Transitioning" : tunStatus.desiredEnabled ? "Recovery pending" : "Off"} control={<button className="setting-toggle" type="button" onClick={onRequestTunTransition} disabled={tunBusy || tunExternal || (!tunWillDisable && coreState !== "ready")}>{tunBusy ? "Working…" : tunExternal ? "External" : tunWillDisable ? "Turn off" : "Turn on"}</button>} /> },
      { search: "dns nameserver network", node: <SettingRow key="dns" icon={<Network size={16} />} title="DNS" description="Edit DNS values used when building the selected Profile preview." control={<button className="setting-toggle" type="button" onClick={() => onNavigate("dns")}>Open DNS</button>} /> },
    ],
    core: [
      { search: "core mihomo state controller", node: <SettingRow key="core-state" icon={<ShieldCheck size={16} />} title="Mihomo Core" description="Core is Ready only after authenticated Controller health checks succeed." value={!status ? "Checking" : `${coreState}${status.mode ? ` · ${status.mode}` : ""}`} /> },
      { search: "config path runtime yaml", node: <SettingRow key="config" icon={<FolderCog size={16} />} title="Runtime configuration" description="Generated configuration path managed by MioProxy." value={status?.configPath ?? "—"} /> },
      { search: "controller localhost port 19090", node: <SettingRow key="controller" icon={<LockKeyhole size={16} />} title="Controller" description="Local authenticated Controller endpoint." value={status?.controller ?? "—"} /> },
    ],
    appearance: [
      { search: "theme light dark system appearance 主题", node: <SettingRow key="theme" icon={<Monitor size={16} />} title="Theme" description="Choose the interface appearance for this application session." control={<select value={theme} onChange={(event) => setTheme(event.target.value as typeof theme)} aria-label="Theme"><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select>} /> },
    ],
    updates: [
      { search: "application app update version 更新", node: <SettingRow key="app-update" icon={<Download size={16} />} title="Application update" description={appUpdate.error ?? appUpdate.releaseNotes ?? "Updates use signed MioProxy release metadata."} value={appUpdate.availableVersion ? `MioProxy ${appUpdate.availableVersion} available` : `Current ${appUpdate.currentVersion}`} control={<button className="setting-toggle" type="button" onClick={appUpdate.availableVersion ? onInstallUpdate : onCheckForUpdate} disabled={busy || appUpdate.checking || appUpdate.downloading || appUpdate.installing}>{appUpdate.downloading ? `${appUpdate.progress ?? 0}%` : appUpdate.installing ? "Installing…" : appUpdate.checking ? "Checking…" : appUpdate.availableVersion ? "Install" : "Check"}</button>} /> },
      { search: "startup check updates 自动检查", node: <SettingRow key="check-startup" icon={<Download size={16} />} title="Check on startup" description="Check for application updates after startup without blocking the window." value={updatePreferences ? updatePreferences.checkOnStartup ? "Enabled" : "Disabled" : "Checking"} control={<button className="setting-toggle" type="button" onClick={() => onToggleUpdatePreference("checkOnStartup", !(updatePreferences?.checkOnStartup ?? false))} disabled={busy || !updatePreferences}>{updatePreferences?.checkOnStartup ? "Turn off" : "Turn on"}</button>} /> },
      { search: "auto download updates 自动下载", node: <SettingRow key="auto-download" icon={<Download size={16} />} title="Download automatically" description="Download and verify application updates without installing them." value={updatePreferences ? updatePreferences.autoDownload ? "Enabled" : "Disabled" : "Checking"} control={<button className="setting-toggle" type="button" onClick={() => onToggleUpdatePreference("autoDownload", !(updatePreferences?.autoDownload ?? false))} disabled={busy || !updatePreferences}>{updatePreferences?.autoDownload ? "Turn off" : "Turn on"}</button>} /> },
      { search: "mihomo core update version", node: <SettingRow key="core-update" icon={<ShieldCheck size={16} />} title="Mihomo Core update" description={coreUpdate?.error ?? (coreUpdate?.phase === "completed" ? "Core passed its post-update health check." : "Official release with rollback on failure.")} value={coreUpdate?.availableVersion ? `Mihomo ${coreUpdate.availableVersion} available` : coreUpdate?.currentVersion ? `Current ${coreUpdate.currentVersion}` : "Waiting for version"} control={<button className="setting-toggle" type="button" onClick={coreUpdate?.availableVersion ? onInstallCoreUpdate : onCheckCoreUpdate} disabled={busy || coreUpdateBusy}>{coreUpdateBusy ? "Working…" : coreUpdate?.availableVersion ? "Install" : "Check"}</button>} /> },
    ],
    advanced: [
      { search: "diagnostic support bundle log 诊断包", node: <SettingRow key="diagnostic" icon={<FileDown size={16} />} title="Diagnostic bundle" description="Export redacted runtime information without subscription tokens or passwords." value={diagnosticPath ? "A bundle was generated in this session" : undefined} control={<button className="setting-toggle" type="button" onClick={onGenerateDiagnosticBundle} disabled={busy || diagnosticBusy}>{diagnosticBusy ? "Generating…" : "Generate"}</button>} /> },
      { search: "override yaml advanced config", node: <SettingRow key="override" icon={<SlidersHorizontal size={16} />} title="Local Override" description="Edit the global local override and preview it with the selected Profile." control={<button className="setting-toggle" type="button" onClick={() => onNavigate("overrides")}>Open editor</button>} /> },
    ],
    about: [
      { search: "about mioproxy version", node: <SettingRow key="about-app" icon={<Info size={16} />} title="MioProxy" description="Windows controller for a MioProxy-managed Mihomo runtime." value={`Version ${appUpdate.currentVersion}`} /> },
      { search: "service ipc background version", node: <SettingRow key="about-service" icon={<ShieldCheck size={16} />} title="Background Service" description="Privileged operations are isolated behind the local Service IPC boundary." value={!serviceConnection ? "—" : serviceConnection.versionMismatch ? "Version mismatch" : serviceConnection.reachable ? serviceConnection.serviceVersion ?? "Connected" : "Reconnecting"} /> },
    ],
  }), [appUpdate, busy, coreState, coreUpdate, coreUpdateBusy, diagnosticBusy, diagnosticPath, onCheckCoreUpdate, onCheckForUpdate, onGenerateDiagnosticBundle, onInstallCoreUpdate, onInstallUpdate, onNavigate, onRequestProxyTransition, onRequestTunTransition, onToggleMinimized, onToggleStartup, onToggleUpdatePreference, proxyExternal, proxyState, proxyStatus, serviceConnection, startup, status, theme, tunBusy, tunExternal, tunStatus, tunWillDisable, updatePreferences]);

  const normalizedQuery = query.trim().toLowerCase();
  const sections = searching
    ? CATEGORIES.map((item) => ({ ...item, rows: content[item.id].filter((row) => row.search.includes(normalizedQuery)) })).filter((item) => item.rows.length)
    : [{ ...CATEGORIES.find((item) => item.id === category)!, rows: content[category] }];

  return (
    <section className="page-stack settings-page">
      <header className="page-header compact-header"><div><h1>Settings</h1><p>Application preferences and trusted runtime controls.</p></div><label className="search-box settings-search"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings…" aria-label="Search settings" /></label></header>
      {serviceConnection?.error && <div className="info-bar warning"><ShieldCheck size={16} /><span>{serviceConnection.versionMismatch ? "The background Service version is incompatible with this app version." : "MioProxy is reconnecting to the background Service."}</span></div>}
      <div className="settings-workspace">
        <aside className="settings-categories surface-panel" aria-label="Settings categories">
          {CATEGORIES.map((item) => <button key={item.id} type="button" className={!searching && category === item.id ? "active" : ""} onClick={() => { setCategory(item.id); setQuery(""); }}>{item.label}</button>)}
        </aside>
        <div className="settings-content">
          {sections.length ? sections.map((section) => <section key={section.id} className="settings-section surface-panel"><div className="settings-section-title"><h2>{section.label}</h2>{searching && <span>{section.rows.length} match{section.rows.length === 1 ? "" : "es"}</span>}</div><div className="settings-list">{section.rows.map((row) => row.node)}</div></section>) : <div className="empty-card surface-panel"><Search size={20} /><strong>No settings match “{query}”</strong><p>Try another term or clear the search.</p></div>}
        </div>
      </div>
    </section>
  );
}
