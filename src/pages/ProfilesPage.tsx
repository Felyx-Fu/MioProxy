import { Download, FileCheck2, Plus, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";
import type { Profile } from "../api/mihomo";

export function ProfilesPage({
  profiles,
  busyId,
  error,
  onAdd,
  onDownload,
  onApply,
  onRemove,
}: {
  profiles: Profile[];
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onAdd(name, url);
      setName("");
      setUrl("");
    } catch {
      // The shared error banner carries the command error.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">PROFILES</p>
          <h1>订阅</h1>
          <p>添加订阅地址，下载原始 YAML，并保存到应用数据目录。配置应用后才会写入 Mihomo 当前配置。</p>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <form className="profile-form" onSubmit={submit}>
        <label>
          <span>Profile 名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的订阅" required />
        </label>
        <label className="profile-url-field">
          <span>订阅 URL</span>
          <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/subscribe" required />
        </label>
        <button className="power-button" type="submit" disabled={submitting}>
          <Plus size={17} /> {submitting ? "添加中…" : "添加 Profile"}
        </button>
      </form>

      {profiles.length === 0 ? (
        <div className="empty-card profile-empty">
          <Download size={28} />
          <strong>还没有 Profile</strong>
          <p>先添加一个 http/https 订阅地址，下载后再应用到 Mihomo。</p>
        </div>
      ) : (
        <div className="profile-list">
          {profiles.map((profile) => {
            const busy = busyId === profile.id;
            return (
              <article className="profile-card" key={profile.id}>
                <div className="profile-card-copy">
                  <span>{profile.filePath ? "已下载 YAML" : "尚未下载"}</span>
                  <strong>{profile.name}</strong>
                  <small>{profile.url}</small>
                  {profile.filePath && <small className="profile-path">{profile.filePath}</small>}
                </div>
                <div className="profile-actions">
                  <button className="secondary-button" onClick={() => void onDownload(profile.id)} disabled={busy}>
                    <Download size={16} /> {busy ? "处理中…" : "下载"}
                  </button>
                  <button className="secondary-button" onClick={() => void onApply(profile.id)} disabled={busy || !profile.filePath}>
                    <FileCheck2 size={16} /> 应用
                  </button>
                  <button className="icon-button danger" aria-label={`删除 ${profile.name}`} onClick={() => void onRemove(profile.id)} disabled={busy}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
