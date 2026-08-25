import { Braces, Check, Eye, FileCode2, Save, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { mihomoApi, type ConfigPreview } from "../api/mihomo";
import { useI18n } from "../i18n/I18nProvider";

export function OverridesPage({ profileId }: { profileId: string | null }) {
  const { t } = useI18n();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [preview, setPreview] = useState<ConfigPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await mihomoApi.overrideGet();
      const next = snapshot.content || "";
      setContent(next);
      setSavedContent(next);
      if (profileId) setPreview(await mihomoApi.configPreview(profileId));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const snapshot = await mihomoApi.overrideSet(content);
      setSavedContent(snapshot.content);
      setMessage(t("overrides.saved"));
      if (profileId) setPreview(await mihomoApi.configPreview(profileId));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    if (!profileId) return;
    setApplying(true);
    setError(null);
    setMessage(null);
    try {
      if (content !== savedContent) {
        const snapshot = await mihomoApi.overrideSet(content);
        setSavedContent(snapshot.content);
      }
      const result = await mihomoApi.configApply(profileId);
      setMessage(result.controllerValidated ? t("overrides.applied") : t("overrides.applyPending"));
      setPreview(await mihomoApi.configPreview(profileId));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setApplying(false);
    }
  }

  async function previewConfig() {
    if (!profileId) return;
    setLoading(true);
    setError(null);
    try {
      if (content !== savedContent) {
        const snapshot = await mihomoApi.overrideSet(content);
        setSavedContent(snapshot.content);
      }
      setPreview(await mihomoApi.configPreview(profileId));
      setMessage(t("overrides.previewGenerated"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }

  if (!profileId) {
    return <section className="page-stack"><header className="page-header"><div><p className="eyebrow">{t("overrides.eyebrow")}</p><h1>{t("overrides.title")}</h1><p>{t("overrides.noProfileDescription")}</p></div></header><div className="empty-card empty-card-large panel"><Braces size={28} /><strong>{t("overrides.noProfileTitle")}</strong><p>{t("overrides.noProfileHelp")}</p></div></section>;
  }

  return (
    <section className="page-stack overrides-page">
      <header className="page-header"><div><p className="eyebrow">{t("overrides.eyebrow")}</p><h1>{t("overrides.title")}</h1><p>{t("overrides.description")}</p></div><div className="override-status"><span className={content === savedContent ? "saved-dot" : "dirty-dot"} />{content === savedContent ? t("overrides.statusSaved") : t("overrides.statusDirty")}</div></header>
      {error && <div className="error-banner" role="alert"><ShieldCheck size={17} /><span>{error}</span></div>}
      {message && <div className="success-banner" role="status"><Check size={17} /><span>{message}</span></div>}

      <div className="config-flow panel"><span className="flow-step active">1 <b>{t("overrides.flowSubscriptionProfile")}</b></span><i aria-hidden="true">+</i><span className="flow-step active">2 <b>{t("overrides.flowLocalOverride")}</b></span><i aria-hidden="true">→</i><span className="flow-step">3 <b>{t("overrides.flowConfigBuilder")}</b></span><i aria-hidden="true">→</i><span className="flow-step">4 <b>{t("overrides.flowValidateReload")}</b></span></div>

      <div className="override-layout"><section className="override-editor-card panel"><div className="editor-heading"><div><span>LOCAL-OVERRIDE.YAML</span><strong>{t("overrides.localLayer")}</strong></div><FileCode2 size={18} /></div><textarea className="override-editor" value={content} onChange={(event) => setContent(event.target.value)} placeholder={t("overrides.example")} aria-label={t("overrides.localLayer")} spellCheck={false} /><div className="editor-footer"><span>{t("overrides.storageNote")}</span><div><button className="secondary-button" type="button" onClick={() => void save()} disabled={saving || applying}><Save size={16} />{saving ? t("overrides.saving") : t("overrides.saveOverride")}</button><button className="secondary-button" type="button" onClick={() => void previewConfig()} disabled={loading || saving || applying}><Eye size={16} />{t("overrides.previewButton")}</button><button className="primary-button" type="button" onClick={() => void apply()} disabled={applying || saving}><ShieldCheck size={16} />{applying ? t("overrides.applying") : t("overrides.validateApply")}</button></div></div></section>

        <section className="preview-card panel"><div className="editor-heading"><div><span>{t("overrides.previewEyebrow")}</span><strong>{t("overrides.previewTitle")}</strong></div><span className={preview?.overrideActive ? "preview-badge active" : "preview-badge"}>{preview?.overrideActive ? t("overrides.previewMerged") : t("overrides.previewSubscriptionOnly")}</span></div>{preview ? <pre className="config-preview">{preview.yaml}</pre> : <div className="preview-empty"><Eye size={22} /><span>{t("overrides.previewEmpty")}</span></div>}</section></div>
    </section>
  );
}
