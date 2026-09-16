import { TrafficModeControl } from "../components/TrafficModeControl";
import { NodePicker } from "../components/NodePicker";
import { ArrowDown, ArrowUp, Laptop, Network, Route, ServerCog, ShieldAlert, SlidersHorizontal, Workflow } from "lucide-react";
import type { CoreMode, ProxiesResponse, CoreState, CoreStatus, MihomoVersion, Profile, ProxyPathState, ProxyState, SystemProxyStatus, TrafficSnapshot, TunStatusSnapshot } from "../api/mihomo";
import type { Page } from "../components/Sidebar";
import { useI18n } from "../i18n/I18nProvider";
import { formatBytes, formatRate, latencyTone } from "../utils/format";

function chartPoints(snapshot: TrafficSnapshot | null, key: "up" | "down") {
  const points = snapshot?.history ?? [];
  if (points.length < 2) return "0,90 600,90";
  const max = Math.max(1, ...points.map((point) => Math.max(point.up, point.down)));
  return points.map((point, index) => {
    const x = (index / Math.max(1, points.length - 1)) * 600;
    const y = 90 - (point[key] / max) * 76;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function StateValue({ tone, children }: { tone: "success" | "warning" | "error" | "muted"; children: React.ReactNode }) {
  return <span className={`state-value dashboard-state-value tone-${tone}`}><span className="state-dot" />{children}</span>;
}

function systemProxyLabel(snapshot: SystemProxyStatus | null, transitioning = false) {
  if (!snapshot) return { key: "dashboard.state.checking" as const, tone: "muted" as const, owned: false, external: false };
  if (snapshot.owner === "external" || snapshot.actualState === "externalEndpoint" || snapshot.externalDetected) return { key: "dashboard.state.external" as const, tone: "warning" as const, owned: false, external: true };
  if (transitioning) return { key: "dashboard.state.pending" as const, tone: "warning" as const, owned: false, external: false };
  if (snapshot.owner === "mioproxy" && snapshot.actualState === "mioproxyEndpoint" && snapshot.enabled) return { key: "dashboard.state.enabled" as const, tone: "success" as const, owned: true, external: false };
  // The card reports the observed Windows state. A persisted desired flag must
  // not make an already-disabled proxy look like it is still transitioning.
  if (snapshot.owner === "none" && snapshot.actualState === "disabled") return { key: "dashboard.state.disabled" as const, tone: "muted" as const, owned: false, external: false };
  if (!snapshot.stateConsistent) return { key: "dashboard.state.recoveryRequired" as const, tone: "error" as const, owned: false, external: false };
  return { key: "dashboard.state.disabled" as const, tone: "muted" as const, owned: false, external: false };
}

function tunLabel(snapshot: TunStatusSnapshot | null) {
  if (!snapshot) return { key: "dashboard.state.checking" as const, tone: "muted" as const, owned: false, external: false };
  if (snapshot.projection === "external" || snapshot.owner === "external" || snapshot.actualState === "externalTun" || snapshot.externalDetected) return { key: "dashboard.state.external" as const, tone: "warning" as const, owned: false, external: true };
  if (snapshot.projection === "error") return { key: "dashboard.state.error" as const, tone: "error" as const, owned: false, external: false };
  if (snapshot.projection === "waitingForService" || snapshot.projection === "enabling" || snapshot.projection === "disabling") return { key: "dashboard.state.pending" as const, tone: "warning" as const, owned: false, external: false };
  if (snapshot.projection === "recovering") return { key: "dashboard.state.recoveryRequired" as const, tone: "warning" as const, owned: false, external: false };
  if (snapshot.projection === "on" || (snapshot.owner === "mioproxy" && snapshot.actualState === "mioproxyTun" && snapshot.status === "running")) return { key: "dashboard.state.active" as const, tone: "success" as const, owned: true, external: false };
  if (snapshot.projection === "off") return { key: "dashboard.state.disabled" as const, tone: "muted" as const, owned: false, external: false };
  if (snapshot.status === "starting" || snapshot.status === "stopping") return { key: "dashboard.state.pending" as const, tone: "warning" as const, owned: false, external: false };
  if (snapshot.status === "error") return { key: "dashboard.state.error" as const, tone: "error" as const, owned: false, external: false };
  return { key: "dashboard.state.disabled" as const, tone: "muted" as const, owned: false, external: false };
}

const CORE_STATE_KEYS = {
  stopped: "dashboard.state.stopped",
  starting: "dashboard.state.starting",
  ready: "dashboard.state.ready",
  error: "dashboard.state.error",
} as const;

function coreStateKey(state: CoreState) {
  return CORE_STATE_KEYS[state];
}

function MioPathRail({ status, proxyStatus, tunStatus, currentNode, delay, proxyPathState }: {
  status: CoreStatus | null;
  proxyStatus: SystemProxyStatus | null;
  tunStatus: TunStatusSnapshot | null;
  currentNode: string | null;
  delay: number | null;
  proxyPathState: ProxyPathState;
}) {
  const { t } = useI18n();
  const proxy = systemProxyLabel(proxyStatus);
  const tun = tunLabel(tunStatus);
  const managedRoute = tun.owned || proxy.owned;
  const externalRoute = tun.external || proxy.external;
  const transport = tun.owned ? "TUN" : proxy.owned ? t("dashboard.systemProxy") : externalRoute ? t("dashboard.path.externalRoute") : t("dashboard.path.direct");
  const transportTone = managedRoute ? "success" : externalRoute ? "warning" : "muted";
  const nodeTone = proxyPathState === "unavailable" ? "error" : delay !== null ? latencyTone(delay) === "slow" ? "warning" : "success" : "muted";
  const steps = [
    { label: t("dashboard.path.device"), detail: "Windows", icon: Laptop, tone: "success" },
    { label: t("dashboard.path.route"), detail: transport, icon: Route, tone: transportTone },
    { label: t("dashboard.core"), detail: managedRoute ? status?.state === "ready" ? t("dashboard.path.controllerVerified") : status ? t(coreStateKey(status.state)) : t("dashboard.state.checking") : t("dashboard.path.notManaged"), icon: ServerCog, tone: managedRoute ? status?.state === "ready" ? "success" : status?.state === "error" ? "error" : "warning" : "muted" },
    { label: t("dashboard.path.rules"), detail: managedRoute ? status?.mode ? status.mode.toUpperCase() : "—" : t("dashboard.path.notObserved"), icon: Workflow, tone: managedRoute && status?.state === "ready" ? "success" : "muted" },
    { label: t("dashboard.path.node"), detail: managedRoute ? currentNode ? `${currentNode}${delay === null ? "" : ` · ${delay} ms`}` : "—" : t("dashboard.path.notObserved"), icon: Network, tone: managedRoute ? nodeTone : "muted" },
  ] as const;

  return (
    <section className="path-panel dashboard-path-panel surface-panel" aria-labelledby="path-heading">
      <div className="section-title-row"><div><h2 id="path-heading">{t("dashboard.path.title")}</h2><p>{t("dashboard.path.description")}</p></div></div>
      <ol className="mio-path-rail">
        {steps.map(({ label, detail, icon: Icon, tone }) => (
          <li key={label} className={`path-step tone-${tone}`}>
            <span className="path-icon"><Icon size={15} /></span>
            <span><strong>{label}</strong><small>{detail}</small></span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TrafficChart({ snapshot }: { snapshot: TrafficSnapshot | null }) {
  const { t } = useI18n();
  return (
    <section className="traffic-panel dashboard-traffic-panel surface-panel" aria-labelledby="traffic-heading">
      <div className="section-title-row">
        <div><h2 id="traffic-heading">{t("dashboard.traffic.title")}</h2><p>{t("dashboard.traffic.last60Seconds")}</p></div>
        <div className="traffic-legend">
          <span className="download"><ArrowDown size={13} /><b>{formatRate(snapshot?.down)}</b></span>
          <span className="upload"><ArrowUp size={13} /><b>{formatRate(snapshot?.up)}</b></span>
        </div>
      </div>
      <div className="traffic-plot">
        <svg viewBox="0 0 600 96" role="img" aria-label={t("dashboard.traffic.chartLabel")}>
          <path className="chart-grid-line" d="M0 14H600 M0 52H600 M0 90H600" />
          <polyline className="chart-line chart-line-down" points={chartPoints(snapshot, "down")} />
          <polyline className="chart-line chart-line-up" points={chartPoints(snapshot, "up")} />
        </svg>
        {!snapshot && <span className="plot-empty">{t("dashboard.traffic.empty")}</span>}
      </div>
      <div className="traffic-totals"><span>{t("dashboard.traffic.todayDownload")} <b>{formatBytes(snapshot?.todayDown)}</b></span><span>{t("dashboard.traffic.todayUpload")} <b>{formatBytes(snapshot?.todayUp)}</b></span></div>
    </section>
  );
}

export function DashboardPage({
  status,
  coreState,
  version,
  proxyStatus,
  proxyState,
  tunStatus,
  tunBusy,
  traffic,
  connectionCount,
  currentNode,
  delay,
  proxyPathState,
  memory,
  selectedProfile,
  appliedProfileName,
  error,
  tunError,
  onRequestProxyTransition,
  onRequestTunTransition,
  onNavigate,
  modeBusy = false, onModeChange, proxies = null, proxySelectionBusy = false, onSelectNode, activeProfile = null, activeGroup = null,
}: {
  modeBusy?: boolean;
  onModeChange?: (mode: CoreMode) => Promise<void>;
  proxies?: ProxiesResponse | null;
  proxySelectionBusy?: boolean;
  onSelectNode?: (group: string, node: string) => Promise<void>;
  activeProfile?: Profile | null;
  activeGroup?: string | null;
  status: CoreStatus | null;
  coreState: CoreState;
  version: MihomoVersion | null;
  proxyStatus: SystemProxyStatus | null;
  proxyState: ProxyState;
  tunStatus: TunStatusSnapshot | null;
  tunBusy: boolean;
  traffic: TrafficSnapshot | null;
  connectionCount: number | null;
  currentNode: string | null;
  delay: number | null;
  proxyPathState: ProxyPathState;
  memory: number | null;
  selectedProfile: Profile | null;
  appliedProfileName: string | null;
  error: string | null;
  tunError: string | null;
  onRequestProxyTransition: () => void;
  onRequestTunTransition: () => void;
  onNavigate: (page: Page) => void;
}) {
  const { t } = useI18n();
  const proxyBusy = proxyState === "enabling" || proxyState === "disabling";
  const proxy = systemProxyLabel(proxyStatus, proxyBusy);
  const tun = tunLabel(tunStatus);
  const checking = status === null;
  const healthy = coreState === "ready" && proxy.tone !== "error" && tun.tone !== "error";
  const tunTransitioning = tunStatus?.projection === "waitingForService" || tunStatus?.projection === "enabling" || tunStatus?.projection === "disabling" || tunStatus?.projection === "recovering";
  const tunWillDisable = !tun.external && Boolean(tun.owned || tunStatus?.desiredEnabled);
  const coreTone = checking ? "muted" : coreState === "ready" ? "success" : coreState === "error" ? "error" : "warning";
  const profileMatch = appliedProfileName && selectedProfile?.name ? selectedProfile.name === appliedProfileName ? "same" : "different" : "unknown";

  return (
    <section className="page-stack dashboard-page" data-profile-match={profileMatch}>
      <header className="page-header compact-header">
        <div><h1>{t("dashboard.title")}</h1><p>{t("dashboard.description")}</p></div>
      </header>

      {(error || tunError) && <div className="info-bar error dashboard-error-bar" role="alert"><ShieldAlert size={16} /><span>{tunError ?? error}</span></div>}

      <div className="home-control-grid">
        <section className="surface-panel home-card">
          <div className="section-title-row"><h2>{t("home.subscription")}</h2><button type="button" className="quiet-button" onClick={() => onNavigate("profiles")}>{t("nav.profiles")} →</button></div>
          <h3 className="home-value">{appliedProfileName ?? t("home.noSubscription")}</h3>
          {activeProfile && <dl className="home-facts"><div><dt>{t("profiles.details.source")}</dt><dd>{(() => { try { return new URL(activeProfile.url).hostname; } catch { return "—"; } })()}</dd></div><div><dt>{t("profiles.details.nodeCount")}</dt><dd>{activeProfile.nodeCount ?? "—"}</dd></div></dl>}
          <p className="home-caption">{t(appliedProfileName ? "home.subscriptionActive" : "home.subscriptionHint")}</p>
          {!appliedProfileName && <button type="button" className="primary-button" onClick={() => onNavigate("profiles")}>{t("home.manageSubscriptions")}</button>}
        </section>
        <section className="surface-panel home-card">
          <div className="section-title-row"><h2>{t("dashboard.selectedNode")}</h2><button type="button" className="quiet-button" onClick={() => onNavigate("proxies")}>{t("nav.proxies")} →</button></div>
          <div className="home-node-summary"><Network size={22} /><strong>{currentNode ?? "—"}</strong><span className={`latency-${latencyTone(delay)}`}>{delay === null ? "—" : `${delay} ms`}</span></div>
          {onSelectNode && <NodePicker data={proxies} busy={proxySelectionBusy} activeGroup={activeGroup} onSelect={onSelectNode} />}
        </section>
        <section className="surface-panel home-card">
          <div className="section-title-row"><h2>{t("home.network")}</h2><dl className="home-core-state"><div><dt>{t("dashboard.core")}</dt><dd><StateValue tone={coreTone}>{t(checking ? "dashboard.state.checking" : coreStateKey(coreState))}</StateValue></dd></div></dl></div>
          <dl className="home-network-row"><dt>{t("dashboard.systemProxy")}</dt><dd><StateValue tone={proxy.tone}>{t(proxy.key)}</StateValue></dd><button type="button" className="secondary-button" onClick={onRequestProxyTransition} disabled={coreState !== "ready" || proxyBusy || proxy.external}>{t(proxyBusy ? "dashboard.action.working" : proxy.external ? "dashboard.action.externalProxy" : proxy.owned ? "dashboard.action.disableProxy" : "dashboard.action.enableProxy")}</button></dl><p className="home-caption">{t("home.systemProxyHint")}</p>
          <div className="home-network-row"><div><strong>{t("home.tun")}</strong><p>{t("home.tunHint")}</p></div><button type="button" className="secondary-button" onClick={onRequestTunTransition} disabled={tunBusy || tunTransitioning || tun.external || (!tunWillDisable && coreState !== "ready")}>{t(tunBusy || tunTransitioning ? "dashboard.action.working" : tun.external ? "dashboard.action.externalTun" : tunWillDisable ? "dashboard.action.disableTun" : "dashboard.action.enableTun")}</button></div>
          <button className="quiet-button" type="button" onClick={() => onNavigate("settings")}>{t("nav.settings")} →</button>
        </section>
        <section className="surface-panel home-card">
          <div className="section-title-row"><h2>{t("proxies.mode.label")}</h2><Workflow size={18} /></div>
          {onModeChange && <TrafficModeControl mode={status?.mode ?? null} busy={modeBusy} available={coreState === "ready"} onChange={onModeChange} />}
          <p className="home-caption">{t(status?.mode ? `proxies.mode.${status.mode}Description` : "home.modeUnavailable")}</p>
          <p className="home-caption">{t("home.modeHint")}</p>
        </section>
      </div>
      <div className="dashboard-metrics">
        <div className="dashboard-metric surface-panel"><span>{t("dashboard.rate.down")}</span><strong>{formatRate(traffic?.down)}</strong></div>
        <div className="dashboard-metric surface-panel"><span>{t("dashboard.rate.up")}</span><strong>{formatRate(traffic?.up)}</strong></div>
        <button type="button" className="dashboard-metric surface-panel" onClick={() => onNavigate("connections")}><span>{t("dashboard.profile.connections")}</span><strong>{connectionCount ?? "—"}</strong></button>
        <div className="dashboard-metric surface-panel"><span>{t("dashboard.profile.memory")}</span><strong>{formatBytes(memory)}</strong></div>
      </div>
      <TrafficChart snapshot={traffic} />
      <details className="dashboard-path-details surface-panel">
        <summary>{t("dashboard.hero.inspect")}</summary>
        <MioPathRail status={status} proxyStatus={proxyStatus} tunStatus={tunStatus} currentNode={currentNode} delay={delay} proxyPathState={proxyPathState} />
      </details>
    </section>
  );
}
