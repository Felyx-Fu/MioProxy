import { Download, RefreshCw, Search, ShieldAlert, SlidersHorizontal, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import type { Profile } from "../api/mihomo";
import { ConfirmDialog } from "../components/Feedback";
import type { Page } from "../components/Sidebar";
import { useI18n } from "../i18n/I18nProvider";

function sourceHost(value: string) { try { return new URL(value).hostname; } catch { return "—"; } }

export function ProfilesPage({ profiles, selectedId, appliedId, busyId, error, onSelect, onAdd, onDownload, onApply, onRemove, onNavigate }: {
  profiles: Profile[]; selectedId: string | null; appliedId: string | null; busyId: string | null; error: string | null;
  onSelect: (id: string) => void; onAdd: (name: string, url: string) => Promise<void>;
  onDownload: (id: string) => Promise<void>; onApply: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>; onNavigate: (page: Page) => void;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const [confirming, setConfirming] = useState<Profile | null>(null);
  const visible = useMemo(() => profiles.filter(profile => `${profile.name} ${sourceHost(profile.url)}`.toLowerCase().includes(query.trim().toLowerCase())), [profiles, query]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submission.current) return;
    submission.current = true;
    setSubmitting(true);
    try { await onAdd(name.trim() || sourceHost(url.trim()), url.trim()); setName(""); setUrl(""); }
    catch { /* App owns error feedback; preserve input for retry. */ }
    finally { submission.current = false; setSubmitting(false); }
  }
  async function removeConfirmed() {
    if (!confirming) return;
    try { await onRemove(confirming.id); } finally { setConfirming(null); }
  }
  return <section className="page-stack subscriptions-page">
    <header className="page-header compact-header"><div><h1>{t("profiles.title")}</h1><p>{t("subscriptions.flow")}</p></div></header>
    {error && <div className="info-bar error" role="alert"><ShieldAlert size={16} /><span>{error}</span></div>}
    <form className="subscription-import surface-panel" onSubmit={submit}>
      <label className="subscription-url"><span>{t("profiles.field.subscriptionUrl")}</span><input type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/subscribe" /></label>
      <label><span>{t("subscriptions.optionalName")}</span><input value={name} onChange={event => setName(event.target.value)} placeholder={t("profiles.field.namePlaceholder")} /></label>
      <button type="submit" className="primary-button" disabled={submitting || busyId !== null || !url.trim()}><Download size={15} />{t(submitting ? "profiles.state.adding" : "subscriptions.import")}</button>
    </form>
    {profiles.length > 0 && <label className="search-box subscription-search"><Search size={15} /><input data-page-search aria-label={t("profiles.search.label")} placeholder={t("profiles.search.placeholder")} value={query} onChange={event => setQuery(event.target.value)} /></label>}
    <div className="subscription-grid">
      {visible.map(profile => <article key={profile.id} className={`surface-panel subscription-card${profile.id === appliedId ? " is-active" : ""}`}>
        <div className="section-title-row"><h2>{profile.name}</h2>{profile.id === appliedId && <span className="state-value tone-success"><span className="state-dot" />{t("subscriptions.active")}</span>}</div>
        <p className="subscription-source">{sourceHost(profile.url)}</p>
        <dl className="home-facts"><div><dt>{t("profiles.details.lastUpdate")}</dt><dd>{profile.updatedAt ? new Date(profile.updatedAt * 1000).toLocaleString(locale) : t("profiles.state.neverUpdated")}</dd></div><div><dt>{t("profiles.details.nodeCount")}</dt><dd>{profile.nodeCount ?? "—"}</dd></div></dl>
        {!profile.filePath && <p className="home-caption">{t("subscriptions.needsDownload")}</p>}
        <div className="subscription-actions">
          <button type="button" className={profile.id === appliedId ? "secondary-button" : "primary-button"} disabled={!profile.filePath || busyId !== null || submitting || profile.id === appliedId} onClick={() => void onApply(profile.id)}>{t(busyId === profile.id ? "profiles.state.working" : profile.id === appliedId ? "subscriptions.active" : "subscriptions.activate")}</button>
          <button type="button" className="secondary-button" disabled={busyId !== null || submitting} onClick={() => void onDownload(profile.id)}><RefreshCw size={14} />{t(profile.filePath ? "profiles.action.update" : "subscriptions.download")}</button>
          <button type="button" className="quiet-button" disabled={busyId !== null} onClick={() => { onSelect(profile.id); onNavigate("overrides"); }}><SlidersHorizontal size={14} />{t("subscriptions.edit")}</button>
          <button type="button" className="icon-button danger" disabled={busyId !== null || submitting} aria-label={t("profiles.action.deleteNamed", { name: profile.name })} onClick={() => setConfirming(profile)}><Trash2 size={15} /></button>
        </div>
      </article>)}
    </div>
    {!visible.length && <div className="empty-card surface-panel"><Download size={28} /><strong>{t(profiles.length ? "profiles.empty.noSearchResults" : "profiles.empty.noProfiles")}</strong><p>{t("subscriptions.emptyHint")}</p></div>}
    {confirming && <ConfirmDialog title={t("profiles.confirm.title", { name: confirming.name })} message={t("profiles.confirm.message")} confirmLabel={t("profiles.action.delete")} danger onCancel={() => setConfirming(null)} onConfirm={() => void removeConfirmed()} />}
  </section>;
}
