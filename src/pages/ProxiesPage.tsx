import { ArrowDownAZ, Gauge, RefreshCw, Route, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProxiesResponse } from "../api/mihomo";
import { latencyTone } from "../utils/format";

const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance"]);
type SortMode = "name" | "delay";

export function ProxiesPage({ data, loading, busyProxy, delayByProxy, profilesLoaded, profileCount, onRefresh, onSelect, onDelay }: {
  data: ProxiesResponse | null;
  loading: boolean;
  busyProxy: string | null;
  delayByProxy: Record<string, number>;
  profilesLoaded: boolean;
  profileCount: number;
  onRefresh: () => void;
  onSelect: (group: string, proxy: string) => Promise<void>;
  onDelay: (proxy: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("name");
  const groups = useMemo(() => Object.entries(data?.proxies ?? {}).filter(([, value]) => GROUP_TYPES.has(value.type ?? "")), [data]);
  const filteredGroups = useMemo(() => groups.map(([name, group]) => {
    const candidates = (group.all ?? []).filter((proxy) => !query.trim() || `${name} ${proxy}`.toLowerCase().includes(query.trim().toLowerCase()));
    const sorted = [...candidates].sort((a, b) => sort === "delay"
      ? (delayByProxy[a] ?? Number.POSITIVE_INFINITY) - (delayByProxy[b] ?? Number.POSITIVE_INFINITY)
      : a.localeCompare(b));
    return [name, group, sorted] as const;
  }).filter(([, , proxies]) => proxies.length > 0), [delayByProxy, groups, query, sort]);
  const totalNodes = groups.reduce((total, [, group]) => total + (group.all?.length ?? 0), 0);

  return (
    <section className="page-stack proxies-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">PROXIES / ROUTES</p>
          <h1>节点</h1>
          <p>选择当前路由，测速结果会保留在本次运行中，帮助你快速找到更稳定的节点。</p>
        </div>
        <button className="secondary-button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={17} className={loading ? "spin" : ""} /> 刷新
        </button>
      </header>

      <div className="page-summary-row"><div><strong>{totalNodes}</strong><span>个节点</span><i /> <strong>{groups.length}</strong><span>个代理组</span></div><span>{profileCount ? `${profileCount} 个 Profile 已载入` : "未载入订阅"}</span></div>

      {groups.length > 0 && <div className="proxy-toolbar panel">
        <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点或代理组" /></label>
        <div className="sort-switch"><SlidersHorizontal size={15} /><span>排序</span><button className={sort === "name" ? "active" : ""} type="button" onClick={() => setSort("name")}><ArrowDownAZ size={14} />名称</button><button className={sort === "delay" ? "active" : ""} type="button" onClick={() => setSort("delay")}><Gauge size={14} />延迟</button></div>
      </div>}

      {groups.length === 0 ? (
        <div className="empty-card empty-card-large panel"><Route size={28} /><strong>{!profilesLoaded ? "正在读取 Profile" : profileCount === 0 ? "还没有订阅 Profile" : "暂无代理组"}</strong><p>{!profilesLoaded ? "MioProxy 正在准备订阅数据。" : profileCount === 0 ? "先去订阅页面添加并下载一个 Profile，节点会自动出现在这里。" : "当前配置暂时没有可选择的代理组。"}</p></div>
      ) : filteredGroups.length === 0 ? (
        <div className="empty-card empty-card-large panel"><Search size={28} /><strong>没有匹配节点</strong><p>换一个关键词，或清空搜索条件。</p></div>
      ) : (
        <div className="proxy-group-list">
          {filteredGroups.map(([name, group, proxies]) => <article className="proxy-card panel" key={name}>
            <div className="proxy-card-head"><div><span>{group.type} · {proxies.length} / {group.all?.length ?? 0}</span><strong>{name}</strong></div><em>{group.now ?? "未选择"}</em></div>
            <div className="chip-row">
              {proxies.map((proxy) => {
                const delay = delayByProxy[proxy];
                const selecting = busyProxy === `${name}:${proxy}`;
                const testing = busyProxy === `delay:${proxy}`;
                const tone = latencyTone(delay);
                return <span className="chip-with-actions" key={proxy}>
                  <button className={proxy === group.now ? "chip selected" : "chip"} onClick={() => void onSelect(name, proxy)} disabled={busyProxy !== null}>{selecting ? "切换中…" : proxy}{proxy === group.now && <b className="selected-mark">当前</b>}</button>
                  <button className={`delay-button latency-${tone}`} onClick={() => void onDelay(proxy)} disabled={busyProxy !== null}>{testing ? <span className="loading-dots">···</span> : delay ? `${delay} ms` : "测速"}</button>
                </span>;
              })}
            </div>
          </article>)}
        </div>
      )}
    </section>
  );
}
