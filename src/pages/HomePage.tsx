import { CirclePower, Gauge, Radio, ServerCog } from "lucide-react";
import type { CoreStatus, MihomoVersion } from "../api/mihomo";

export function HomePage({
  status,
  version,
  busy,
  error,
  onToggle,
}: {
  status: CoreStatus | null;
  version: MihomoVersion | null;
  busy: boolean;
  error: string | null;
  onToggle: () => void;
}) {
  const running = Boolean(status?.running);

  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h1>代理核心</h1>
          <p>Profile、节点控制和 Mihomo Controller 已接入；系统代理与 TUN 仍保持在后续阶段。</p>
        </div>
        <button className={running ? "power-button stop" : "power-button"} disabled={busy} onClick={onToggle}>
          <CirclePower size={18} />
          {busy ? "处理中…" : running ? "停止内核" : "启动内核"}
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="hero-card">
        <div className={running ? "pulse running" : "pulse"} />
        <div className="hero-copy">
          <span>{running ? "CORE ONLINE" : "CORE OFFLINE"}</span>
          <strong>{running ? "Mihomo 已连接" : "等待启动"}</strong>
          <small>{status?.controller ?? "127.0.0.1:9090"}</small>
        </div>
        <div className="hero-version">{version?.version ?? "—"}</div>
      </div>

      <div className="metric-grid">
        <article className="metric-card">
          <ServerCog size={20} />
          <div><span>内核状态</span><strong>{running ? "Running" : "Stopped"}</strong></div>
        </article>
        <article className="metric-card">
          <Radio size={20} />
          <div><span>Mixed Port</span><strong>7890</strong></div>
        </article>
        <article className="metric-card">
          <Gauge size={20} />
          <div><span>运行模式</span><strong>Rule</strong></div>
        </article>
      </div>

      <div className="roadmap-card">
        <span>当前里程碑</span>
        <strong>V0.2 · Profiles + Core lifecycle + Node control</strong>
        <div className="roadmap-track"><i /></div>
        <small>下一阶段：订阅更新策略、系统代理与连接观测</small>
      </div>
    </section>
  );
}
