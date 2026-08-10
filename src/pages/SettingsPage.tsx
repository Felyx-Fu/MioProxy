import { Download, FileDown, FolderCog, LockKeyhole, Power, Rocket, ShieldCheck } from "lucide-react";
import type { CoreState, CoreStatus, CoreUpdateStatus, ProxyState, ServiceConnectionStatus, StartupSettings, SystemProxyStatus, UpdatePreferences, UpdateStatus } from "../api/mihomo";

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

type SettingsPageProps = {
  status: CoreStatus | null;
  coreState: CoreState;
  proxyStatus: SystemProxyStatus | null;
  proxyState: ProxyState;
  serviceConnection: ServiceConnectionStatus | null;
  startup: StartupSettings | null;
  updatePreferences: UpdatePreferences | null;
  busy: boolean;
  onRequestProxyTransition: () => void;
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
};

export function SettingsPage({
  status,
  coreState,
  proxyStatus,
  proxyState,
  serviceConnection,
  startup,
  updatePreferences,
  busy,
  onRequestProxyTransition,
  onToggleStartup,
  onToggleMinimized,
  onToggleUpdatePreference,
  appUpdate,
  onCheckForUpdate,
  onInstallUpdate,
  coreUpdate,
  coreUpdateBusy,
  onCheckCoreUpdate,
  onInstallCoreUpdate,
  diagnosticBusy,
  diagnosticPath,
  onGenerateDiagnosticBundle,
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
        {serviceConnection?.error && <article className="setting-row">
          <ShieldCheck size={20} />
          <div className="setting-copy"><span>后台服务</span><strong>{serviceConnection.versionMismatch ? "后台服务版本不兼容" : "正在重新连接后台服务"}</strong><small>{serviceConnection.versionMismatch ? "请在完成应用升级后修复后台服务。" : "MioProxy 会在后台自动恢复连接；短暂中断不会影响窗口使用。"}</small></div>
        </article>}
        <article className="setting-row">
          <Power size={20} />
          <div className="setting-copy"><span>系统代理</span><strong>{proxyStatus?.enabled ? `已开启 · 127.0.0.1:${proxyStatus.mixedPort}` : proxyStatus?.externalDetected ? "外部代理 · MioProxy 未接管" : "已关闭 · 保留 Windows 原始设置"}</strong><small>{coreState === "ready" ? proxyStatus?.externalDetected ? "可请求由 MioProxy 接管；原始设置会先保存" : "由 MioProxy 接管，内核退出时自动恢复" : "Core Ready 后才能开启"}</small></div>
          <button className="setting-toggle" type="button" onClick={onRequestProxyTransition} disabled={coreState !== "ready" || busy} aria-pressed={proxyStatus?.enabled ?? false}>
            {proxyState === "enabling" || proxyState === "disabling" ? "切换中…" : proxyStatus?.enabled ? "关闭" : proxyStatus?.externalDetected ? "接管" : "开启"}
          </button>
        </article>
        <article className="setting-row">
          <Download size={20} />
          <div className="setting-copy"><span>应用更新</span><strong>{appUpdate.availableVersion ? `MioProxy ${appUpdate.availableVersion} 可用` : `当前版本 ${appUpdate.currentVersion}`}</strong><small>{appUpdate.error ?? appUpdate.releaseNotes ?? (appUpdate.progress !== null ? `下载进度 ${appUpdate.progress}%` : "使用签名验证的官方更新包")}</small></div>
          <button className="setting-toggle" type="button" onClick={appUpdate.availableVersion ? onInstallUpdate : onCheckForUpdate} disabled={busy || appUpdate.checking || appUpdate.downloading || appUpdate.installing}>
            {appUpdate.downloading ? `${appUpdate.progress ?? 0}%` : appUpdate.installing ? "安装中…" : appUpdate.checking ? "检查中…" : appUpdate.availableVersion ? (appUpdate.downloaded ? "安装更新" : "下载并安装") : "检查更新"}
          </button>
        </article>
        <article className="setting-row">
          <Download size={20} />
          <div className="setting-copy"><span>启动时检查更新</span><strong>{updatePreferences?.checkOnStartup ? "已开启" : "已关闭"}</strong><small>后台延迟检查，不阻塞 MioProxy 正常启动</small></div>
          <button className="setting-toggle" type="button" onClick={() => onToggleUpdatePreference("checkOnStartup", !(updatePreferences?.checkOnStartup ?? false))} disabled={busy || !updatePreferences} aria-pressed={updatePreferences?.checkOnStartup ?? false}>
            {updatePreferences?.checkOnStartup ? "关闭" : "开启"}
          </button>
        </article>
        <article className="setting-row">
          <Download size={20} />
          <div className="setting-copy"><span>自动下载更新</span><strong>{updatePreferences?.autoDownload ? "已开启" : "已关闭"}</strong><small>只下载并校验更新包，不会自动安装或重启</small></div>
          <button className="setting-toggle" type="button" onClick={() => onToggleUpdatePreference("autoDownload", !(updatePreferences?.autoDownload ?? false))} disabled={busy || !updatePreferences} aria-pressed={updatePreferences?.autoDownload ?? false}>
            {updatePreferences?.autoDownload ? "关闭" : "开启"}
          </button>
        </article>
        <article className="setting-row">
          <ShieldCheck size={20} />
          <div className="setting-copy"><span>Mihomo Core 更新</span><strong>{coreUpdate?.availableVersion ? `Mihomo ${coreUpdate.availableVersion} 可用` : coreUpdate?.currentVersion ? `当前版本 ${coreUpdate.currentVersion}` : "等待 Core 版本信息"}</strong><small>{coreUpdate?.error ?? (coreUpdate?.phase === "completed" ? "Core 已完成健康检查" : coreUpdate?.assetName ?? "仅使用官方 Release，并保留失败回滚")}</small></div>
          <button className="setting-toggle" type="button" onClick={coreUpdate?.availableVersion ? onInstallCoreUpdate : onCheckCoreUpdate} disabled={busy || coreUpdateBusy}>
            {coreUpdateBusy ? "处理中…" : coreUpdate?.availableVersion ? "下载并安装" : "检查更新"}
          </button>
        </article>
        <article className="setting-row">
          <FileDown size={20} />
          <div className="setting-copy"><span>诊断包</span><strong>{diagnosticPath ? "最近一次诊断包已生成" : "导出脱敏运行信息"}</strong><small>不包含订阅 token、密码或更新私钥</small></div>
          <button className="setting-toggle" type="button" onClick={onGenerateDiagnosticBundle} disabled={busy || diagnosticBusy}>
            {diagnosticBusy ? "生成中…" : "生成诊断包"}
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
          <div><span>运行配置</span><strong>{status?.configPath ?? "Core Ready 后生成 config.yaml"}</strong></div>
        </article>
        <article>
          <LockKeyhole size={20} />
          <div><span>Controller</span><strong>仅监听 127.0.0.1:19090</strong></div>
        </article>
        <article>
          <ShieldCheck size={20} />
          <div><span>安全策略</span><strong>代理开启前检查内核；内核异常退出或 MioProxy 退出都会恢复原始设置</strong></div>
        </article>
      </div>
    </section>
  );
}
