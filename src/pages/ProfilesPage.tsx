import { CalendarClock, Download, FileCheck2, Plus, RefreshCw, Search, ShieldAlert, SlidersHorizontal, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { Profile } from "../api/mihomo";
import { ConfirmDialog } from "../components/Feedback";
import type { Page } from "../components/Sidebar";
import { formatDate, maskUrl } from "../utils/format";

export function ProfilesPage({ profiles, selectedId, appliedId, busyId, error, onSelect, onAdd, onDownload, onApply, onRemove, onNavigate }: {
  profiles: Profile[];
  selectedId: string | null;
  appliedId: string | null;
  busyId: string | null;
  error: string | null;
  onSelect: (id: string) => void;
  onAdd: (name: string, url: string) => Promise<void>;
  onDownload: (id: string) => Promise<void>;
  onApply: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onNavigate: (page: Page) => void;
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState<Profile | null>(null);
  const visible = useMemo(() => profiles.filter((profile) => !query.trim() || profile.name.toLowerCase().includes(query.trim().toLowerCase())), [profiles, query]);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles[0] ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onAdd(name, url);
      setName("");
      setUrl("");
      setAdding(false);
    } catch {
      // Shared feedback presents the command error.
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
      <header className="page-header compact-header"><div><h1>Profiles</h1><p>Manage subscription sources and explicitly apply a cached runtime configuration.</p></div></header>
      {error && <div className="info-bar error" role="alert"><ShieldAlert size={16} /><span>{error}</span></div>}

      <div className="profiles-workspace split-workspace">
        <aside className="master-pane surface-panel" aria-label="Profiles">
          <div className="compact-toolbar profile-master-toolbar">
            <label className="search-box"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Profiles…" aria-label="Search Profiles" /></label>
            <button className="icon-button" type="button" onClick={() => setAdding((current) => !current)} aria-label="Add Profile" title="Add Profile"><Plus size={15} /></button>
          </div>
          <div className="master-list profile-master-list">
            {visible.map((profile) => (
              <button key={profile.id} type="button" className={selected?.id === profile.id ? "master-row selected" : "master-row"} onClick={() => onSelect(profile.id)}>
                <span><strong>{profile.name}</strong><small>{profile.filePath ? `${profile.nodeCount ?? "—"} nodes` : "Not downloaded"}</small></span>
                {appliedId === profile.id ? <em className="applied-mark">Session</em> : <em>{profile.filePath ? "Cached" : "—"}</em>}
              </button>
            ))}
            {!visible.length && <div className="pane-empty">{profiles.length ? "No Profiles match this search." : "No Profiles yet."}</div>}
          </div>
        </aside>

        <div className="profile-detail-stack">
          {adding && (
            <form className="surface-panel add-profile-panel" onSubmit={submit}>
              <div className="section-title-row"><div><h2>Add Profile</h2><p>The subscription address remains local and is masked in the interface.</p></div><button className="quiet-button" type="button" onClick={() => setAdding(false)}>Cancel</button></div>
              <div className="form-grid"><label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="My subscription" required /></label><label><span>Subscription URL</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/subscribe" required /></label><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Adding…" : "Add Profile"}</button></div>
            </form>
          )}

          {selected ? (
            <>
              <section className="surface-panel profile-detail-panel" aria-labelledby="profile-detail-heading">
                <div className="section-title-row"><div><h2 id="profile-detail-heading">Profile details</h2><p>{appliedId === selected.id ? "Applied in this session" : selected.id === selectedId ? "Selected for inspection" : "Profile"}</p></div><SlidersHorizontal size={17} /></div>
                <dl className="form-details">
                  <div><dt>Name</dt><dd>{selected.name}</dd></div>
                  <div><dt>Source</dt><dd>{maskUrl(selected.url)}</dd></div>
                  <div><dt>Cache</dt><dd>{selected.filePath ? "Downloaded" : "Not downloaded"}</dd></div>
                  <div><dt>Last update</dt><dd>{formatDate(selected.updatedAt)}</dd></div>
                  <div><dt>Node count</dt><dd>{selected.nodeCount ?? "—"}</dd></div>
                  <div><dt>Runtime state</dt><dd>{appliedId === selected.id ? "Applied this session" : "Active profile unavailable"}</dd></div>
                </dl>
                <div className="detail-actions">
                  <button className="primary-button" type="button" onClick={() => void onApply(selected.id)} disabled={!selected.filePath || busyId !== null}><FileCheck2 size={15} />{busyId === selected.id ? "Applying…" : "Apply"}</button>
                  <button className="secondary-button" type="button" onClick={() => void onDownload(selected.id)} disabled={busyId !== null}><RefreshCw size={15} />{busyId === selected.id ? "Working…" : "Update"}</button>
                  <button className="icon-button danger" type="button" onClick={() => setConfirming(selected)} disabled={busyId !== null} aria-label={`Delete ${selected.name}`} title="Delete Profile"><Trash2 size={15} /></button>
                </div>
              </section>

              <section className="surface-panel profile-advanced-panel">
                <div className="tab-strip" role="tablist" aria-label="Profile advanced tools"><button className="active" type="button" role="tab" aria-selected="true" onClick={() => onNavigate("overrides")}>Override rules</button><button type="button" role="tab" aria-selected="false" onClick={() => onNavigate("overrides")}>Runtime preview</button></div>
                <div className="advanced-summary"><div><strong>Local Override</strong><span>Inspect and edit the global local override, then preview it against the selected Profile.</span></div><button className="secondary-button" type="button" onClick={() => onNavigate("overrides")}>Open advanced editor</button></div>
              </section>
            </>
          ) : (
            <div className="empty-card surface-panel"><Download size={24} /><strong>Select or add a Profile</strong><p>Downloaded Profiles can be applied only after Mihomo validates the generated configuration.</p></div>
          )}
        </div>
      </div>

      <p className="contract-note"><CalendarClock size={13} /> “Session” is shown only after a successful apply in this application session; persisted active-profile status is not currently exposed to the UI.</p>
      {confirming && <ConfirmDialog title={`Delete “${confirming.name}”?`} message="This removes the local Profile record and cached YAML. It does not rewrite the configuration currently running in Mihomo." confirmLabel="Delete Profile" danger onCancel={() => setConfirming(null)} onConfirm={() => void removeConfirmed()} />}
    </section>
  );
}
