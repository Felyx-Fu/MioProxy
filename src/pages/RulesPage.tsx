import { Database, RefreshCw, RotateCw, Search, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { mihomoApi, type MihomoRule, type RuleProvider, type RuleProvidersResponse } from "../api/mihomo";
import { formatBytes, formatDate } from "../utils/format";

function providerMap(value: RuleProvidersResponse): Record<string, RuleProvider> {
  const wrapped = value as { providers?: Record<string, RuleProvider> };
  return wrapped.providers ?? value as Record<string, RuleProvider>;
}

function rulePolicy(rule: MihomoRule) {
  return String(rule.proxy ?? rule.policy ?? rule.target ?? "未指定");
}

function providerUpdated(provider: RuleProvider) {
  const value = provider.updatedAt ?? provider.updateAt;
  if (!value) return "尚未更新";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatDate(parsed) : value;
}

export function RulesPage({ running }: { running: boolean }) {
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
  const visible = useMemo(() => rules.filter((rule) => {
    const haystack = `${rule.type ?? ""} ${rule.payload ?? ""} ${rulePolicy(rule)}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (type === "all" || String(rule.type ?? "UNKNOWN") === type);
  }), [query, rules, type]);

  async function updateProvider(name: string) {
    setBusyProvider(name);
    setError(null);
    setMessage(null);
    try {
      await mihomoApi.ruleProviderUpdate(name);
      setMessage(`Rule Provider「${name}」已刷新`);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyProvider(null);
    }
  }

  return (
    <section className="page-stack rules-page">
      <header className="page-header">
        <div><p className="eyebrow">RULES / MATCHING</p><h1>规则</h1><p>查看 Mihomo 当前规则链、命中策略和 Rule Provider 状态，不直接修改订阅源。</p></div>
        <button className="secondary-button" type="button" onClick={() => void load()} disabled={!running || loading}><RefreshCw size={16} className={loading ? "spin" : ""} />刷新规则</button>
      </header>

      {error && <div className="error-banner"><Workflow size={17} /><span>{error}</span></div>}
      {message && <div className="success-banner"><Database size={17} /><span>{message}</span></div>}

      {!running ? <div className="empty-card empty-card-large panel"><Workflow size={28} /><strong>内核未运行</strong><p>启动 Mihomo 后，当前规则和 Rule Provider 会从 Controller API 加载。</p></div> : <>
        <div className="rules-overview-grid"><article className="metric-card panel"><Workflow size={19} /><div><span>当前规则</span><strong>{rules.length}</strong></div></article><article className="metric-card panel"><Database size={19} /><div><span>Rule Providers</span><strong>{Object.keys(providers).length}</strong></div></article><article className="metric-card panel"><RotateCw size={19} /><div><span>数据来源</span><strong>Controller</strong></div></article></div>

        <div className="rules-toolbar panel"><label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索规则、域名或命中策略" /></label><select value={type} onChange={(event) => setType(event.target.value)}><option value="all">所有类型</option>{types.map((item) => <option value={item} key={item}>{item}</option>)}</select></div>

        <section className="rules-section"><div className="section-heading"><div><span>LIVE MATCH TABLE</span><strong>当前规则链</strong></div><small>{visible.length} / {rules.length}</small></div><div className="rules-table-wrap panel"><table className="rules-table"><thead><tr><th>#</th><th>类型</th><th>匹配条件</th><th>命中策略</th></tr></thead><tbody>{visible.length === 0 ? <tr><td colSpan={4} className="table-empty">没有匹配的规则</td></tr> : visible.map((rule, index) => <tr key={`${index}-${rule.type}-${rule.payload}`}><td className="rule-index">{index + 1}</td><td><span className="rule-type">{String(rule.type ?? "UNKNOWN")}</span></td><td><strong>{String(rule.payload ?? "MATCH")}</strong>{rule.subRules?.length ? <small>{rule.subRules.join(" → ")}</small> : null}</td><td><span className="policy-pill">{rulePolicy(rule)}</span></td></tr>)}</tbody></table></div></section>

        <section className="rules-section"><div className="section-heading"><div><span>REMOTE SOURCES</span><strong>Rule Provider 状态</strong></div><small>{Object.keys(providers).length} providers</small></div><div className="provider-grid">{Object.keys(providers).length === 0 ? <div className="empty-card panel"><Database size={24} /><strong>没有 Rule Provider</strong><p>当前运行配置未声明远程规则集。</p></div> : Object.entries(providers).map(([name, provider]) => <article className="provider-card panel" key={name}><div className="provider-card-main"><div className="provider-icon"><Database size={17} /></div><div><strong>{name}</strong><span>{provider.behavior ?? "unknown"} · {provider.format ?? provider.vehicleType ?? "yaml"}</span></div></div><div className="provider-meta"><span>{provider.size ? formatBytes(provider.size) : "大小未知"}</span><span>更新于 {providerUpdated(provider)}</span></div><button className="icon-button" type="button" onClick={() => void updateProvider(name)} disabled={busyProvider !== null} aria-label={`刷新 ${name}`}><RefreshCw size={15} className={busyProvider === name ? "spin" : ""} /></button></article>)}</div></section>
      </>}
    </section>
  );
}
