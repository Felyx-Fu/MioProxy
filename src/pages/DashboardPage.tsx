import { ArrowDown, ArrowUp, Laptop, Network, Route, ServerCog, ShieldAlert, SlidersHorizontal, Workflow } from "lucide-react";
import type { CoreState, CoreStatus, MihomoVersion, Profile, ProxyPathState, ProxyState, SystemProxyStatus, TrafficSnapshot, TunStatusSnapshot } from "../api/mihomo";
import type { Page } from "../components/Sidebar";
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
  return <span className={`state-value tone-${tone}`}><span className="state-dot" />{children}</span>;
}

function systemProxyLabel(snapshot: SystemProxyStatus | null) {
  if (!snapshot) return { text: "Checking", tone: "muted" as const, owned: false, external: false };
  if (snapshot.owner === "external" || snapshot.actualState === "externalEndpoint" || snapshot.externalDetected) return { text: "External", tone: "warning" as const, owned: false, external: true };
  if (!snapshot.stateConsistent) return { text: "Recovery required", tone: "error" as const, owned: false, external: false };
  if (snapshot.owner === "mioproxy" && snapshot.actualState === "mioproxyEndpoint" && snapshot.enabled) return { text: "Enabled", tone: "success" as const, owned: true, external: false };
  if (snapshot.desiredEnabled) return { text: "Pending", tone: "warning" as const, owned: false, external: false };
  return { text: "Disabled", tone: "muted" as const, owned: false, external: false };
}

function tunLabel(snapshot: TunStatusSnapshot | null) {
  if (!snapshot) return { text: "Checking", tone: "muted" as const, owned: false, external: false };
  if (snapshot.status === "error") return { text: "Error", tone: "error" as const, owned: false, external: false };
  if (snapshot.status === "starting" || snapshot.status === "stopping") return { text: "Pending", tone: "warning" as const, owned: false, external: false };
  if (snapshot.owner === "external" || snapshot.actualState === "externalTun" || snapshot.externalDetected) return { text: "External", tone: "warning" as const, owned: false, external: true };
  if (snapshot.owner === "mioproxy" && snapshot.actualState === "mioproxyTun" && snapshot.status === "running") return { text: "Active", tone: "success" as const, owned: true, external: false };
  if (snapshot.desiredEnabled) return { text: "Recovery required", tone: "warning" as const, owned: false, external: false };
  return { text: "Disabled", tone: "muted" as const, owned: false, external: false };
}

function MioPathRail({ status, proxyStatus, tunStatus, currentNode, delay, proxyPathState }: {
  status: CoreStatus | null;
  proxyStatus: SystemProxyStatus | null;
  tunStatus: TunStatusSnapshot | null;
  currentNode: string | null;
  delay: number | null;
  proxyPathState: ProxyPathState;
}) {
  const proxy = systemProxyLabel(proxyStatus);
  const tun = tunLabel(tunStatus);
  const managedRoute = tun.owned || proxy.owned;
  const externalRoute = tun.external || proxy.external;
  const transport = tun.owned ? "TUN" : proxy.owned ? "System Proxy" : externalRoute ? "External route" : "Direct / not managed";
  const transportTone = managedRoute ? "success" : externalRoute ? "warning" : "muted";
  const nodeTone = proxyPathState === "unavailable" ? "error" : delay !== null ? latencyTone(delay) === "slow" ? "warning" : "success" : "muted";
  const steps = [
    { label: "Device", detail: "Windows", icon: Laptop, tone: "success" },
    { label: "Route", detail: transport, icon: Route, tone: transportTone },
    { label: "Core", detail: managedRoute ? status?.state === "ready" ? "Controller verified" : status ? status.state : "Checking" : "Not in managed path", icon: ServerCog, tone: managedRoute ? status?.state === "ready" ? "success" : status?.state === "error" ? "error" : "warning" : "muted" },
    { label: "Rules", detail: managedRoute ? status?.mode ? status.mode.toUpperCase() : "—" : "Not observed", icon: Workflow, tone: managedRoute && status?.state === "ready" ? "success" : "muted" },
    { label: "Node", detail: managedRoute ? currentNode ? `${currentNode}${delay === null ? "" : ` · ${delay} ms`}` : "—" : "Not observed", icon: Network, tone: managedRoute ? nodeTone : "muted" },
  ] as const;

  return (
    <section className="path-panel surface-panel" aria-labelledby="path-heading">
      <div className="section-title-row"><div><h2 id="path-heading">Mio Path</h2><p>Current route projection from trusted runtime signals.</p></div></div>
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
  return (
    <section className="traffic-panel surface-panel" aria-labelledby="traffic-heading">
      <div className="section-title-row">
        <div><h2 id="traffic-heading">Traffic · all networks</h2><p>Last 60 seconds</p></div>
        <div className="traffic-legend">
          <span className="download"><ArrowDown size={13} />{formatRate(snapshot?.down)}</span>
          <span className="upload"><ArrowUp size={13} />{formatRate(snapshot?.up)}</span>
        </div>
      </div>
      <div className="traffic-plot">
        <svg viewBox="0 0 600 96" role="img" aria-label="Download and upload traffic over the last 60 seconds">
          <path className="chart-grid-line" d="M0 14H600 M0 52H600 M0 90H600" />
          <polyline className="chart-line chart-line-down" points={chartPoints(snapshot, "down")} />
          <polyline className="chart-line chart-line-up" points={chartPoints(snapshot, "up")} />
        </svg>
        {!snapshot && <span className="plot-empty">Traffic begins after Core is ready.</span>}
      </div>
      <div className="traffic-totals"><span>Today download <b>{formatBytes(snapshot?.todayDown)}</b></span><span>Today upload <b>{formatBytes(snapshot?.todayUp)}</b></span></div>
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
}: {
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
  const proxy = systemProxyLabel(proxyStatus);
  const tun = tunLabel(tunStatus);
  const checking = status === null;
  const healthy = coreState === "ready" && proxy.tone !== "error" && tun.tone !== "error";
  const proxyBusy = proxyState === "enabling" || proxyState === "disabling";
  const tunTransitioning = tunStatus?.status === "starting" || tunStatus?.status === "stopping";
  const tunWillDisable = !tun.external && Boolean(tun.owned || tunStatus?.desiredEnabled);
  const coreTone = checking ? "muted" : coreState === "ready" ? "success" : coreState === "error" ? "error" : "warning";

  return (
    <section className="page-stack dashboard-page">
      <header className="page-header compact-header">
        <div><h1>Overview</h1><p>Runtime health, selected route and current traffic.</p></div>
      </header>

      {(error || tunError) && <div className="info-bar error" role="alert"><ShieldAlert size={16} /><span>{tunError ?? error}</span></div>}

      <div className="dashboard-summary-grid">
        <section className="surface-panel summary-panel" aria-labelledby="health-heading">
          <div className="section-title-row"><div><h2 id="health-heading">Connection health</h2><p>{version?.version ? `Mihomo ${version.version}` : "MioProxy managed runtime"}</p></div><StateValue tone={checking ? "muted" : healthy ? "success" : coreState === "error" ? "error" : "warning"}>{checking ? "Checking" : healthy ? "Healthy" : "Attention"}</StateValue></div>
          <dl className="summary-list">
            <div><dt>Core</dt><dd><StateValue tone={coreTone}>{checking ? "Checking" : coreState === "ready" ? "Ready" : coreState}</StateValue></dd></div>
            <div><dt>System Proxy</dt><dd><StateValue tone={proxy.tone}>{proxy.text}</StateValue></dd></div>
            <div><dt>TUN</dt><dd><StateValue tone={tun.tone}>{tun.text}</StateValue></dd></div>
            <div><dt>Selected node</dt><dd>{currentNode ? <button className="inline-link" type="button" onClick={() => onNavigate("proxies")}>{currentNode}{delay === null ? "" : ` · ${delay} ms`}</button> : "—"}</dd></div>
          </dl>
          <div className="summary-actions">
            <button className="secondary-button" type="button" onClick={onRequestProxyTransition} disabled={coreState !== "ready" || proxyBusy || proxy.external}>{proxyBusy ? "Working…" : proxy.external ? "External proxy" : proxy.owned ? "Disable proxy" : "Enable proxy"}</button>
            <button className="secondary-button" type="button" onClick={onRequestTunTransition} disabled={tunBusy || tunTransitioning || tun.external || (!tunWillDisable && coreState !== "ready")}>{tunBusy || tunTransitioning ? "Working…" : tun.external ? "External TUN" : tunWillDisable ? "Disable TUN" : "Enable TUN"}</button>
          </div>
        </section>

        <section className="surface-panel summary-panel" aria-labelledby="profile-heading">
          <div className="section-title-row"><div><h2 id="profile-heading">Runtime profile</h2><p>Active profile is unavailable until the runtime exposes it.</p></div><SlidersHorizontal size={17} /></div>
          <dl className="summary-list">
            <div><dt>Active profile</dt><dd>{appliedProfileName ? `${appliedProfileName} · this session` : "—"}</dd></div>
            <div><dt>Selected profile</dt><dd>{selectedProfile?.name ?? "—"}</dd></div>
            <div><dt>Mode</dt><dd>{status?.mode?.toUpperCase() ?? "—"}</dd></div>
            <div><dt>Node count</dt><dd>{selectedProfile?.nodeCount ?? "—"}</dd></div>
            <div><dt>Connections</dt><dd>{connectionCount ?? "—"}</dd></div>
            <div><dt>Memory</dt><dd>{formatBytes(memory)}</dd></div>
          </dl>
          <button className="secondary-button" type="button" onClick={() => onNavigate("profiles")}>Open Profiles</button>
        </section>
      </div>

      <MioPathRail status={status} proxyStatus={proxyStatus} tunStatus={tunStatus} currentNode={currentNode} delay={delay} proxyPathState={proxyPathState} />
      <TrafficChart snapshot={traffic} />
    </section>
  );
}
