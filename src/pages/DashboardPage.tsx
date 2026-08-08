import { Activity, CirclePower, Gauge, Network, Radio, ServerCog, Zap } from "lucide-react";
import type { CoreStatus, MihomoVersion, SystemProxyStatus, TrafficSnapshot } from "../api/mihomo";
import { formatBytes, formatRate } from "../utils/format";

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
  return (
    <div className="traffic-chart-wrap">
      <div className="chart-heading">
        <div><span>REALTIME TRAFFIC</span><strong>最近 60 秒</strong></div>
        <div className="chart-legend"><i className="legend-down" />下载 <i className="legend-up" />上传</div>
      </div>
      <svg className="traffic-chart" viewBox="0 0 600 120" role="img" aria-label="最近 60 秒实时流量曲线">
        <path className="chart-grid-line" d="M0 16H600 M0 62H600 M0 108H600" />
        <polyline className="chart-line chart-line-down" points={chartPoints(snapshot, "down")} />
        <polyline className="chart-line chart-line-up" points={chartPoints(snapshot, "up")} />
      </svg>
      {!snapshot && <span className="chart-empty">启动 Mihomo 后开始采样</span>}
    </div>
  );
}

export function DashboardPage({
  status,
  version,
  proxyStatus,
  traffic,
  connectionCount,
  currentNode,
  delay,
  memory,
  busy,
  error,
  onToggle,
}: {
  status: CoreStatus | null;
  version: MihomoVersion | null;
  proxyStatus: SystemProxyStatus | null;
  traffic: TrafficSnapshot | null;
  connectionCount: number;
  currentNode: string | null;
  delay: number | null;
  memory: number | null;
  busy: boolean;
  error: string | null;
  onToggle: () => void;
}) {
  const running = Boolean(status?.running);

  return (
    <section className="page-stack dashboard-page">
      <header className="page-header dashboard-header">
        <div>
          <p className="eyebrow">MIOPROXY / DASHBOARD</p>
          <h1>实时控制台</h1>
          <p>把内核状态、实时流量和连接活动放在同一个视野里。</p>
        </div>
        <button className={running ? "power-button stop" : "power-button"} disabled={busy} onClick={onToggle}>
          <CirclePower size={18} />
          {busy ? "处理中…" : running ? "停止内核" : "启动内核"}
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="dashboard-hero">
        <div className={running ? "dashboard-status-dot online" : "dashboard-status-dot"} />
        <div className="dashboard-hero-main">
          <div className="dashboard-overline"><span>MioProxy</span><b>{running ? "● ON" : "○ OFF"}</b></div>
          <strong>{currentNode ?? (running ? "DIRECT / 未选择节点" : "等待启动 Mihomo")}</strong>
          <small>{version?.version ? `Mihomo ${version.version}` : status?.controller ?? "127.0.0.1:9090"}</small>
        </div>
        <div className="dashboard-latency"><span>LATENCY</span><strong>{delay === null ? "—" : `${delay} ms`}</strong></div>
      </div>

      <div className="traffic-summary-grid">
        <article className="traffic-summary-card download"><span>↓ 下载</span><strong>{formatRate(traffic?.down)}</strong><small>今日下载 {formatBytes(traffic?.todayDown)}</small></article>
        <article className="traffic-summary-card upload"><span>↑ 上传</span><strong>{formatRate(traffic?.up)}</strong><small>今日上传 {formatBytes(traffic?.todayUp)}</small></article>
      </div>

      <TrafficChart snapshot={traffic} />

      <div className="dashboard-metric-grid">
        <article className="metric-card"><ServerCog size={20} /><div><span>System Proxy</span><strong>{proxyStatus?.enabled ? "ON" : "OFF"}</strong></div></article>
        <article className="metric-card"><Gauge size={20} /><div><span>Rule Mode</span><strong>{status?.mode?.toUpperCase() ?? "RULE"}</strong></div></article>
        <article className="metric-card"><Network size={20} /><div><span>Active Connections</span><strong>{running ? connectionCount : 0}</strong></div></article>
        <article className="metric-card"><Activity size={20} /><div><span>Memory</span><strong>{formatBytes(memory)}</strong></div></article>
        <article className="metric-card"><Radio size={20} /><div><span>Mixed Port</span><strong>{status?.mixedPort ?? 7890}</strong></div></article>
        <article className="metric-card"><Zap size={20} /><div><span>Controller</span><strong>{running ? "Connected" : "Offline"}</strong></div></article>
      </div>
    </section>
  );
}
