import { AlertTriangle, Check, CirclePower, Network, RefreshCw, Route, ShieldCheck, Wifi } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { mihomoApi, type ServiceConnectionStatus, type TunStatus, type TunStatusSnapshot } from "../api/mihomo";

const STATUS_LABELS: Record<TunStatus, string> = {
  disabled: "Disabled",
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  error: "Error",
};

const STATUS_COPY: Record<TunStatus, string> = {
  disabled: "TUN 未接管系统流量",
  starting: "正在校验配置并建立 TUN 路由",
  running: "Mihomo 正在接管全局流量",
  stopping: "正在撤销 TUN 配置并恢复运行状态",
  error: "TUN 没有处于安全运行状态",
};

export function TunPage({ profileId, coreRunning, systemProxyEnabled }: {
  profileId: string | null;
  coreRunning: boolean;
  systemProxyEnabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState<TunStatusSnapshot | null>(null);
  const [service, setService] = useState<ServiceConnectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestInFlight = useRef(false);

  const load = useCallback(async (clearError = true) => {
    if (requestInFlight.current) {
      return;
    }
    requestInFlight.current = true;
    try {
      const [nextSnapshot, nextService] = await Promise.all([mihomoApi.tunStatus(), mihomoApi.serviceStatus()]);
      setSnapshot(nextSnapshot);
      setService(nextService);
      if (clearError) {
        setError(null);
      }
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

  async function toggle() {
    if (requestInFlight.current) {
      return;
    }
    const enabled = snapshot?.status === "disabled";
    if (enabled && !profileId) {
      setError("请先选择已下载的 Profile");
      return;
    }
    setSnapshot((current) =>
      current
        ? {
            ...current,
            status: enabled ? "starting" : "stopping",
            message: null,
          }
        : current,
    );
    setLoading(true);
    setError(null);
    requestInFlight.current = true;
    try {
      setSnapshot(await mihomoApi.tunSetEnabled(enabled, profileId));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      requestInFlight.current = false;
      await load(false);
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }

  const status = snapshot?.status ?? "disabled";
  const transitioning = status === "starting" || status === "stopping";
  const blocked = !coreRunning || !profileId || systemProxyEnabled;

  return (
    <section className="page-stack tun-page">
      <header className="page-header">
        <div><p className="eyebrow">TUN / WINDOWS ROUTE</p><h1>透明代理</h1><p>通过 Mihomo TUN 接管系统流量。启用前会检查管理员权限并保存默认路由、DNS 和网络适配器快照。</p></div>
        <button className={status === "running" ? "power-button stop" : "power-button"} type="button" onClick={() => void toggle()} disabled={loading || !snapshot || transitioning || blocked && status !== "running" && status !== "error"}>
          <CirclePower size={17} />{loading ? "处理中…" : STATUS_LABELS[status]}
        </button>
      </header>

      {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span></div>}
      {snapshot?.message && <div className={status === "error" ? "error-banner" : "success-banner"}><ShieldCheck size={17} /><span>{snapshot.message}</span></div>}

      <div className={`tun-status-card panel ${status}`}>
        <div className={`tun-status-dot ${status}`} />
        <div className="tun-status-copy"><span>TRANSPARENT ROUTE</span><strong>{STATUS_LABELS[status]}</strong><small>{STATUS_COPY[status]}</small></div>
        <div className="tun-status-meta"><span>管理员权限 <b>{snapshot?.admin ? "已满足" : service?.admin ? "由 Service 提供" : "需要提升"}</b></span><span>内核 <b>{coreRunning ? "Running" : "Disabled"}</b></span><span>所有权 <b>{service?.reachable ? service.ownsCore ? "MioProxy Service" : service.ownershipConflict ? "冲突" : "Service 在线" : "GUI fallback"}</b></span><span>系统代理 <b>{systemProxyEnabled ? "冲突" : "关闭"}</b></span></div>
      </div>

      {(!coreRunning || !profileId || systemProxyEnabled) && <div className="tun-prerequisite panel"><AlertTriangle size={17} /><div><strong>启用前置条件</strong><span>{!coreRunning ? "请先启动 Mihomo。" : !profileId ? "请先添加并下载一个 Profile。" : "请先关闭系统代理，避免 auto-route 和 Windows Proxy 同时接管。"}</span></div></div>}

      <div className="tun-settings-grid">
        <article className="tun-setting-card panel"><div className="tun-setting-icon blue"><Route size={18} /></div><div><span>Auto Route</span><strong>已启用</strong><small>全局路由进入 MioProxy TUN</small></div></article>
        <article className="tun-setting-card panel"><div className="tun-setting-icon violet"><Wifi size={18} /></div><div><span>Auto Detect Interface</span><strong>已启用</strong><small>网络变化后自动重新绑定出口</small></div></article>
        <article className="tun-setting-card panel"><div className="tun-setting-icon green"><Network size={18} /></div><div><span>DNS Hijack</span><strong>any:53 + TCP</strong><small>交由 Mihomo DNS 模块处理</small></div></article>
      </div>

      <section className="tun-snapshot-card panel"><div className="section-heading"><div><span>FAILURE RECOVERY</span><strong>运行前快照</strong></div><button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新 TUN 状态"><RefreshCw size={15} /></button></div><div className="tun-snapshot-grid"><span><b>{snapshot?.snapshot ? "已捕获" : "未捕获"}</b>默认路由</span><span><b>{snapshot?.snapshot ? "已捕获" : "未捕获"}</b>DNS 服务器</span><span><b>{snapshot?.snapshot ? "已捕获" : "未捕获"}</b>网络适配器</span></div><small className="tun-recovery-note"><Check size={14} /> TUN 失败、Mihomo 崩溃或 MioProxy 退出时，会先恢复 Local Override，再结束当前会话。</small></section>
    </section>
  );
}
