import { ArrowDownAZ, Check, Eye, Gauge, LocateFixed, Network, RefreshCw, Search } from "lucide-react";
import { KeyboardEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import type { ProxiesResponse, ProxyDelayContext } from "../api/mihomo";
import { ContextMenu } from "../components/ContextMenu";
import { useI18n } from "../i18n/I18nProvider";
import { latencyTone } from "../utils/format";
import { createProxyDelayContext, proxyDelayBusyKey, proxyDelayKey } from "../utils/latency";

const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance"]);
type SortMode = "name" | "delay";

export function ProxiesPage({ data, loading, busyProxy, delayByKey, delayStatusByKey, profilesLoaded, profileCount, onRefresh, onSelect, onDelay }: {
  data: ProxiesResponse | null;
  loading: boolean;
  busyProxy: string | null;
  delayByKey: Record<string, number>;
  delayStatusByKey: Record<string, "available" | "unavailable">;
  profilesLoaded: boolean;
  profileCount: number;
  onRefresh: () => void;
  onSelect: (group: string, proxy: string) => Promise<void>;
  onDelay: (context: ProxyDelayContext) => Promise<void>;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("name");
  const groups = useMemo(() => Object.entries(data?.proxies ?? {}).filter(([, value]) => GROUP_TYPES.has(value.type ?? "")), [data]);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null);
  const [inspectedNode, setInspectedNode] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: string } | null>(null);

  useEffect(() => {
    if (!groups.length) {
      setSelectedGroupName(null);
      setInspectedNode(null);
      return;
    }
    if (!selectedGroupName || !groups.some(([name]) => name === selectedGroupName)) setSelectedGroupName(groups[0][0]);
  }, [groups, selectedGroupName]);

  const selectedEntry = groups.find(([name]) => name === selectedGroupName) ?? groups[0] ?? null;
  const selectedGroup = selectedEntry?.[1] ?? null;
  const delayContextFor = (node: string | null): ProxyDelayContext | null => {
    if (!node || !selectedEntry) return null;
    return createProxyDelayContext(selectedEntry[0], selectedEntry[1], node, data?.proxies[node]);
  };
  const nodes = useMemo(() => {
    if (!selectedEntry) return [];
    const term = query.trim().toLowerCase();
    return [...(selectedEntry[1].all ?? [])]
      .filter((node) => !term || node.toLowerCase().includes(term))
      .sort((a, b) => sort === "delay"
        ? (delayByKey[proxyDelayKey(delayContextFor(a)!)] ?? Number.POSITIVE_INFINITY) - (delayByKey[proxyDelayKey(delayContextFor(b)!)] ?? Number.POSITIVE_INFINITY) || a.localeCompare(b)
        : a.localeCompare(b));
  }, [data, delayByKey, query, selectedEntry, sort]);
  const selectedNode = inspectedNode && nodes.includes(inspectedNode) ? inspectedNode : selectedGroup?.now && nodes.includes(selectedGroup.now) ? selectedGroup.now : nodes[0] ?? null;
  const selectedNodeContext = delayContextFor(selectedNode);
  const selectedNodeKey = selectedNodeContext ? proxyDelayKey(selectedNodeContext) : null;
  const selectedNodeDelay = selectedNodeKey ? delayByKey[selectedNodeKey] : undefined;
  const selectedNodeDelayStatus = selectedNodeKey ? delayStatusByKey[selectedNodeKey] : undefined;
  const selectedNodeStatus = !selectedNode
    ? "—"
    : selectedNode === selectedGroup?.now
      ? t("proxies.state.selected")
      : selectedNodeDelayStatus === "unavailable"
        ? t("proxies.state.unavailable")
        : selectedNodeDelay === undefined
          ? t("proxies.state.notTested")
          : t("proxies.state.available");
  const totalNodes = groups.reduce((total, [, group]) => total + (group.all?.length ?? 0), 0);

  function moveSelection(event: KeyboardEvent<HTMLTableSectionElement>) {
    if (!nodes.length) return;
    const currentIndex = Math.max(0, selectedNode ? nodes.indexOf(selectedNode) : 0);
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") nextIndex = Math.min(nodes.length - 1, currentIndex + 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = nodes.length - 1;
    else if (event.key === "Enter" && selectedNode && selectedEntry && busyProxy === null) {
      event.preventDefault();
      void onSelect(selectedEntry[0], selectedNode);
      return;
    } else return;
    event.preventDefault();
    setInspectedNode(nodes[nextIndex]);
    document.getElementById(`proxy-row-${nextIndex}`)?.focus();
  }

  function openContextMenu(event: MouseEvent, node: string) {
    event.preventDefault();
    setInspectedNode(node);
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  }

  return (
    <section className="page-stack proxies-page">
      <header className="page-header compact-header">
        <div><h1>{t("proxies.title")}</h1><p>{data ? t("proxies.description.count", { nodes: totalNodes, groups: groups.length }) : t("proxies.description.waiting")}</p></div>
      </header>

      {groups.length === 0 ? (
        <div className="empty-card surface-panel"><Network size={24} /><strong>{t(!profilesLoaded ? "proxies.empty.loadingTitle" : profileCount === 0 ? "proxies.empty.noProfilesTitle" : "proxies.empty.noGroupsTitle")}</strong><p>{t(!profilesLoaded ? "proxies.empty.loadingDescription" : profileCount === 0 ? "proxies.empty.noProfilesDescription" : "proxies.empty.noGroupsDescription")}</p></div>
      ) : (
        <div className="proxy-workspace split-workspace">
          <aside className="master-pane surface-panel" aria-label={t("proxies.groups.label")}>
            <div className="pane-heading"><div><span>{t("proxies.groups.label")}</span><small>{groups.length}</small></div></div>
            <div className="master-list">
              {groups.map(([name, group]) => (
                <button key={name} type="button" className={selectedEntry?.[0] === name ? "master-row selected" : "master-row"} onClick={() => { setSelectedGroupName(name); setInspectedNode(null); }}>
                  <span><strong>{name}</strong><small>{group.type ?? t("proxies.groups.fallbackType")}</small></span>
                  <em>{group.all?.length ?? 0}</em>
                </button>
              ))}
            </div>
          </aside>

          <div className="data-pane surface-panel">
            <div className="compact-toolbar">
              <label className="search-box"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("proxies.search.placeholder")} aria-label={t("proxies.search.label")} /></label>
              <label className="select-field"><ArrowDownAZ size={14} /><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label={t("proxies.sort.label")}><option value="name">{t("proxies.sort.name")}</option><option value="delay">{t("proxies.sort.latency")}</option></select></label>
              <button className="toolbar-button" type="button" onClick={() => selectedNodeContext && void onDelay(selectedNodeContext)} disabled={!selectedNodeContext || busyProxy !== null}><Gauge size={15} />{t("proxies.action.testSelected")}</button>
              <button className="icon-button" type="button" onClick={() => { if (selectedGroup?.now) setInspectedNode(selectedGroup.now); }} disabled={!selectedGroup?.now} aria-label={t("proxies.action.locate")} title={t("proxies.action.locate")}><LocateFixed size={15} /></button>
              <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label={t("proxies.action.refresh")} title={t("proxies.action.refresh")}><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
            </div>

            <div className="compact-table-wrap proxy-table-wrap">
              <table className="compact-table proxy-table">
                <thead><tr><th>{t("proxies.table.node")}</th><th>{t("proxies.table.type")}</th><th>{t("proxies.table.latency")}</th><th>{t("proxies.table.status")}</th></tr></thead>
                <tbody tabIndex={0} onKeyDown={moveSelection} aria-label={t("proxies.table.nodesLabel")}>
                  {nodes.map((node, index) => {
                    const delayContext = delayContextFor(node);
                    const delayKey = delayContext ? proxyDelayKey(delayContext) : null;
                    const delay = delayKey ? delayByKey[delayKey] : undefined;
                    const delayStatus = delayKey ? delayStatusByKey[delayKey] : undefined;
                    const active = node === selectedGroup?.now;
                    const inspecting = node === selectedNode;
                    const type = data?.proxies[node]?.type ?? "—";
                    const testing = delayContext ? busyProxy === proxyDelayBusyKey(delayContext) : false;
                    const selecting = busyProxy === `${selectedEntry?.[0]}:${node}`;
                    return (
                      <tr
                        id={`proxy-row-${index}`}
                        key={node}
                        tabIndex={-1}
                        className={`${inspecting ? "selected-row " : ""}${active ? "active-row" : ""}`}
                        onClick={() => setInspectedNode(node)}
                        onDoubleClick={() => selectedEntry && busyProxy === null && void onSelect(selectedEntry[0], node)}
                        onContextMenu={(event) => openContextMenu(event, node)}
                      >
                        <td><strong>{node}</strong>{active && <span className="row-badge">{t("proxies.state.selected")}</span>}</td>
                        <td>{type}</td>
                        <td><button className={`table-link latency-${delayStatus === "unavailable" ? "slow" : latencyTone(delay)}`} type="button" onClick={(event) => { event.stopPropagation(); if (delayContext) void onDelay(delayContext); }} disabled={busyProxy !== null}>{testing ? t("proxies.state.testing") : delayStatus === "unavailable" ? t("proxies.action.retry") : delay === undefined ? t("proxies.action.test") : `${delay} ms`}</button></td>
                        <td>{selecting ? <StateText tone="warning">{t("proxies.state.switching")}</StateText> : delayStatus === "unavailable" ? <StateText tone="error">{t("proxies.state.unavailable")}</StateText> : <StateText tone={delay === undefined ? "muted" : "success"}>{t(delay === undefined ? "proxies.state.notTested" : "proxies.state.available")}</StateText>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!nodes.length && <div className="table-empty"><Search size={18} /><span>{t("proxies.empty.noSearchResults")}</span></div>}
            </div>

            <footer className="detail-strip">
              <div><span>{t("proxies.details.selectedNode")}</span><strong>{selectedNode ?? "—"}</strong></div>
              <dl><div><dt>{t("proxies.details.group")}</dt><dd>{selectedEntry?.[0] ?? "—"}</dd></div><div><dt>{t("proxies.table.type")}</dt><dd>{selectedNode ? data?.proxies[selectedNode]?.type ?? "—" : "—"}</dd></div><div><dt>{t("proxies.table.latency")}</dt><dd>{selectedNodeDelay !== undefined ? `${selectedNodeDelay} ms` : "—"}</dd></div><div><dt>{t("proxies.table.status")}</dt><dd>{selectedNodeStatus}</dd></div></dl>
              <button className="primary-button" type="button" onClick={() => selectedNode && selectedEntry && void onSelect(selectedEntry[0], selectedNode)} disabled={!selectedNode || selectedNode === selectedGroup?.now || busyProxy !== null}>{t("proxies.action.useNode")}</button>
            </footer>
          </div>
        </div>
      )}
      {contextMenu && selectedEntry && <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} actions={[
        { label: t("proxies.context.inspect"), icon: <Eye size={14} />, onSelect: () => setInspectedNode(contextMenu.node) },
        { label: t("proxies.action.useNode"), icon: <Check size={14} />, disabled: contextMenu.node === selectedGroup?.now || busyProxy !== null, onSelect: () => void onSelect(selectedEntry[0], contextMenu.node) },
        { label: t("proxies.context.testLatency"), icon: <Gauge size={14} />, disabled: busyProxy !== null || !delayContextFor(contextMenu.node), onSelect: () => { const context = delayContextFor(contextMenu.node); if (context) void onDelay(context); } },
      ]} />}
    </section>
  );
}

function StateText({ tone, children }: { tone: "success" | "warning" | "error" | "muted"; children: React.ReactNode }) {
  return <span className={`state-text tone-${tone}`}><span className="state-dot" />{children}</span>;
}
