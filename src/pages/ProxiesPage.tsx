import { RefreshCw, Route } from "lucide-react";
import type { ProxiesResponse } from "../api/mihomo";

const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance"]);

export function ProxiesPage({ data, loading, busyProxy, delayByProxy, onRefresh, onSelect, onDelay }: { data: ProxiesResponse | null; loading: boolean; busyProxy: string | null; delayByProxy: Record<string, number>; onRefresh: () => void; onSelect: (group: string, proxy: string) => Promise<void>; onDelay: (proxy: string) => Promise<void> }) {
  const groups = Object.entries(data?.proxies ?? {}).filter(([, value]) => GROUP_TYPES.has(value.type ?? ""));

  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">PROXIES</p>
          <h1>节点</h1>
          <p>这里的数据直接来自 Mihomo 的 <code>/proxies</code> Controller API。</p>
        </div>
        <button className="secondary-button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={17} className={loading ? "spin" : ""} /> 刷新
        </button>
      </header>

      {groups.length === 0 ? (
        <div className="empty-card">
          <Route size={28} />
          <strong>暂无代理组</strong>
          <p>默认配置只有 DIRECT。添加并下载 Profile 后，这里会出现订阅提供的代理组。</p>
        </div>
      ) : (
        <div className="proxy-grid">
          {groups.map(([name, group]) => (
            <article className="proxy-card" key={name}>
              <div className="proxy-card-head">
                <div><span>{group.type}</span><strong>{name}</strong></div>
                <em>{group.now ?? "—"}</em>
              </div>
              <div className="chip-row">
                {(group.all ?? []).slice(0, 8).map((proxy) => {
                  const delay = delayByProxy[proxy];
                  const selecting = busyProxy === `${name}:${proxy}`;
                  const testing = busyProxy === `delay:${proxy}`;
                  return (
                    <span className="chip-with-actions" key={proxy}>
                      <button className={proxy === group.now ? "chip selected" : "chip"} onClick={() => void onSelect(name, proxy)} disabled={busyProxy !== null}>{selecting ? "切换中…" : proxy}</button>
                      <button className="delay-button" onClick={() => void onDelay(proxy)} disabled={busyProxy !== null}>{testing ? "…" : delay ? `${delay} ms` : "测速"}</button>
                    </span>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
