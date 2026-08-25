import { Download, FileDown, FolderCog, Info, LockKeyhole, Monitor, Network, Power, Rocket, Route, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { ReactNode, useMemo, useState } from "react";
import type { CoreState, CoreStatus, CoreUpdateStatus, ProxyState, ServiceConnectionStatus, StartupSettings, SystemProxyStatus, TunStatusSnapshot, UpdatePreferences, UpdateStatus } from "../api/mihomo";
import { useAppearance, type ThemePreference } from "../appearance/AppearanceProvider";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../locales/en-US";
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
type SettingTone = "success" | "warning" | "error" | "muted" | "accent";
type SettingControlKind = "default" | "toggle" | "navigation" | "operation" | "select";

const CATEGORIES: Array<{ id: Category; label: MessageKey; description: MessageKey }> = [
  { id: "general", label: "settings.category.general", description: "settings.category.generalDescription" },
  { id: "network", label: "settings.category.network", description: "settings.category.networkDescription" },
  { id: "core", label: "settings.category.core", description: "settings.category.coreDescription" },
  { id: "appearance", label: "settings.category.appearance", description: "settings.category.appearanceDescription" },
  { id: "updates", label: "settings.category.updates", description: "settings.category.updatesDescription" },
  { id: "advanced", label: "settings.category.advanced", description: "settings.category.advancedDescription" },
  { id: "about", label: "settings.category.about", description: "settings.category.aboutDescription" },
];

const CORE_STATE_KEYS: Record<CoreState, MessageKey> = {
  stopped: "dashboard.state.stopped",
  starting: "dashboard.state.starting",
  ready: "dashboard.state.ready",
  error: "dashboard.state.error",
};

const SERVICE_STATE_KEYS: Record<ServiceConnectionStatus["state"], MessageKey> = {
  running: "settings.service.running",
  stopped: "settings.service.stopped",
  starting: "settings.service.starting",
  reconnecting: "settings.service.reconnecting",
  error: "settings.service.error",
};

const CORE_STATE_TONES: Record<CoreState, SettingTone> = {
  stopped: "muted",
  starting: "warning",
  ready: "success",
  error: "error",
};

function booleanTone(value: boolean | undefined): SettingTone {
  return value === undefined ? "warning" : value ? "success" : "muted";
}

function serviceTone(connection: ServiceConnectionStatus | null): SettingTone {
  if (!connection) return "warning";
  if (connection.versionMismatch || connection.state === "error") return "error";
  if (connection.state === "running") return "success";
  if (connection.state === "stopped") return "muted";
  return "warning";
}

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

function SettingRow({ icon, title, description, value, control, className, controlKind = "default", valueTone, descriptionTone, technical, state, groupLabel }: {
  icon: ReactNode;
  title: string;
  description: string;
  value?: string;
  control?: ReactNode;
  className?: string;
  controlKind?: SettingControlKind;
  valueTone?: SettingTone;
  descriptionTone?: SettingTone;
  technical?: boolean;
  state?: string;
  groupLabel?: string;
}) {
  const rowClassName = ["setting-row", className].filter(Boolean).join(" ");
  const valueClassName = ["setting-value", valueTone ? `tone-${valueTone}` : "", technical ? "setting-value-technical" : ""].filter(Boolean).join(" ");
  const descriptionClassName = descriptionTone ? `setting-description tone-${descriptionTone}` : "setting-description";
  return (
    <article className={`${rowClassName}${groupLabel ? " setting-row-with-group" : ""}`} data-setting-state={state}>
      {groupLabel && <div className="setting-group-label">{groupLabel}</div>}
      <div className="setting-row-content">
        <span className="setting-icon" aria-hidden="true">{icon}</span>
        <div className="setting-copy"><strong>{title}</strong><span className={descriptionClassName} title={description}>{description}</span>{value && <small className={valueClassName} title={value}>{valueTone && <span className="state-dot" aria-hidden="true" />}{value}</small>}</div>
        {control && <div className={`setting-control setting-control-${controlKind}`}>{control}</div>}
      </div>
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
  const { t, languagePreference, setLanguagePreference } = useI18n();
  const { themePreference, setThemePreference, useWindowsMaterial, setUseWindowsMaterial, materialStatus } = useAppearance();
  const [category, setCategory] = useState<Category>("general");
  const [query, setQuery] = useState("");
  const searching = Boolean(query.trim());
  const proxyExternal = Boolean(proxyStatus?.owner === "external" || proxyStatus?.actualState === "externalEndpoint" || proxyStatus?.externalDetected);
  const tunExternal = Boolean(tunStatus?.owner === "external" || tunStatus?.actualState === "externalTun" || tunStatus?.externalDetected);
  const tunOwned = Boolean(tunStatus?.owner === "mioproxy" && tunStatus?.actualState === "mioproxyTun");
  const tunWillDisable = !tunExternal && Boolean(tunOwned || tunStatus?.desiredEnabled);

  const enabledLabel = (value: boolean | undefined) => value === undefined ? t("common.checking") : t(value ? "common.enabled" : "common.disabled");
  const coreLabel = (state: CoreState) => t(CORE_STATE_KEYS[state]);
  const serviceLabel = (connection: ServiceConnectionStatus | null) => {
    if (!connection) return t("common.checking");
    if (connection.versionMismatch) return t("settings.service.versionMismatch");
    return t(SERVICE_STATE_KEYS[connection.state]);
  };

  const content: Record<Category, Array<{ search: string; node: ReactNode }>> = useMemo(() => ({
    general: [
      { search: "start windows launch startup 开机启动", node: <SettingRow key="startup" icon={<Rocket size={16} />} className="settings-general-start-row" title={t("settings.general.start.title")} description={t("settings.general.start.description")} value={startup ? enabledLabel(startup.enabled) : t("common.checking")} valueTone={startup ? booleanTone(startup.enabled) : "warning"} state={startup ? startup.enabled ? "on" : "off" : "checking"} controlKind="toggle" control={<button className="setting-toggle" type="button" onClick={() => onToggleStartup(!(startup?.enabled ?? false))} disabled={busy || !startup}>{startup?.enabled ? t("settings.action.turnOff") : t("settings.action.turnOn")}</button>} /> },
      { search: "minimize tray startup 最小化 托盘", node: <SettingRow key="minimized" icon={<Monitor size={16} />} className={!startup?.enabled ? "settings-dependent-row" : undefined} title={t("settings.general.minimized.title")} description={t("settings.general.minimized.description")} value={startup ? enabledLabel(startup.startMinimized) : t("common.checking")} valueTone={startup ? booleanTone(startup.startMinimized) : "warning"} state={!startup ? "checking" : !startup.enabled ? "dependent" : startup.startMinimized ? "on" : "off"} controlKind="toggle" control={<button className="setting-toggle" type="button" onClick={() => onToggleMinimized(!(startup?.startMinimized ?? false))} disabled={busy || !startup?.enabled}>{startup?.startMinimized ? t("settings.action.turnOff") : t("settings.action.turnOn")}</button>} /> },
    ],
    network: [
      { search: "system proxy windows network 系统代理", node: <SettingRow key="proxy" icon={<Power size={16} />} className="settings-network-row settings-proxy-row" state={!proxyStatus ? "checking" : proxyExternal ? "external" : proxyState === "enabling" || proxyState === "disabling" ? "transitioning" : proxyStatus.enabled ? "on" : "off"} title={t("settings.network.proxy.title")} description={proxyExternal ? t("settings.network.proxy.externalDescription") : t("settings.network.proxy.description")} value={!proxyStatus ? t("common.checking") : proxyExternal ? t("settings.network.proxy.externalOwner") : proxyStatus.enabled ? t("settings.network.proxy.onValue", { port: proxyStatus.mixedPort }) : t("common.off")} valueTone={!proxyStatus || proxyExternal || proxyState === "enabling" || proxyState === "disabling" ? "warning" : proxyStatus.enabled ? "success" : "muted"} controlKind="toggle" control={<button className="setting-toggle" type="button" onClick={onRequestProxyTransition} disabled={coreState !== "ready" || busy || proxyExternal}>{proxyState === "enabling" || proxyState === "disabling" ? t("common.working") : proxyExternal ? t("common.external") : proxyStatus?.enabled ? t("settings.action.turnOff") : t("settings.action.turnOn")}</button>} /> },
      { search: "tun transparent route network 透明代理", node: <SettingRow key="tun" icon={<Route size={16} />} className="settings-network-row settings-tun-row" state={!tunStatus ? "checking" : tunExternal || tunStatus.projection === "external" ? "external" : tunStatus.projection} title={t("settings.network.tun.title")} description={tunExternal ? t("settings.network.tun.externalDescription") : tunStatus?.projection === "waitingForService" ? t("settings.service.reconnectingWarning") : tunStatus?.projection === "recovering" ? t("settings.network.tun.recoveryPending") : t("settings.network.tun.description")} value={!tunStatus ? t("common.checking") : tunExternal || tunStatus.projection === "external" ? t("common.external") : tunStatus.projection === "on" ? t("common.on") : tunStatus.projection === "off" ? t("common.off") : tunStatus.projection === "error" ? t("common.error") : tunStatus.projection === "recovering" ? t("settings.network.tun.recoveryPending") : tunStatus.projection === "waitingForService" ? t("settings.service.reconnecting") : t("settings.network.tun.transitioning")} valueTone={!tunStatus || tunExternal || tunStatus.projection === "external" || tunStatus.projection === "recovering" || tunStatus.projection === "waitingForService" || tunStatus.projection === "enabling" || tunStatus.projection === "disabling" ? "warning" : tunStatus.projection === "on" ? "success" : tunStatus.projection === "error" ? "error" : "muted"} controlKind="toggle" control={<button className="setting-toggle" type="button" onClick={onRequestTunTransition} disabled={tunBusy || tunExternal || tunStatus?.projection === "waitingForService" || tunStatus?.projection === "recovering" || tunStatus?.projection === "enabling" || tunStatus?.projection === "disabling" || (!tunWillDisable && coreState !== "ready")}>{tunBusy ? t("common.working") : tunExternal ? t("common.external") : tunWillDisable ? t("settings.action.turnOff") : t("settings.action.turnOn")}</button>} /> },
      { search: "dns nameserver network", node: <SettingRow key="dns" icon={<Network size={16} />} className="settings-network-row settings-navigation-row" title={t("settings.network.dns.title")} description={t("settings.network.dns.description")} controlKind="navigation" control={<button className="setting-toggle" type="button" onClick={() => onNavigate("dns")}>{t("settings.action.openDns")}</button>} /> },
    ],
    core: [
      { search: "core mihomo state controller", node: <SettingRow key="core-state" icon={<ShieldCheck size={16} />} className="settings-core-state-row" state={!status ? "checking" : coreState} title={t("settings.core.mihomo.title")} description={t("settings.core.mihomo.description")} value={!status ? t("common.checking") : `${coreLabel(coreState)}${status.mode ? ` · ${status.mode}` : ""}`} valueTone={!status ? "warning" : CORE_STATE_TONES[coreState]} /> },
      { search: "config path runtime yaml", node: <SettingRow key="config" icon={<FolderCog size={16} />} className="settings-technical-row" title={t("settings.core.runtime.title")} description={t("settings.core.runtime.description")} value={status?.configPath ?? "—"} technical /> },
      { search: "controller localhost port 19090", node: <SettingRow key="controller" icon={<LockKeyhole size={16} />} className="settings-technical-row" title={t("settings.core.controller.title")} description={t("settings.core.controller.description")} value={status?.controller ?? "—"} technical /> },
    ],
    appearance: [
      { search: "language locale system 中文 English 语言", node: <SettingRow key="language" icon={<Monitor size={16} />} className="settings-appearance-row" title={t("settings.appearance.language.title")} description={t("settings.appearance.language.description")} controlKind="select" control={<select value={languagePreference} onChange={(event) => setLanguagePreference(event.target.value as typeof languagePreference)} aria-label={t("settings.appearance.language.label")}><option value="system">{t("settings.appearance.language.system")}</option><option value="zh-CN">{t("settings.appearance.language.zhCN")}</option><option value="en-US">{t("settings.appearance.language.enUS")}</option></select>} /> },
      { search: "theme light dark system appearance 主题", node: <SettingRow key="theme" icon={<Monitor size={16} />} className="settings-appearance-row" title={t("settings.appearance.theme.title")} description={t("settings.appearance.theme.description")} controlKind="select" control={<select value={themePreference} onChange={(event) => setThemePreference(event.target.value as ThemePreference)} aria-label={t("settings.appearance.theme.label")}><option value="system">{t("settings.appearance.theme.system")}</option><option value="light">{t("settings.appearance.theme.light")}</option><option value="dark">{t("settings.appearance.theme.dark")}</option></select>} /> },
      { search: "mica material transparency windows 材质", node: <SettingRow key="material" icon={<Monitor size={16} />} className="settings-appearance-row" state={!useWindowsMaterial ? "off" : materialStatus.applied ? "applied" : "fallback"} title={t("settings.appearance.material.title")} description={t("settings.appearance.material.description")} value={!useWindowsMaterial ? t("settings.appearance.material.off") : materialStatus.applied ? t("settings.appearance.material.applied") : t("settings.appearance.material.fallback")} valueTone={!useWindowsMaterial ? "muted" : materialStatus.applied ? "success" : "warning"} controlKind="toggle" control={<button className="setting-toggle" type="button" onClick={() => setUseWindowsMaterial(!useWindowsMaterial)}>{useWindowsMaterial ? t("settings.appearance.material.off") : t("settings.appearance.material.on")}</button>} /> },
    ],
    updates: [
      { search: "application app update version 更新", node: <SettingRow key="app-update" icon={<Download size={16} />} groupLabel={t("settings.updates.app.group")} className="settings-update-row settings-update-app-row" state={appUpdate.error ? "error" : appUpdate.checking || appUpdate.downloading || appUpdate.installing ? "working" : appUpdate.availableVersion ? "available" : "current"} descriptionTone={appUpdate.error ? "error" : undefined} title={t("settings.updates.app.title")} description={appUpdate.error ?? appUpdate.releaseNotes ?? t("settings.updates.app.description")} value={appUpdate.availableVersion ? t("settings.updates.app.available", { version: appUpdate.availableVersion }) : t("settings.updates.app.current", { version: appUpdate.currentVersion })} valueTone={appUpdate.error ? "error" : appUpdate.checking || appUpdate.downloading || appUpdate.installing ? "warning" : appUpdate.availableVersion ? "accent" : "muted"} controlKind="operation" control={<button className="setting-toggle" type="button" onClick={appUpdate.availableVersion ? onInstallUpdate : onCheckForUpdate} disabled={busy || appUpdate.checking || appUpdate.downloading || appUpdate.installing}>{appUpdate.downloading ? `${appUpdate.progress ?? 0}%` : appUpdate.installing ? t("settings.updates.app.installing") : appUpdate.checking ? t("settings.updates.app.checking") : appUpdate.availableVersion ? t("common.install") : t("common.check")}</button>} /> },
      { search: "startup check updates 自动检查", node: <SettingRow key="check-startup" icon={<Download size={16} />} groupLabel={t("settings.updates.preferences.group")} className="settings-update-row settings-update-preference-row" title={t("settings.updates.checkStartup.title")} description={t("settings.updates.checkStartup.description")} value={updatePreferences ? enabledLabel(updatePreferences.checkOnStartup) : t("common.checking")} valueTone={updatePreferences ? booleanTone(updatePreferences.checkOnStartup) : "warning"} state={updatePreferences ? updatePreferences.checkOnStartup ? "on" : "off" : "checking"} controlKind="toggle" control={<button className="setting-toggle" type="button" onClick={() => onToggleUpdatePreference("checkOnStartup", !(updatePreferences?.checkOnStartup ?? false))} disabled={busy || !updatePreferences}>{updatePreferences?.checkOnStartup ? t("settings.action.turnOff") : t("settings.action.turnOn")}</button>} /> },
      { search: "auto download updates 自动下载", node: <SettingRow key="auto-download" icon={<Download size={16} />} className="settings-update-row settings-update-preference-row" title={t("settings.updates.autoDownload.title")} description={t("settings.updates.autoDownload.description")} value={updatePreferences ? enabledLabel(updatePreferences.autoDownload) : t("common.checking")} valueTone={updatePreferences ? booleanTone(updatePreferences.autoDownload) : "warning"} state={updatePreferences ? updatePreferences.autoDownload ? "on" : "off" : "checking"} controlKind="toggle" control={<button className="setting-toggle" type="button" onClick={() => onToggleUpdatePreference("autoDownload", !(updatePreferences?.autoDownload ?? false))} disabled={busy || !updatePreferences}>{updatePreferences?.autoDownload ? t("settings.action.turnOff") : t("settings.action.turnOn")}</button>} /> },
      { search: "mihomo core update version", node: <SettingRow key="core-update" icon={<ShieldCheck size={16} />} groupLabel={t("settings.updates.core.group")} className="settings-update-row settings-update-core-row" state={coreUpdate?.error ? "error" : coreUpdateBusy ? "working" : coreUpdate?.availableVersion ? "available" : coreUpdate?.phase === "completed" ? "completed" : coreUpdate?.currentVersion ? "current" : "waiting"} descriptionTone={coreUpdate?.error ? "error" : undefined} title={t("settings.updates.core.title")} description={coreUpdate?.error ?? (coreUpdate?.phase === "completed" ? t("settings.updates.core.completedDescription") : t("settings.updates.core.description"))} value={coreUpdate?.availableVersion ? t("settings.updates.core.available", { version: coreUpdate.availableVersion }) : coreUpdate?.currentVersion ? t("settings.updates.core.current", { version: coreUpdate.currentVersion }) : t("settings.updates.core.waiting")} valueTone={coreUpdate?.error ? "error" : coreUpdateBusy ? "warning" : coreUpdate?.availableVersion ? "accent" : coreUpdate?.phase === "completed" ? "success" : coreUpdate?.currentVersion ? "muted" : "warning"} controlKind="operation" control={<button className="setting-toggle" type="button" onClick={coreUpdate?.availableVersion ? onInstallCoreUpdate : onCheckCoreUpdate} disabled={busy || coreUpdateBusy}>{coreUpdateBusy ? t("common.working") : coreUpdate?.availableVersion ? t("common.install") : t("common.check")}</button>} /> },
    ],
    advanced: [
      { search: "diagnostic support bundle log 诊断包", node: <SettingRow key="diagnostic" icon={<FileDown size={16} />} className="settings-advanced-row" valueTone={diagnosticPath ? "success" : undefined} state={diagnosticBusy ? "working" : diagnosticPath ? "generated" : undefined} title={t("settings.advanced.diagnostic.title")} description={t("settings.advanced.diagnostic.description")} value={diagnosticPath ? t("settings.advanced.diagnostic.generated") : undefined} controlKind="operation" control={<button className="setting-toggle" type="button" onClick={onGenerateDiagnosticBundle} disabled={busy || diagnosticBusy}>{diagnosticBusy ? t("settings.advanced.diagnostic.generating") : t("common.generate")}</button>} /> },
      { search: "override yaml advanced config", node: <SettingRow key="override" icon={<SlidersHorizontal size={16} />} className="settings-advanced-row settings-navigation-row" title={t("settings.advanced.override.title")} description={t("settings.advanced.override.description")} controlKind="navigation" control={<button className="setting-toggle" type="button" onClick={() => onNavigate("overrides")}>{t("settings.action.openEditor")}</button>} /> },
    ],
    about: [
      { search: "about mioproxy version", node: <SettingRow key="about-app" icon={<Info size={16} />} className="settings-about-row" title="MioProxy" description={t("settings.about.app.description")} value={t("settings.about.version", { version: appUpdate.currentVersion })} /> },
      { search: "service ipc background version", node: <SettingRow key="about-service" icon={<ShieldCheck size={16} />} className="settings-about-row" state={!serviceConnection ? "checking" : serviceConnection.versionMismatch ? "mismatch" : serviceConnection.state} title={t("settings.about.service.title")} description={t("settings.about.service.description")} value={serviceLabel(serviceConnection)} valueTone={serviceTone(serviceConnection)} /> },
    ],
  }), [appUpdate, busy, coreState, coreUpdate, diagnosticBusy, diagnosticPath, languagePreference, materialStatus, onCheckCoreUpdate, onCheckForUpdate, onGenerateDiagnosticBundle, onInstallCoreUpdate, onInstallUpdate, onNavigate, onRequestProxyTransition, onRequestTunTransition, onToggleMinimized, onToggleStartup, onToggleUpdatePreference, proxyExternal, proxyState, proxyStatus, serviceConnection, setLanguagePreference, setThemePreference, setUseWindowsMaterial, startup, status, t, themePreference, tunBusy, tunExternal, tunStatus, tunWillDisable, updatePreferences, useWindowsMaterial]);

  const normalizedQuery = query.trim().toLowerCase();
  const sections = searching
    ? CATEGORIES.map((item) => ({ ...item, rows: content[item.id].filter((row) => row.search.includes(normalizedQuery)) })).filter((item) => item.rows.length)
    : [{ ...CATEGORIES.find((item) => item.id === category)!, rows: content[category] }];

  return (
    <section className="page-stack settings-page">
      <header className="page-header compact-header"><div><h1>{t("settings.title")}</h1><p>{t("settings.description")}</p></div><label className="search-box settings-search"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.searchPlaceholder")} aria-label={t("settings.searchLabel")} /></label></header>
      {serviceConnection?.error && <div className="info-bar warning settings-service-warning" role="status"><ShieldCheck size={16} aria-hidden="true" /><span>{serviceConnection.versionMismatch ? t("settings.service.versionMismatchWarning") : serviceConnection.state === "error" ? t("settings.service.errorWarning") : t("settings.service.reconnectingWarning")}</span></div>}
      <div className="settings-workspace" data-searching={searching ? "true" : "false"}>
        <aside className="settings-categories surface-panel" aria-label={t("settings.categoriesLabel")}>
          {CATEGORIES.map((item) => <button key={item.id} type="button" data-category={item.id} className={!searching && category === item.id ? "active" : ""} aria-current={!searching && category === item.id ? "page" : undefined} onClick={() => { setCategory(item.id); setQuery(""); }}>{t(item.label)}</button>)}
        </aside>
        <div className="settings-content">
          {sections.length ? sections.map((section) => <section key={section.id} className={`settings-section surface-panel settings-section-${section.id}`} aria-labelledby={`settings-section-${section.id}-heading`}><div className="settings-section-title"><div className="settings-section-heading"><h2 id={`settings-section-${section.id}-heading`}>{t(section.label)}</h2><p>{t(section.description)}</p></div>{searching && <span className="settings-match-count">{section.rows.length === 1 ? t("settings.match") : t("settings.matches", { count: section.rows.length })}</span>}</div><div className="settings-list">{section.rows.map((row) => row.node)}</div></section>) : <div className="empty-card surface-panel settings-empty-card"><Search size={20} aria-hidden="true" /><strong>{t("settings.noMatches", { query })}</strong><p>{t("settings.noMatchesHelp")}</p></div>}
        </div>
      </div>
    </section>
  );
}
