import { Activity, Gauge, Network, Radio, ServerCog, ShieldCheck, Zap } from "lucide-react";
import type { CoreState, CoreStatus, MihomoVersion, ProxyPathState, ProxyState, SystemProxyStatus, TrafficSnapshot } from "../api/mihomo";
import { formatBytes, formatRate, latencyTone } from "../utils/format";

const CORE_LABELS: Record<CoreState, string> = {
  stopped: "Stopped",
  starting: "Starting…",
  ready: "Ready",
  error: "Error",
};

function chartPoints(snapshot: TrafficSnapshot | null, key: "up" | "down") {
  const points = snapshot?.history ?? [];
  if (points.length < 2) return "0,108 600,108";
  const max = Math.max(1, ...points.map((point) => Math.max(point.up, point.down)));
  return points.map((point, index) => {
    const x = (index / Math.max(1, points.length - 1)) * 600;
    const y = 108 - (point[key] / max) * 92;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function TrafficChart({ snapshot }: { snapshot: TrafficSnapshot | null }) {
  const down = chartPoints(snapshot, "down");
  const up = chartPoints(snapshot, "up");
  return (
    <div className="traffic-chart-wrap panel">
      <div className="chart-heading">
        <div><span>REALTIME TRAFFIC</span><strong>最近 60 秒</strong></div>
        <div className="chart-legend"><i className="legend-down" />下载 <i className="legend-up" />上传</div>
      </div>
      <div className="chart-canvas">
        <div className="chart-y-labels"><span>高速</span><span>中速</span><span>低速</span></div>
        <svg className="traffic-chart" viewBox="0 0 600 120" role="img" aria-label="最近 60 秒实时流量曲线">
          <defs>
            <linearGradient id="traffic-down-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#58b7ff" stopOpacity=".2" /><stop offset="1" stopColor="#58b7ff" stopOpacity="0" /></linearGradient>
            <linearGradient id="traffic-up-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#a78bfa" stopOpacity=".16" /><stop offset="1" stopColor="#a78bfa" stopOpacity="0" /></linearGradient>
          </defs>
          <path className="chart-grid-line" d="M0 16H600 M0 62H600 M0 108H600" />
          <polygon className="chart-area chart-area-down" points={`0,108 ${down} 600,108`} />
          <polygon className="chart-area chart-area-up" points={`0,108 ${up} 600,108`} />
          <polyline className="chart-line chart-line-down" points={down} />
          <polyline className="chart-line chart-line-up" points={up} />
        </svg>
      </div>
      {!snapshot && <span className="chart-empty">Core Ready 后开始采样</span>}
    </div>
  );
}

function statusClass(state: CoreState | ProxyState) {
  return `status-pill status-${state === "ready" ? "running" : state}`;
}

export function DashboardPage({
  status,
  coreState,
  version,
  proxyStatus,
  proxyState,
  traffic,
  connectionCount,
  currentNode,
  delay,
  proxyPathState,
  memory,
  error,
  onRequestProxyTransition,
}: {
  status: CoreStatus | null;
  coreState: CoreState;
  version: MihomoVersion | null;
  proxyStatus: SystemProxyStatus | null;
  proxyState: ProxyState;
  traffic: TrafficSnapshot | null;
  connectionCount: number;
  currentNode: string | null;
  delay: number | null;
  proxyPathState: ProxyPathState;
  memory: number | null;
  error: string | null;
  onRequestProxyTransition: () => void;
}) {
  const ready = coreState === "ready";
  const coreVisualState = ready ? "running" : coreState;
  const proxyBusy = proxyState === "enabling" || proxyState === "disabling";
  const canToggleProxy = ready && !proxyBusy;
  const proxyLabel = proxyBusy
    ? "切换中…"
    : proxyStatus?.enabled
      ? "已开启"
      : proxyStatus?.externalDetected
        ? "外部代理"
        : "已关闭";
  const proxyMetric = proxyState === "error"
    ? "ERROR"
    : proxyStatus?.enabled
      ? "ON"
      : proxyStatus?.externalDetected
        ? "EXTERNAL"
        : "OFF";
  const delayTone = latencyTone(delay);
  const proxyPathLabel = proxyPathState === "unavailable" ? "当前节点不可用" : proxyPathState === "degraded" ? "当前节点不稳定" : delay === null ? "尚未测速" : delayTone === "fast" ? "连接顺畅" : delayTone === "medium" ? "可以接受" : "建议切换节点";

  return (
    <section className="page-stack dashboard-page">
      <header className="page-header dashboard-header">
        <div>
          <p className="eyebrow">MIOPROXY / SIGNAL DECK</p>
          <h1>实时控制台</h1>
          <p>后台内核自动保持就绪；在这里直接选择系统代理或 TUN。</p>
        </div>
      </header>

      {error && <div className={`error-banner ${coreState === "error" ? "error-banner-prominent" : ""}`}><ShieldCheck size={17} /><span>{error}</span></div>}

      <div className={`dashboard-hero ${coreVisualState}`}>
        <div className={`dashboard-status-dot ${coreVisualState}`} />
        <div className="dashboard-hero-main">
          <div className="dashboard-overline"><span>MioProxy Core</span><span className={statusClass(coreState)}>{CORE_LABELS[coreState]}</span></div>
          <div className="current-node-label">CURRENT NODE</div>
          <strong>{currentNode ?? (ready ? "DIRECT / 未选择节点" : "后台内核正在准备")}</strong>
          <small>{version?.version ? `Mihomo ${version.version}` : status?.controller ?? "Controller offline · 127.0.0.1:9090"}</small>
        </div>
        <div className="dashboard-hero-actions">
          <div className="dashboard-latency"><span>PROXY PATH</span><strong className={`latency-value ${delayTone}`}>{delay === null ? "—" : `${delay} ms`}</strong><small>{proxyPathLabel}</small></div>
          <button className={`quick-toggle ${proxyStatus?.enabled ? "enabled" : ""}`} type="button" onClick={onRequestProxyTransition} disabled={!canToggleProxy}>
            <ServerCog size={16} />
            <span><small>系统代理</small><b>{proxyLabel}</b></span>
          </button>
        </div>
      </div>

      <div className="dashboard-quick-grid">
        <article className="quick-control panel"><div className="quick-control-icon violet"><Gauge size={18} /></div><div><span>运行模式</span><strong>{status?.mode?.toUpperCase() ?? "RULE"}</strong></div><em>当前配置</em></article>
        <article className="quick-control panel"><div className="quick-control-icon blue"><Network size={18} /></div><div><span>活动连接</span><strong>{ready ? connectionCount : 0}</strong></div><em>实时</em></article>
        <article className="quick-control panel"><div className="quick-control-icon green"><Zap size={18} /></div><div><span>混合端口</span><strong>{status?.mixedPort ?? 7890}</strong></div><em>127.0.0.1</em></article>
      </div>

      <div className="traffic-summary-grid">
        <article className="traffic-summary-card download panel"><span>↓ 下载速度</span><strong>{formatRate(traffic?.down)}</strong><small>今日累计 {formatBytes(traffic?.todayDown)}</small></article>
        <article className="traffic-summary-card upload panel"><span>↑ 上传速度</span><strong>{formatRate(traffic?.up)}</strong><small>今日累计 {formatBytes(traffic?.todayUp)}</small></article>
      </div>

      <TrafficChart snapshot={traffic} />

      <div className="dashboard-metric-grid">
        <article className="metric-card panel"><ServerCog size={20} /><div><span>System Proxy</span><strong>{proxyMetric}</strong></div></article>
        <article className="metric-card panel"><Gauge size={20} /><div><span>Rule Mode</span><strong>{status?.mode?.toUpperCase() ?? "RULE"}</strong></div></article>
        <article className="metric-card panel"><Network size={20} /><div><span>Active Connections</span><strong>{ready ? connectionCount : 0}</strong></div></article>
        <article className="metric-card panel"><Activity size={20} /><div><span>Memory</span><strong>{formatBytes(memory)}</strong></div></article>
        <article className="metric-card panel"><Radio size={20} /><div><span>Mixed Port</span><strong>{status?.mixedPort ?? 7890}</strong></div></article>
        <article className="metric-card panel"><Zap size={20} /><div><span>Controller</span><strong>{ready ? "Connected" : "Offline"}</strong></div></article>
      </div>
    </section>
  );
}
