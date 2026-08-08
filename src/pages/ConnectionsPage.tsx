import { Eye, RefreshCw, Search, ShieldClose, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ConnectionsResponse, MihomoConnection } from "../api/mihomo";
import { formatBytes } from "../utils/format";

function processName(connection: MihomoConnection) {
  if (connection.metadata.process) return connection.metadata.process;
  const path = connection.metadata.processPath;
  return path ? path.split(/[\\/]/).pop() ?? path : "未知应用";
}

function connectionTarget(connection: MihomoConnection) {
  const host = connection.metadata.host || connection.metadata.destinationIp || "未知目标";
  return connection.metadata.destinationPort ? `${host}:${connection.metadata.destinationPort}` : host;
}

function connectionNode(connection: MihomoConnection) {
  return connection.chains.at(-1) ?? "DIRECT";
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function ConnectionDetails({ connection, onClose }: { connection: MihomoConnection; onClose: () => void }) {
  return (
    <aside className="connection-detail">
      <div className="detail-heading"><div><span>CONNECTION DETAIL</span><strong>{processName(connection)}</strong></div><button className="icon-button" onClick={onClose} aria-label="关闭详情"><X size={17} /></button></div>
      <dl>
        <div><dt>目标</dt><dd>{connectionTarget(connection)}</dd></div>
        <div><dt>网络</dt><dd>{connection.metadata.network || "—"}</dd></div>
        <div><dt>规则</dt><dd>{connection.rule || "—"}{connection.rulePayload ? ` · ${connection.rulePayload}` : ""}</dd></div>
        <div><dt>节点链路</dt><dd>{connection.chains.join(" → ") || "DIRECT"}</dd></div>
        <div><dt>上传 / 下载</dt><dd>{formatBytes(connection.upload)} / {formatBytes(connection.download)}</dd></div>
        <div><dt>进程路径</dt><dd className="break-all">{connection.metadata.processPath || "—"}</dd></div>
        <div><dt>连接 ID</dt><dd className="break-all">{connection.id}</dd></div>
      </dl>
    </aside>
  );
}

export function ConnectionsPage({
  state,
  onRefresh,
  onClose,
  onCloseAll,
}: {
  state: { data: ConnectionsResponse | null; loading: boolean; error: string | null };
  onRefresh: () => Promise<void>;
  onClose: (id: string) => Promise<void>;
  onCloseAll: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState("all");
  const [nodeFilter, setNodeFilter] = useState("all");
  const [ruleFilter, setRuleFilter] = useState("all");
  const [selected, setSelected] = useState<MihomoConnection | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const connections = state.data?.connections ?? [];
  const apps = useMemo(() => unique(connections.map(processName)), [connections]);
  const nodes = useMemo(() => unique(connections.map(connectionNode)), [connections]);
  const rules = useMemo(() => unique(connections.map((connection) => connection.rule || "DIRECT")), [connections]);
  const visible = useMemo(() => connections.filter((connection) => {
    const haystack = `${processName(connection)} ${connectionTarget(connection)} ${connection.rule} ${connectionNode(connection)}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase()))
      && (appFilter === "all" || processName(connection) === appFilter)
      && (nodeFilter === "all" || connectionNode(connection) === nodeFilter)
      && (ruleFilter === "all" || (connection.rule || "DIRECT") === ruleFilter);
  }), [appFilter, connections, nodeFilter, query, ruleFilter]);

  async function closeConnection(connection: MihomoConnection) {
    setBusyId(connection.id);
    try {
      await onClose(connection.id);
      if (selected?.id === connection.id) setSelected(null);
    } finally {
      setBusyId(null);
    }
  }

  async function closeAll() {
    if (!window.confirm("确认关闭全部活动连接吗？")) return;
    setBusyId("all");
    try {
      await onCloseAll();
      setSelected(null);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="page-stack connections-page">
      <header className="page-header">
        <div><p className="eyebrow">CONNECTIONS / LIVE</p><h1>连接</h1><p>通过 Mihomo <code>/connections</code> 观察、筛选和关闭活动连接。</p></div>
        <div className="header-actions"><button className="secondary-button" onClick={() => void onRefresh()} disabled={state.loading}><RefreshCw size={17} className={state.loading ? "spin" : ""} />刷新</button><button className="danger-button" onClick={() => void closeAll()} disabled={!connections.length || busyId !== null}><ShieldClose size={17} />关闭全部</button></div>
      </header>

      {state.error && <div className="error-banner">{state.error}</div>}

      <div className="connection-toolbar">
        <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索应用、目标、规则或节点" /></label>
        <select value={appFilter} onChange={(event) => setAppFilter(event.target.value)}><option value="all">所有应用</option>{apps.map((value) => <option key={value}>{value}</option>)}</select>
        <select value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)}><option value="all">所有节点</option>{nodes.map((value) => <option key={value}>{value}</option>)}</select>
        <select value={ruleFilter} onChange={(event) => setRuleFilter(event.target.value)}><option value="all">所有规则</option>{rules.map((value) => <option key={value}>{value}</option>)}</select>
      </div>

      <div className="connection-count"><span>{visible.length} visible / {connections.length} active</span><small>↓ {formatBytes(state.data?.downloadTotal)} · ↑ {formatBytes(state.data?.uploadTotal)}</small></div>

      {visible.length === 0 ? <div className="empty-card"><NetworkIcon /><strong>{connections.length ? "没有匹配的连接" : "暂无活动连接"}</strong><p>{connections.length ? "调整搜索或筛选条件。" : "启动 Mihomo 并产生网络请求后，活动连接会实时出现在这里。"}</p></div> : (
        <div className="connection-table-wrap"><table className="connection-table"><thead><tr><th>应用</th><th>目标</th><th>规则</th><th>节点</th><th>流量</th><th /></tr></thead><tbody>{visible.map((connection) => <tr key={connection.id}>
          <td><strong>{processName(connection)}</strong><small>{connection.metadata.network || "TCP"}</small></td><td><span className="target-cell">{connectionTarget(connection)}</span><small>{connection.metadata.sourceIp || "—"}</small></td><td><span className="rule-badge">{connection.rule || "DIRECT"}</span><small>{connection.rulePayload || "匹配规则"}</small></td><td><span className={connectionNode(connection) === "DIRECT" ? "node-cell direct" : "node-cell"}>{connectionNode(connection)}</span><small>{connection.chains.length > 1 ? `${connection.chains.length} hops` : "direct path"}</small></td><td><strong>{formatBytes(connection.download + connection.upload)}</strong><small>↓ {formatBytes(connection.download)} · ↑ {formatBytes(connection.upload)}</small></td><td><div className="row-actions"><button className="icon-button" onClick={() => setSelected(connection)} aria-label="查看详情"><Eye size={16} /></button><button className="icon-button danger" onClick={() => void closeConnection(connection)} disabled={busyId !== null} aria-label="关闭连接"><X size={16} /></button></div></td>
        </tr>)}</tbody></table></div>
      )}

      {selected && <ConnectionDetails connection={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

function NetworkIcon() {
  return <span className="empty-icon">⌁</span>;
}
