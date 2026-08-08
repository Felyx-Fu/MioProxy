import { FolderCog, LockKeyhole, Power, Rocket, ShieldCheck } from "lucide-react";
import type { CoreState, CoreStatus, ProxyState, StartupSettings, SystemProxyStatus } from "../api/mihomo";

type SettingsPageProps = {
  status: CoreStatus | null;
  coreState: CoreState;
  proxyStatus: SystemProxyStatus | null;
  proxyState: ProxyState;
  startup: StartupSettings | null;
  busy: boolean;
  onToggleProxy: () => void;
  onToggleStartup: (enabled: boolean) => void;
  onToggleMinimized: (enabled: boolean) => void;
};

export function SettingsPage({
  status,
  coreState,
  proxyStatus,
  proxyState,
  startup,
  busy,
  onToggleProxy,
  onToggleStartup,
  onToggleMinimized,
}: SettingsPageProps) {
  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p>在保留 Windows 系统代理安全边界的同时，统一管理内核、启动项和本地运行配置。</p>
        </div>
      </header>

      <div className="settings-list">
        <article className="setting-row">
          <Power size={20} />
          <div className="setting-copy"><span>系统代理</span><strong>{proxyStatus?.enabled ? `已开启 · 127.0.0.1:${proxyStatus.mixedPort}` : "已关闭 · 保留 Windows 原始设置"}</strong><small>{status?.running ? "由 MioProxy 接管，内核退出时自动恢复" : "启动 Mihomo 后才能开启"}</small></div>
          <button className="setting-toggle" type="button" onClick={onToggleProxy} disabled={coreState !== "running" || busy} aria-pressed={proxyStatus?.enabled ?? false}>
            {proxyState === "enabling" || proxyState === "disabling" ? "切换中…" : proxyStatus?.enabled ? "关闭" : "开启"}
          </button>
        </article>
        <article className="setting-row">
          <Rocket size={20} />
          <div className="setting-copy"><span>开机启动 MioProxy</span><strong>{startup?.enabled ? "已开启" : "未开启"}</strong><small>仅写入当前用户启动项，不需要管理员权限</small></div>
          <button className="setting-toggle" type="button" onClick={() => onToggleStartup(!(startup?.enabled ?? false))} disabled={busy} aria-pressed={startup?.enabled ?? false}>
            {startup?.enabled ? "关闭" : "开启"}
          </button>
        </article>
        <article className="setting-row">
          <Rocket size={20} />
          <div className="setting-copy"><span>启动时最小化到托盘</span><strong>{startup?.startMinimized ? "已开启" : "未开启"}</strong><small>需要先开启开机启动；也可通过托盘重新显示主窗口</small></div>
          <button className="setting-toggle" type="button" onClick={() => onToggleMinimized(!(startup?.startMinimized ?? false))} disabled={!startup?.enabled || busy} aria-pressed={startup?.startMinimized ?? false}>
            {startup?.startMinimized ? "关闭" : "开启"}
          </button>
        </article>
        <article>
          <FolderCog size={20} />
          <div><span>运行配置</span><strong>{status?.configPath ?? "启动内核后生成 config.yaml"}</strong></div>
        </article>
        <article>
          <LockKeyhole size={20} />
          <div><span>Controller</span><strong>仅监听 127.0.0.1:9090</strong></div>
        </article>
        <article>
          <ShieldCheck size={20} />
          <div><span>安全策略</span><strong>代理开启前检查内核；内核异常退出或 MioProxy 退出都会恢复原始设置</strong></div>
        </article>
      </div>
    </section>
  );
}
