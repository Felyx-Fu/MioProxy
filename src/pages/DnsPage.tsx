import { Check, Database, RefreshCw, Save, Server, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { mihomoApi, type DnsSettings } from "../api/mihomo";

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
      setMessage("DNS 设置已保存到 Local Override，尚未影响运行内核。");
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
      setMessage(result.controllerValidated ? "DNS 配置已通过 Mihomo 校验并加载。" : "DNS 配置未应用。请先启动 Mihomo 完成 Controller 校验。");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setApplying(false);
    }
  }

  if (!profileId) {
    return <section className="page-stack"><header className="page-header"><div><p className="eyebrow">DNS / RESOLUTION</p><h1>DNS</h1><p>管理本地 DNS Override，不直接修改订阅源。</p></div></header><div className="empty-card empty-card-large panel"><Server size={28} /><strong>还没有可用 Profile</strong><p>先在订阅页面添加并下载一个 Profile，DNS 编辑器会基于它生成最终配置。</p></div></section>;
  }

  return (
    <section className="page-stack dns-page">
      <header className="page-header"><div><p className="eyebrow">DNS / RESOLUTION</p><h1>DNS</h1><p>配置 fake-ip / redir-host、Nameserver、Fallback 和 Fake-IP Filter。修改先进入 Local Override。</p></div><button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? "spin" : ""} />重新读取</button></header>
      {error && <div className="error-banner"><ShieldCheck size={17} /><span>{error}</span></div>}
      {message && <div className="success-banner"><Check size={17} /><span>{message}</span></div>}

      <div className="config-flow panel"><span className="flow-step active">1 <b>编辑 DNS</b></span><i>→</i><span className="flow-step">2 <b>保存 Override</b></span><i>→</i><span className="flow-step">3 <b>Mihomo 校验并加载</b></span></div>

      <div className="dns-form-grid">
        <section className="dns-card panel"><div className="section-heading"><div><span>ENGINE</span><strong>解析模式</strong></div><Database size={17} /></div><label className="switch-row"><span><strong>启用 DNS</strong><small>关闭后使用系统 DNS</small></span><button className={settings.enabled ? "switch on" : "switch"} type="button" onClick={() => setSettings((current) => ({ ...current, enabled: !current.enabled }))} aria-pressed={settings.enabled}><i /></button></label><label className="field-label"><span>增强模式</span><select value={settings.enhancedMode} onChange={(event) => setSettings((current) => ({ ...current, enhancedMode: event.target.value }))}><option value="redir-host">redir-host</option><option value="fake-ip">fake-ip</option></select></label><label className="field-label"><span>Fake-IP Filter 模式</span><select value={settings.fakeIpFilterMode} onChange={(event) => setSettings((current) => ({ ...current, fakeIpFilterMode: event.target.value }))}><option value="blacklist">blacklist</option><option value="whitelist">whitelist</option><option value="rule">rule</option></select></label></section>

        <section className="dns-card panel"><div className="section-heading"><div><span>SERVERS</span><strong>Nameserver / Fallback</strong></div><Server size={17} /></div><label className="field-label"><span>Default Nameserver <small>每行一个地址</small></span><textarea value={text(settings.defaultNameserver)} onChange={(event) => setSettings((current) => ({ ...current, defaultNameserver: lines(event.target.value) }))} placeholder="223.5.5.5\nhttps://dns.alidns.com/dns-query" /></label><label className="field-label"><span>Nameserver <small>主解析服务器</small></span><textarea value={text(settings.nameserver)} onChange={(event) => setSettings((current) => ({ ...current, nameserver: lines(event.target.value) }))} placeholder="https://doh.pub/dns-query" /></label><label className="field-label"><span>Fallback <small>备用解析服务器</small></span><textarea value={text(settings.fallback)} onChange={(event) => setSettings((current) => ({ ...current, fallback: lines(event.target.value) }))} placeholder="tls://1.1.1.1" /></label></section>

        <section className="dns-card panel dns-card-wide"><div className="section-heading"><div><span>FAKE-IP FILTER</span><strong>不返回 Fake-IP 的匹配项</strong></div><span className="field-hint">支持域名通配和规则语法</span></div><textarea className="filter-editor" value={text(settings.fakeIpFilter)} onChange={(event) => setSettings((current) => ({ ...current, fakeIpFilter: lines(event.target.value) }))} placeholder="*.lan\n+.local\nlocalhost" /><div className="dns-card-footer"><span>当前 {settings.fakeIpFilter.length} 条过滤项</span><div><button className="secondary-button" type="button" onClick={() => void save()} disabled={saving || applying}><Save size={16} />{saving ? "保存中…" : "保存 Local Override"}</button><button className="primary-button" type="button" onClick={() => void apply()} disabled={applying || saving}><ShieldCheck size={16} />{applying ? "校验中…" : "校验并应用"}</button></div></div></section>
      </div>
    </section>
  );
}
