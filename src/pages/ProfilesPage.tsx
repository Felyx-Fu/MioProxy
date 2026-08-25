import { CalendarClock, Download, FileCheck2, Plus, RefreshCw, Search, ShieldAlert, SlidersHorizontal, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { Profile } from "../api/mihomo";
import { ConfirmDialog } from "../components/Feedback";
import type { Page } from "../components/Sidebar";
import { useI18n } from "../i18n/I18nProvider";

function formatProfileDate(value: number | null | undefined, locale: string, fallback: string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return new Date(value * 1000).toLocaleString(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function maskProfileUrl(value: string, fallback: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/…`;
  } catch {
    return fallback;
  }
}

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
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState<Profile | null>(null);
  const visible = useMemo(() => profiles.filter((profile) => !query.trim() || profile.name.toLowerCase().includes(query.trim().toLowerCase())), [profiles, query]);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles[0] ?? null;
  const selectedIsApplied = selected?.id === appliedId;
  const selectedIsInspected = selected?.id === selectedId;
  const selectedState = selectedIsApplied ? "applied" : selectedIsInspected ? "selected" : "neutral";

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
      <header className="page-header compact-header"><div><h1>{t("profiles.title")}</h1><p>{t("profiles.description")}</p></div></header>
      {error && <div className="info-bar error profiles-error-bar" role="alert"><ShieldAlert size={16} /><span>{error}</span></div>}

      <div className="profiles-workspace split-workspace">
        <aside className="master-pane profile-master-pane surface-panel" aria-label={t("profiles.title")}>
          <div className="compact-toolbar profile-master-toolbar">
            <label className="search-box"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("profiles.search.placeholder")} aria-label={t("profiles.search.label")} /></label>
            <button className="icon-button" type="button" onClick={() => setAdding((current) => !current)} aria-label={t("profiles.action.add")} title={t("profiles.action.add")}><Plus size={15} /></button>
          </div>
          <div className="master-list profile-master-list">
            {visible.map((profile) => {
              const isSelected = selected?.id === profile.id;
              const isApplied = appliedId === profile.id;
              const state = isApplied ? isSelected ? "active-selected" : "active" : isSelected ? "selected" : "idle";
              return (
                <button key={profile.id} type="button" className={`master-row profile-master-row${isSelected ? " selected" : ""}`} data-profile-state={state} aria-pressed={isSelected} onClick={() => onSelect(profile.id)}>
                  <span className="profile-master-copy"><strong className="profile-master-name">{profile.name}</strong><small className="profile-master-meta">{profile.filePath ? t("profiles.list.nodes", { count: profile.nodeCount ?? "—" }) : t("profiles.state.notDownloaded")}</small></span>
                  {isApplied ? <em className="profile-master-state applied-mark">{t("profiles.state.session")}</em> : <em className="profile-master-state">{profile.filePath ? t("profiles.state.cached") : "—"}</em>}
                </button>
              );
            })}
            {!visible.length && <div className="pane-empty profile-list-empty">{t(profiles.length ? "profiles.empty.noSearchResults" : "profiles.empty.noProfiles")}</div>}
          </div>
        </aside>

        <div className="profile-detail-stack">
          {adding && (
            <form className="surface-panel add-profile-panel profile-add-panel" onSubmit={submit}>
              <div className="section-title-row profile-add-header"><div><h2>{t("profiles.add.title")}</h2><p>{t("profiles.add.description")}</p></div><button className="quiet-button" type="button" onClick={() => setAdding(false)}>{t("profiles.action.cancel")}</button></div>
              <div className="form-grid profile-add-grid"><label className="profile-form-field"><span>{t("profiles.field.name")}</span><input className="profile-form-input" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("profiles.field.namePlaceholder")} required /></label><label className="profile-form-field"><span>{t("profiles.field.subscriptionUrl")}</span><input className="profile-form-input profile-url-input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/subscribe" required /></label><button className="primary-button" type="submit" disabled={submitting}>{t(submitting ? "profiles.state.adding" : "profiles.action.add")}</button></div>
            </form>
          )}

          {selected ? (
            <>
              <section className="surface-panel profile-detail-panel" data-profile-state={selectedState} aria-labelledby="profile-detail-heading">
                <div className="section-title-row profile-detail-header"><div className="profile-detail-heading"><span className="profile-section-kicker">{t("profiles.details.title")}</span><h2 id="profile-detail-heading">{selected.name}</h2><p>{t(selectedIsApplied ? "profiles.details.appliedSession" : selectedIsInspected ? "profiles.details.selectedInspection" : "profiles.details.profile")}</p></div><div className="profile-detail-status"><SlidersHorizontal size={17} aria-hidden="true" /><div className="profile-detail-badges">{selectedIsApplied && <span className="profile-state-badge profile-state-badge-active"><span className="state-dot" />{t("profiles.state.session")}</span>}<span className={`profile-state-badge ${selected.filePath ? "profile-state-badge-cached" : "profile-state-badge-missing"}`}><span className="state-dot" />{t(selected.filePath ? "profiles.state.downloaded" : "profiles.state.notDownloaded")}</span>{selectedIsInspected && !selectedIsApplied && <span className="profile-state-badge profile-state-badge-selected"><span className="state-dot" />{t("profiles.details.selectedInspection")}</span>}</div></div></div>
                <dl className="profile-detail-metrics">
                  <div><dt>{t("profiles.details.nodeCount")}</dt><dd>{selected.nodeCount ?? "—"}</dd></div>
                  <div><dt>{t("profiles.details.lastUpdate")}</dt><dd>{formatProfileDate(selected.updatedAt, locale, t("profiles.state.neverUpdated"))}</dd></div>
                </dl>
                <dl className="form-details profile-detail-facts">
                  <div><dt>{t("profiles.field.name")}</dt><dd>{selected.name}</dd></div>
                  <div><dt>{t("profiles.details.source")}</dt><dd>{maskProfileUrl(selected.url, t("profiles.details.hiddenSource"))}</dd></div>
                  <div><dt>{t("profiles.details.cache")}</dt><dd className={selected.filePath ? "profile-fact-value tone-success" : "profile-fact-value tone-muted"}>{t(selected.filePath ? "profiles.state.downloaded" : "profiles.state.notDownloaded")}</dd></div>
                  <div><dt>{t("profiles.details.runtimeState")}</dt><dd className={selectedIsApplied ? "profile-fact-value tone-success" : "profile-fact-value tone-muted"}>{t(selectedIsApplied ? "profiles.state.appliedSession" : "profiles.state.activeUnavailable")}</dd></div>
                </dl>
                <div className="detail-actions profile-detail-actions" aria-busy={busyId === selected.id}>
                  <button className={selectedIsApplied ? "secondary-button profile-apply-action is-applied" : "primary-button profile-apply-action"} type="button" onClick={() => void onApply(selected.id)} disabled={!selected.filePath || busyId !== null}><FileCheck2 size={15} />{t(busyId === selected.id ? "profiles.state.applying" : "profiles.action.apply")}</button>
                  <button className="secondary-button profile-update-action" type="button" onClick={() => void onDownload(selected.id)} disabled={busyId !== null}><RefreshCw size={15} />{t(busyId === selected.id ? "profiles.state.working" : "profiles.action.update")}</button>
                  <button className="icon-button danger profile-delete-action" type="button" onClick={() => setConfirming(selected)} disabled={busyId !== null} aria-label={t("profiles.action.deleteNamed", { name: selected.name })} title={t("profiles.action.delete")}><Trash2 size={15} /></button>
                </div>
              </section>

              <section className="surface-panel profile-advanced-panel" aria-label={t("profiles.advanced.label")}>
                <div className="tab-strip" role="tablist" aria-label={t("profiles.advanced.label")}><button className="active" type="button" role="tab" aria-selected="true" onClick={() => onNavigate("overrides")}>{t("profiles.advanced.overrideRules")}</button><button type="button" role="tab" aria-selected="false" onClick={() => onNavigate("overrides")}>{t("profiles.advanced.runtimePreview")}</button></div>
                <div className="advanced-summary profile-advanced-summary"><div><span className="profile-section-kicker">{t("profiles.advanced.label")}</span><strong>{t("profiles.advanced.localOverride")}</strong><span>{t("profiles.advanced.description")}</span></div><button className="secondary-button" type="button" onClick={() => onNavigate("overrides")}>{t("profiles.advanced.openEditor")}</button></div>
              </section>
            </>
          ) : (
            <div className="empty-card surface-panel"><Download size={24} /><strong>{t("profiles.empty.selectTitle")}</strong><p>{t("profiles.empty.selectDescription")}</p></div>
          )}
        </div>
      </div>

      <p className="contract-note"><CalendarClock size={13} /> {t("profiles.contractNote")}</p>
      {confirming && <ConfirmDialog title={t("profiles.confirm.title", { name: confirming.name })} message={t("profiles.confirm.message")} confirmLabel={t("profiles.action.delete")} danger onCancel={() => setConfirming(null)} onConfirm={() => void removeConfirmed()} />}
    </section>
  );
}
