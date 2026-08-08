import { CalendarClock, Download, FileCheck2, FolderOpen, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { ConfirmDialog } from "../components/Feedback";
import type { Profile } from "../api/mihomo";
import { formatDate, maskUrl } from "../utils/format";

export function ProfilesPage({ profiles, selectedId, busyId, error, onAdd, onDownload, onApply, onRemove }: {
  profiles: Profile[];
  selectedId: string | null;
  busyId: string | null;
  error: string | null;
  onAdd: (name: string, url: string) => Promise<void>;
  onDownload: (id: string) => Promise<void>;
  onApply: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState<Profile | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onAdd(name, url);
      setName("");
      setUrl("");
    } catch {
      // The shared error banner and toast carry the command error.
    } finally {
      setSubmitting(false);
    }
  }

  async function removeConfirmed() {
    if (!confirming) return;
    try {
      await onRemove(confirming.id);
    } finally {
      setConfirming(null);
    }
  }

  return (
    <section className="page-stack profiles-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">PROFILES / SOURCES</p>
          <h1>订阅</h1>
          <p>把订阅地址保存为独立 Profile。MioProxy 会缓存 YAML，应用时才写入运行配置。</p>
        </div>
        <div className="page-header-stat"><strong>{profiles.length}</strong><span>个 Profile</span></div>
      </header>

      {error && <div className="error-banner"><ShieldCheck size={17} /><span>{error}</span></div>}

      <form className="profile-form panel" onSubmit={submit}>
        <div className="form-intro"><div className="quick-control-icon violet"><Plus size={18} /></div><div><strong>添加订阅</strong><span>敏感参数只用于本地请求</span></div></div>
        <label><span>Profile 名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的订阅" required /></label>
        <label className="profile-url-field"><span>订阅 URL</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/subscribe" required /></label>
        <button className="power-button" type="submit" disabled={submitting}><Plus size={17} /> {submitting ? "添加中…" : "添加 Profile"}</button>
      </form>

      {profiles.length === 0 ? (
        <div className="empty-card profile-empty panel"><Download size={28} /><strong>还没有 Profile</strong><p>先添加一个 http/https 订阅地址。下载完成后，这里会显示缓存状态和节点数量。</p></div>
      ) : (
        <div className="profile-list">
          {profiles.map((profile) => {
            const busy = busyId === profile.id;
            return <article className="profile-card panel" key={profile.id}>
              <div className="profile-card-icon"><FolderOpen size={20} /></div>
              <div className="profile-card-copy"><div className="profile-card-title"><strong>{profile.name}</strong><span className={selectedId === profile.id || profile.filePath ? "profile-status ready" : "profile-status"}>{selectedId === profile.id ? "当前构建" : profile.filePath ? "已缓存" : "未下载"}</span></div><small className="profile-safe-url">{maskUrl(profile.url)}</small><div className="profile-meta"><span><CalendarClock size={13} />{profile.updatedAt ? `更新于 ${formatDate(profile.updatedAt)}` : "等待首次更新"}</span><span><NetworkCount count={profile.nodeCount} /></span></div></div>
              <div className="profile-actions"><button className="secondary-button" onClick={() => void onDownload(profile.id)} disabled={busy}><Download size={16} /> {busy ? "处理中…" : "更新"}</button><button className="secondary-button" onClick={() => void onApply(profile.id)} disabled={busy || !profile.filePath}><FileCheck2 size={16} /> 应用</button><button className="icon-button danger" aria-label={`删除 ${profile.name}`} onClick={() => setConfirming(profile)} disabled={busy}><Trash2 size={16} /></button></div>
            </article>;
          })}
        </div>
      )}

      {confirming && <ConfirmDialog title={`删除「${confirming.name}」？`} message="这会移除本地 Profile 记录和已缓存的 YAML，不会修改当前正在运行的 Mihomo 配置。" confirmLabel="删除 Profile" danger onCancel={() => setConfirming(null)} onConfirm={() => void removeConfirmed()} />}
    </section>
  );
}

function NetworkCount({ count }: { count: number | null }) {
  return <><span className="network-count-dot" />{count === null ? "节点数待下载" : `${count} 个节点`}</>;
}
