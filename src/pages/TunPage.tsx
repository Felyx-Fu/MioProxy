import { AlertTriangle, CirclePower, Network, Route, ShieldCheck, Wifi } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { mihomoApi, type TunStatusSnapshot } from "../api/mihomo";

const PROJECTION_LABELS = {
  off: "OFF",
  on: "ON",
  external: "EXTERNAL",
  transitioning: "TRANSITIONING",
  error: "ERROR",
} as const;

const PROJECTION_COPY = {
  off: "MioProxy TUN 未接管系统流量",
  on: "Mihomo TUN 正在接管全局流量",
  external: "检测到外部 TUN；MioProxy 未接管，Core 与系统代理仍可使用。",
  transitioning: "正在生成、校验并加载 Mihomo TUN 运行配置",
  error: "TUN 没有处于安全运行状态，可关闭并执行恢复",
} as const;

export function TunPage({ profileId, coreRunning, systemProxyEnabled }: {
  profileId: string | null;
  coreRunning: boolean;
  systemProxyEnabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState<TunStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestInFlight = useRef(false);

  const load = useCallback(async (clearError = true) => {
    if (requestInFlight.current) {
      return;
    }
    requestInFlight.current = true;
    try {
      setSnapshot(await mihomoApi.tunStatus());
      if (clearError) setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [load]);

  async function requestTunTransition() {
    if (requestInFlight.current) {
      return;
    }
    setLoading(true);
    setError(null);
    requestInFlight.current = true;
    let failed = false;
    try {
      const current = await mihomoApi.tunStatus();
      const enabled = !current.desiredEnabled;
      if (enabled && !profileId) {
        setSnapshot(current);
        setError("请先选择已下载的 Profile");
        return;
      }
      setSnapshot({
        ...current,
        status: enabled ? "starting" : "stopping",
        message: null,
        desiredEnabled: enabled,
      });
      setSnapshot(await mihomoApi.tunSetEnabled(enabled, profileId));
    } catch (value) {
      failed = true;
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
    if (failed) await load(false);
  }

  const status = snapshot?.status ?? "disabled";
  const transitioning = status === "starting" || status === "stopping";
  const externalTunActive = Boolean(snapshot?.externalDetected);
  const desiredEnabled = Boolean(snapshot?.desiredEnabled);
  const projection = status === "error"
    ? "error"
    : transitioning
      ? "transitioning"
      : snapshot?.owner === "mioproxy" && status === "running"
        ? "on"
        : externalTunActive
          ? "external"
          : "off";
  const blockedForEnable = !coreRunning || !profileId;

  return (
    <section className="page-stack tun-page">
      <header className="page-header">
        <div><p className="eyebrow">TUN / WINDOWS ROUTE</p><h1>透明代理</h1><p>通过 Mihomo TUN、auto-route 与 DNS 运行配置接管系统流量。</p></div>
        <button className={desiredEnabled ? "power-button stop" : "power-button"} type="button" onClick={() => void requestTunTransition()} disabled={loading || !snapshot || transitioning || !desiredEnabled && blockedForEnable} aria-pressed={desiredEnabled}>
          <CirclePower size={17} />{loading || transitioning ? "处理中…" : desiredEnabled ? status === "error" ? "关闭并恢复" : "关闭" : status === "error" ? "重试开启" : "开启"}
        </button>
      </header>

      {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span></div>}
      {snapshot?.message && <div className={status === "error" ? "error-banner" : "success-banner"}><ShieldCheck size={17} /><span>{snapshot.message}</span></div>}

      <div className={`tun-status-card panel ${status}`}>
        <div className={`tun-status-dot ${status}`} />
        <div className="tun-status-copy"><span>TRANSPARENT ROUTE</span><strong>{PROJECTION_LABELS[projection]}</strong><small>{PROJECTION_COPY[projection]}</small></div>
        <div className="tun-status-meta"><span>Core <b>{coreRunning ? "Ready" : "Preparing"}</b></span><span>System Proxy <b>{systemProxyEnabled ? "ON" : "OFF"}</b></span>{externalTunActive && <span>External TUN <b>Active</b></span>}</div>
      </div>

      {(!coreRunning || !profileId) && <div className="tun-prerequisite panel"><AlertTriangle size={17} /><div className="tun-prerequisite-copy"><strong>启用前置条件</strong><span>{!coreRunning ? "后台内核正在准备，请稍后重试。" : "请先添加并下载一个 Profile。"}</span></div></div>}

      <div className="tun-settings-grid">
        <article className="tun-setting-card panel"><div className="tun-setting-icon blue"><Route size={18} /></div><div><span>Auto Route</span><strong>已启用</strong><small>全局路由进入 MioProxy TUN</small></div></article>
        <article className="tun-setting-card panel"><div className="tun-setting-icon violet"><Wifi size={18} /></div><div><span>Auto Detect Interface</span><strong>已启用</strong><small>网络变化后自动重新绑定出口</small></div></article>
        <article className="tun-setting-card panel"><div className="tun-setting-icon green"><Network size={18} /></div><div><span>DNS Hijack</span><strong>any:53 + TCP</strong><small>交由 Mihomo DNS 模块处理</small></div></article>
      </div>

    </section>
  );
}
