import { Check, Database, RefreshCw, Save, Server, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { mihomoApi, type DnsSettings } from "../api/mihomo";
import { useI18n } from "../i18n/I18nProvider";

const EMPTY_DNS: DnsSettings = {
  enabled: false,
  enhancedMode: "redir-host",
  defaultNameserver: [],
  nameserver: [],
  fallback: [],
  fakeIpFilterMode: "blacklist",
  fakeIpFilter: [],
};

function lines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function text(values: string[]) {
  return values.join("\n");
}

export function DnsPage({ profileId }: { profileId: string | null }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<DnsSettings>(EMPTY_DNS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    setError(null);
    try {
      setSettings(await mihomoApi.dnsGet(profileId));
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
      await mihomoApi.dnsSet(settings);
      setMessage(t("dns.saved"));
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
      const result = await mihomoApi.configApply(profileId);
      setMessage(result.controllerValidated ? t("dns.applied") : t("dns.applyPending"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setApplying(false);
    }
  }

  if (!profileId) {
    return <section className="page-stack"><header className="page-header"><div><p className="eyebrow">{t("dns.eyebrow")}</p><h1>{t("dns.title")}</h1><p>{t("dns.noProfileDescription")}</p></div></header><div className="empty-card empty-card-large panel"><Server size={28} /><strong>{t("dns.noProfileTitle")}</strong><p>{t("dns.noProfileHelp")}</p></div></section>;
  }

  return (
    <section className="page-stack dns-page">
      <header className="page-header"><div><p className="eyebrow">{t("dns.eyebrow")}</p><h1>{t("dns.title")}</h1><p>{t("dns.description")}</p></div><button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? "spin" : ""} />{t("dns.reload")}</button></header>
      {error && <div className="error-banner" role="alert"><ShieldCheck size={17} /><span>{error}</span></div>}
      {message && <div className="success-banner" role="status"><Check size={17} /><span>{message}</span></div>}

      <div className="config-flow panel"><span className="flow-step active">1 <b>{t("dns.flowEdit")}</b></span><i aria-hidden="true">→</i><span className="flow-step">2 <b>{t("dns.flowSaveOverride")}</b></span><i aria-hidden="true">→</i><span className="flow-step">3 <b>{t("dns.flowValidateLoad")}</b></span></div>

      <div className="dns-form-grid">
        <section className="dns-card panel"><div className="section-heading"><div><span>{t("dns.engine")}</span><strong>{t("dns.resolutionMode")}</strong></div><Database size={17} /></div><label className="switch-row"><span><strong>{t("dns.enable")}</strong><small>{t("dns.disabledDescription")}</small></span><button className={settings.enabled ? "switch on" : "switch"} type="button" onClick={() => setSettings((current) => ({ ...current, enabled: !current.enabled }))} aria-label={t("dns.enable")} aria-pressed={settings.enabled}><i /></button></label><label className="field-label"><span>{t("dns.enhancedMode")}</span><select value={settings.enhancedMode} onChange={(event) => setSettings((current) => ({ ...current, enhancedMode: event.target.value }))}><option value="redir-host">redir-host</option><option value="fake-ip">fake-ip</option></select></label><label className="field-label"><span>{t("dns.fakeIpFilterMode")}</span><select value={settings.fakeIpFilterMode} onChange={(event) => setSettings((current) => ({ ...current, fakeIpFilterMode: event.target.value }))}><option value="blacklist">blacklist</option><option value="whitelist">whitelist</option><option value="rule">rule</option></select></label></section>

        <section className="dns-card panel"><div className="section-heading"><div><span>{t("dns.servers")}</span><strong>{t("dns.nameserverFallback")}</strong></div><Server size={17} /></div><label className="field-label"><span>Default Nameserver <small>{t("dns.defaultNameserverLineHint")}</small></span><textarea value={text(settings.defaultNameserver)} onChange={(event) => setSettings((current) => ({ ...current, defaultNameserver: lines(event.target.value) }))} placeholder="223.5.5.5\nhttps://dns.alidns.com/dns-query" /></label><label className="field-label"><span>Nameserver <small>{t("dns.nameserverPrimaryHint")}</small></span><textarea value={text(settings.nameserver)} onChange={(event) => setSettings((current) => ({ ...current, nameserver: lines(event.target.value) }))} placeholder="https://doh.pub/dns-query" /></label><label className="field-label"><span>Fallback <small>{t("dns.fallbackBackupHint")}</small></span><textarea value={text(settings.fallback)} onChange={(event) => setSettings((current) => ({ ...current, fallback: lines(event.target.value) }))} placeholder="tls://1.1.1.1" /></label></section>

        <section className="dns-card panel dns-card-wide"><div className="section-heading"><div><span>{t("dns.fakeIpFilter")}</span><strong>{t("dns.fakeIpFilterDescription")}</strong></div><span className="field-hint">{t("dns.fakeIpFilterHint")}</span></div><textarea className="filter-editor" value={text(settings.fakeIpFilter)} onChange={(event) => setSettings((current) => ({ ...current, fakeIpFilter: lines(event.target.value) }))} placeholder="*.lan\n+.local\nlocalhost" aria-label={t("dns.fakeIpFilter")} /><div className="dns-card-footer"><span>{t("dns.filterCount", { count: settings.fakeIpFilter.length })}</span><div><button className="secondary-button" type="button" onClick={() => void save()} disabled={saving || applying}><Save size={16} />{saving ? t("dns.saving") : t("dns.saveOverride")}</button><button className="primary-button" type="button" onClick={() => void apply()} disabled={applying || saving}><ShieldCheck size={16} />{applying ? t("dns.validating") : t("dns.validateApply")}</button></div></div></section>
      </div>
    </section>
  );
}
