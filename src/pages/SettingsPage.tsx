import { FolderCog, LockKeyhole, ShieldCheck } from "lucide-react";
import type { CoreStatus } from "../api/mihomo";

export function SettingsPage({ status }: { status: CoreStatus | null }) {
  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p>V0.1 先固定安全的本机 Controller。后续再做端口、DNS、TUN 和系统代理配置。</p>
        </div>
      </header>

      <div className="settings-list">
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
          <div><span>V0.1 安全策略</span><strong>前端不直接访问 Controller，统一经 Rust command 转发</strong></div>
        </article>
      </div>
    </section>
  );
}
