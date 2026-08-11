import { ArrowDownAZ, Check, Eye, Gauge, LocateFixed, Network, RefreshCw, Search } from "lucide-react";
import { KeyboardEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import type { ProxiesResponse } from "../api/mihomo";
import { ContextMenu } from "../components/ContextMenu";
import { latencyTone } from "../utils/format";

const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance"]);
type SortMode = "name" | "delay";

export function ProxiesPage({ data, loading, busyProxy, delayByProxy, delayStatusByProxy, profilesLoaded, profileCount, onRefresh, onSelect, onDelay }: {
  data: ProxiesResponse | null;
  loading: boolean;
  busyProxy: string | null;
  delayByProxy: Record<string, number>;
  delayStatusByProxy: Record<string, "available" | "unavailable">;
  profilesLoaded: boolean;
  profileCount: number;
  onRefresh: () => void;
  onSelect: (group: string, proxy: string) => Promise<void>;
  onDelay: (proxy: string) => Promise<void>;
}) {
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
  const nodes = useMemo(() => {
    if (!selectedEntry) return [];
    const term = query.trim().toLowerCase();
    return [...(selectedEntry[1].all ?? [])]
      .filter((node) => !term || node.toLowerCase().includes(term))
      .sort((a, b) => sort === "delay"
        ? (delayByProxy[a] ?? Number.POSITIVE_INFINITY) - (delayByProxy[b] ?? Number.POSITIVE_INFINITY) || a.localeCompare(b)
        : a.localeCompare(b));
  }, [delayByProxy, query, selectedEntry, sort]);
  const selectedNode = inspectedNode && nodes.includes(inspectedNode) ? inspectedNode : selectedGroup?.now && nodes.includes(selectedGroup.now) ? selectedGroup.now : nodes[0] ?? null;
  const selectedNodeStatus = !selectedNode
    ? "—"
    : selectedNode === selectedGroup?.now
      ? "Selected"
      : delayStatusByProxy[selectedNode] === "unavailable"
        ? "Unavailable"
        : delayByProxy[selectedNode] === undefined
          ? "Not tested"
          : "Available";
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
        <div><h1>Proxies</h1><p>{data ? `${totalNodes} nodes across ${groups.length} groups` : "Waiting for the runtime proxy snapshot"}</p></div>
      </header>

      {groups.length === 0 ? (
        <div className="empty-card surface-panel"><Network size={24} /><strong>{!profilesLoaded ? "Loading Profiles" : profileCount === 0 ? "No Profiles yet" : "No proxy groups"}</strong><p>{!profilesLoaded ? "MioProxy is reading local profile metadata." : profileCount === 0 ? "Add and download a Profile before choosing a proxy." : "The current runtime configuration has no selectable groups."}</p></div>
      ) : (
        <div className="proxy-workspace split-workspace">
          <aside className="master-pane surface-panel" aria-label="Proxy groups">
            <div className="pane-heading"><div><span>Proxy groups</span><small>{groups.length}</small></div></div>
            <div className="master-list">
              {groups.map(([name, group]) => (
                <button key={name} type="button" className={selectedEntry?.[0] === name ? "master-row selected" : "master-row"} onClick={() => { setSelectedGroupName(name); setInspectedNode(null); }}>
                  <span><strong>{name}</strong><small>{group.type ?? "Group"}</small></span>
                  <em>{group.all?.length ?? 0}</em>
                </button>
              ))}
            </div>
          </aside>

          <div className="data-pane surface-panel">
            <div className="compact-toolbar">
              <label className="search-box"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes…" aria-label="Search nodes" /></label>
              <label className="select-field"><ArrowDownAZ size={14} /><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label="Sort nodes"><option value="name">Name</option><option value="delay">Latency</option></select></label>
              <button className="toolbar-button" type="button" onClick={() => selectedNode && void onDelay(selectedNode)} disabled={!selectedNode || busyProxy !== null}><Gauge size={15} />Test selected</button>
              <button className="icon-button" type="button" onClick={() => { if (selectedGroup?.now) setInspectedNode(selectedGroup.now); }} disabled={!selectedGroup?.now} aria-label="Locate selected node" title="Locate selected node"><LocateFixed size={15} /></button>
              <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh proxies" title="Refresh"><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
            </div>

            <div className="compact-table-wrap proxy-table-wrap">
              <table className="compact-table proxy-table">
                <thead><tr><th>Node</th><th>Type</th><th>Latency</th><th>Status</th></tr></thead>
                <tbody tabIndex={0} onKeyDown={moveSelection} aria-label="Nodes">
                  {nodes.map((node, index) => {
                    const delay = delayByProxy[node];
                    const active = node === selectedGroup?.now;
                    const inspecting = node === selectedNode;
                    const type = data?.proxies[node]?.type ?? "—";
                    const testing = busyProxy === `delay:${node}`;
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
                        <td><strong>{node}</strong>{active && <span className="row-badge">Selected</span>}</td>
                        <td>{type}</td>
                        <td><button className={`table-link latency-${delayStatusByProxy[node] === "unavailable" ? "slow" : latencyTone(delay)}`} type="button" onClick={(event) => { event.stopPropagation(); void onDelay(node); }} disabled={busyProxy !== null}>{testing ? "Testing…" : delayStatusByProxy[node] === "unavailable" ? "Retry" : delay === undefined ? "Test" : `${delay} ms`}</button></td>
                        <td>{selecting ? <StateText tone="warning">Switching</StateText> : delayStatusByProxy[node] === "unavailable" ? <StateText tone="error">Unavailable</StateText> : <StateText tone={delay === undefined ? "muted" : "success"}>{delay === undefined ? "Not tested" : "Available"}</StateText>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!nodes.length && <div className="table-empty"><Search size={18} /><span>No nodes match this search.</span></div>}
            </div>

            <footer className="detail-strip">
              <div><span>Selected node</span><strong>{selectedNode ?? "—"}</strong></div>
              <dl><div><dt>Group</dt><dd>{selectedEntry?.[0] ?? "—"}</dd></div><div><dt>Type</dt><dd>{selectedNode ? data?.proxies[selectedNode]?.type ?? "—" : "—"}</dd></div><div><dt>Latency</dt><dd>{selectedNode && delayByProxy[selectedNode] !== undefined ? `${delayByProxy[selectedNode]} ms` : "—"}</dd></div><div><dt>Status</dt><dd>{selectedNodeStatus}</dd></div></dl>
              <button className="primary-button" type="button" onClick={() => selectedNode && selectedEntry && void onSelect(selectedEntry[0], selectedNode)} disabled={!selectedNode || selectedNode === selectedGroup?.now || busyProxy !== null}>Use node</button>
            </footer>
          </div>
        </div>
      )}
      {contextMenu && selectedEntry && <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} actions={[
        { label: "Inspect", icon: <Eye size={14} />, onSelect: () => setInspectedNode(contextMenu.node) },
        { label: "Use node", icon: <Check size={14} />, disabled: contextMenu.node === selectedGroup?.now || busyProxy !== null, onSelect: () => void onSelect(selectedEntry[0], contextMenu.node) },
        { label: "Test latency", icon: <Gauge size={14} />, disabled: busyProxy !== null, onSelect: () => void onDelay(contextMenu.node) },
      ]} />}
    </section>
  );
}

function StateText({ tone, children }: { tone: "success" | "warning" | "error" | "muted"; children: React.ReactNode }) {
  return <span className={`state-text tone-${tone}`}><span className="state-dot" />{children}</span>;
}
