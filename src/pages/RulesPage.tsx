import { Database, RefreshCw, RotateCw, Search, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { mihomoApi, type MihomoRule, type RuleProvider, type RuleProvidersResponse } from "../api/mihomo";
import { useI18n } from "../i18n/I18nProvider";
import { formatBytes, formatDate } from "../utils/format";

function providerMap(value: RuleProvidersResponse): Record<string, RuleProvider> {
  const wrapped = value as { providers?: Record<string, RuleProvider> };
  return wrapped.providers ?? value as Record<string, RuleProvider>;
}

function rulePolicy(rule: MihomoRule) {
  return String(rule.proxy ?? "—");
}

function providerUpdated(provider: RuleProvider, locale: string, neverUpdated: string) {
  const value = provider.updatedAt ?? provider.updateAt;
  if (!value) return neverUpdated;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatDate(parsed, locale) : value;
}

export function RulesPage({ running }: { running: boolean }) {
  const { t, locale } = useI18n();
  const [rules, setRules] = useState<MihomoRule[]>([]);
  const [providers, setProviders] = useState<Record<string, RuleProvider>>({});
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [loading, setLoading] = useState(false);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!running) return;
    setLoading(true);
    setError(null);
    try {
      const [rulesResult, providersResult] = await Promise.all([mihomoApi.rules(), mihomoApi.ruleProviders()]);
      setRules(rulesResult.rules ?? []);
      setProviders(providerMap(providersResult));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [running]);

  useEffect(() => { void load(); }, [load]);

  const types = useMemo(() => [...new Set(rules.map((rule) => String(rule.type ?? "UNKNOWN")))].sort(), [rules]);
  const visible = useMemo(() => rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => {
    const haystack = `${rule.type ?? ""} ${rule.payload ?? ""} ${rulePolicy(rule)}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (type === "all" || String(rule.type ?? "UNKNOWN") === type);
  }), [query, rules, type]);

  async function updateProvider(name: string) {
    setBusyProvider(name);
    setError(null);
    setMessage(null);
    try {
      await mihomoApi.ruleProviderUpdate(name);
      setMessage(t("rules.providerRefreshed", { name }));
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyProvider(null);
    }
  }

  return (
    <section className="page-stack rules-page">
      <header className="page-header compact-header">
        <div><p className="eyebrow">{t("rules.eyebrow")}</p><h1>{t("rules.title")}</h1><p>{t("rules.description")}</p></div>
        <button className="secondary-button" type="button" onClick={() => void load()} disabled={!running || loading}><RefreshCw size={16} className={loading ? "spin" : ""} />{t("rules.refresh")}</button>
      </header>

      {error && <div className="error-banner"><Workflow size={17} /><span>{error}</span></div>}
      {message && <div className="success-banner"><Database size={17} /><span>{message}</span></div>}

      {!running ? <div className="empty-card empty-card-large panel"><Workflow size={28} /><strong>{t("rules.coreNotReady")}</strong><p>{t("rules.coreNotReadyDescription")}</p></div> : <>
        <div className="rules-overview-grid"><article className="metric-card panel"><Workflow size={19} /><div><span>{t("rules.currentRules")}</span><strong>{rules.length}</strong></div></article><article className="metric-card panel"><Database size={19} /><div><span>{t("rules.ruleProviders")}</span><strong>{Object.keys(providers).length}</strong></div></article><article className="metric-card panel"><RotateCw size={19} /><div><span>{t("rules.dataSource")}</span><strong>{t("rules.controller")}</strong></div></article></div>

        <div className="rules-toolbar panel"><label className="search-box"><Search size={16} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("rules.searchPlaceholder")} /></label><select value={type} onChange={(event) => setType(event.target.value)}><option value="all">{t("rules.allTypes")}</option>{types.map((item) => <option value={item} key={item}>{item}</option>)}</select></div>

        <section className="rules-section"><div className="section-heading"><div><span>{t("rules.configuredOrder")}</span><strong>{t("rules.ruleChain")}</strong></div><small>{visible.length} / {rules.length}</small></div><div className="rules-table-wrap panel"><table className="rules-table"><thead><tr><th>#</th><th>{t("rules.type")}</th><th>{t("rules.payload")}</th><th>{t("rules.policy")}</th></tr></thead><tbody>{visible.length === 0 ? <tr><td colSpan={4} className="table-empty">{t("rules.noMatches")}</td></tr> : visible.map(({ rule, index }) => <tr key={`${index}-${rule.type}-${rule.payload}`}><td className="rule-index">{index + 1}</td><td><span className="rule-type">{String(rule.type ?? "UNKNOWN")}</span></td><td><strong>{String(rule.payload || "—")}</strong>{rule.subRules?.length ? <small>{rule.subRules.join(" → ")}</small> : null}</td><td><span className="policy-pill">{rulePolicy(rule)}</span></td></tr>)}</tbody></table></div></section>

        <section className="rules-section"><div className="section-heading"><div><span>{t("rules.remoteSources")}</span><strong>{t("rules.providerStatus")}</strong></div><small>{t("rules.providerCount", { count: Object.keys(providers).length })}</small></div><div className="provider-grid">{Object.keys(providers).length === 0 ? <div className="empty-card panel"><Database size={24} /><strong>{t("rules.noProviders")}</strong><p>{t("rules.noProvidersDescription")}</p></div> : Object.entries(providers).map(([name, provider]) => <article className="provider-card panel" key={name}><div className="provider-card-main"><div className="provider-icon"><Database size={17} /></div><div><strong>{name}</strong><span>{provider.behavior ?? "unknown"} · {provider.format ?? provider.vehicleType ?? "yaml"}</span></div></div><div className="provider-meta"><span>{provider.size ? formatBytes(provider.size) : t("rules.unknownSize")}</span><span>{t("rules.updatedAt", { value: providerUpdated(provider, locale, t("rules.neverUpdated")) })}</span></div><button className="icon-button" type="button" onClick={() => void updateProvider(name)} disabled={busyProvider !== null} aria-label={t("rules.refreshProvider", { name })}><RefreshCw size={15} className={busyProvider === name ? "spin" : ""} /></button></article>)}</div></section>
      </>}
    </section>
  );
}
