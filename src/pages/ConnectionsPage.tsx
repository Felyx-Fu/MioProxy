import { Eye, Pause, Play, RefreshCw, Search, ShieldClose, Unplug, X } from "lucide-react";
import { KeyboardEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import type { ConnectionsResponse, MihomoConnection } from "../api/mihomo";
import { ConfirmDialog } from "../components/Feedback";
import { ContextMenu } from "../components/ContextMenu";
import { useI18n } from "../i18n/I18nProvider";
import { formatBytes } from "../utils/format";

type SortKey = "host" | "process" | "network" | "rule" | "chain" | "upload" | "download";

function processName(connection: MihomoConnection) {
  if (connection.metadata.process) return connection.metadata.process;
  const path = connection.metadata.processPath;
  return path ? path.split(/[\\/]/).pop() ?? path : "—";
}

function connectionHost(connection: MihomoConnection) {
  return connection.metadata.host || connection.metadata.destinationIp || "—";
}

function connectionTarget(connection: MihomoConnection) {
  const host = connectionHost(connection);
  return connection.metadata.destinationPort ? `${host}:${connection.metadata.destinationPort}` : host;
}

function connectionChain(connection: MihomoConnection) {
  return connection.chains.length ? connection.chains.join(" → ") : "—";
}

function ConnectionDetails({ connection, busy, onDismiss, onCloseConnection }: { connection: MihomoConnection; busy: boolean; onDismiss: () => void; onCloseConnection: () => void }) {
  const { t, locale } = useI18n();
  return (
    <aside className="connection-detail surface-panel" aria-label={t("connections.details.label")}>
      <div className="section-title-row"><div><h2>{t("connections.details.title")}</h2><p>{processName(connection)}</p></div><button className="icon-button" type="button" onClick={onDismiss} aria-label={t("connections.action.closeInspector")} title={t("connections.action.closeInspector")}><X size={15} /></button></div>
      <dl className="detail-list">
        <div><dt>{t("connections.field.host")}</dt><dd>{connectionTarget(connection)}</dd></div>
        <div><dt>{t("connections.field.source")}</dt><dd>{connection.metadata.sourceIp || "—"}{connection.metadata.sourcePort ? `:${connection.metadata.sourcePort}` : ""}</dd></div>
        <div><dt>{t("connections.field.process")}</dt><dd>{processName(connection)}</dd></div>
        <div><dt>{t("connections.field.processPath")}</dt><dd className="break-all">{connection.metadata.processPath || "—"}</dd></div>
        <div><dt>{t("connections.field.network")}</dt><dd>{connection.metadata.network || "—"}</dd></div>
        <div><dt>{t("connections.field.rule")}</dt><dd>{connection.rule || "—"}{connection.rulePayload ? ` · ${connection.rulePayload}` : ""}</dd></div>
        <div><dt>{t("connections.field.chain")}</dt><dd>{connectionChain(connection)}</dd></div>
        <div><dt>{t("connections.field.started")}</dt><dd>{connection.start ? new Date(connection.start).toLocaleString(locale) : "—"}</dd></div>
        <div><dt>{t("connections.field.upload")}</dt><dd>{formatBytes(connection.upload)}</dd></div>
        <div><dt>{t("connections.field.download")}</dt><dd>{formatBytes(connection.download)}</dd></div>
      </dl>
      <button className="danger-button connection-close-action" type="button" onClick={onCloseConnection} disabled={busy}><ShieldClose size={15} />{t("connections.action.closeConnection")}</button>
    </aside>
  );
}

export function ConnectionsPage({ state, onRefresh, onClose, onCloseAll }: {
  state: { data: ConnectionsResponse | null; loading: boolean; error: string | null };
  onRefresh: () => Promise<void>;
  onClose: (id: string) => Promise<void>;
  onCloseAll: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [networkFilter, setNetworkFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("download");
  const [sortDescending, setSortDescending] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pausedSnapshot, setPausedSnapshot] = useState<MihomoConnection[]>([]);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; connection: MihomoConnection } | null>(null);

  const liveConnections = state.data?.connections ?? [];
  const connections = paused ? pausedSnapshot : liveConnections;
  const networks = useMemo(() => [...new Set(liveConnections.map((connection) => connection.metadata.network).filter(Boolean))].sort(), [liveConnections]);
  const visible = useMemo(() => {
    const filtered = connections.filter((connection) => {
      const haystack = `${processName(connection)} ${connectionTarget(connection)} ${connection.rule} ${connectionChain(connection)}`.toLowerCase();
      return (!query.trim() || haystack.includes(query.trim().toLowerCase())) && (networkFilter === "all" || connection.metadata.network === networkFilter);
    });
    const value = (connection: MihomoConnection): string | number => {
      if (sortKey === "host") return connectionHost(connection);
      if (sortKey === "process") return processName(connection);
      if (sortKey === "network") return connection.metadata.network || "";
      if (sortKey === "rule") return connection.rule || "";
      if (sortKey === "chain") return connectionChain(connection);
      return connection[sortKey];
    };
    return [...filtered].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      const compared = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
      return sortDescending ? -compared : compared;
    });
  }, [connections, networkFilter, query, sortDescending, sortKey]);
  const rendered = visible.slice(0, 250);
  const selected = connections.find((connection) => connection.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId || contextMenu) return;
    function closeInspector(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", closeInspector);
    return () => window.removeEventListener("keydown", closeInspector);
  }, [contextMenu, selectedId]);

  function changeSort(next: SortKey) {
    if (sortKey === next) setSortDescending((current) => !current);
    else {
      setSortKey(next);
      setSortDescending(next === "upload" || next === "download");
    }
  }

  function togglePaused() {
    setPaused((current) => {
      if (!current) setPausedSnapshot(liveConnections);
      return !current;
    });
  }

  async function closeConnection(connection: MihomoConnection) {
    setBusyId(connection.id);
    setCommandError(null);
    try {
      await onClose(connection.id);
      if (selectedId === connection.id) setSelectedId(null);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function closeAll() {
    setBusyId("all");
    setCommandError(null);
    try {
      await onCloseAll();
      setSelectedId(null);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
      setConfirmingAll(false);
    }
  }

  function tableKeyboard(event: KeyboardEvent<HTMLTableSectionElement>) {
    if (!rendered.length) return;
    const index = selected ? Math.max(0, rendered.findIndex((item) => item.id === selected.id)) : -1;
    if (event.key === "Delete" && selected) {
      event.preventDefault();
      void closeConnection(selected);
      return;
    }
    const next = event.key === "ArrowDown" ? Math.min(rendered.length - 1, index + 1) : event.key === "ArrowUp" ? Math.max(0, index - 1) : event.key === "Home" ? 0 : event.key === "End" ? rendered.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setSelectedId(rendered[next].id);
    document.getElementById(`connection-row-${next}`)?.focus();
  }

  function openContextMenu(event: MouseEvent, connection: MihomoConnection) {
    event.preventDefault();
    setSelectedId(connection.id);
    setContextMenu({ x: event.clientX, y: event.clientY, connection });
  }

  return (
    <section className="page-stack connections-page">
      <header className="page-header compact-header"><div><h1>{t("connections.title")}</h1><p>{state.data ? t("connections.summary.active", { count: liveConnections.length, download: formatBytes(state.data.downloadTotal), upload: formatBytes(state.data.uploadTotal) }) : t("connections.summary.waiting")}</p></div></header>
      {(state.error || commandError) && <div className="info-bar error" role="alert"><span>{commandError ?? state.error}</span></div>}

      <div className="compact-toolbar surface-panel connection-toolbar">
        <label className="search-box"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("connections.search.placeholder")} aria-label={t("connections.search.label")} /></label>
        <label className="select-field"><select value={networkFilter} onChange={(event) => setNetworkFilter(event.target.value)} aria-label={t("connections.filter.label")}><option value="all">{t("connections.filter.all")}</option>{networks.map((network) => <option key={network}>{network}</option>)}</select></label>
        <button className="toolbar-button" type="button" onClick={togglePaused}>{paused ? <Play size={15} /> : <Pause size={15} />}{t(paused ? "connections.action.resume" : "connections.action.pause")}</button>
        <button className="icon-button" type="button" onClick={() => void onRefresh()} disabled={state.loading} aria-label={t("connections.action.refresh")} title={t("connections.action.refresh")}><RefreshCw size={15} className={state.loading ? "spin" : ""} /></button>
        <button className="danger-button compact-action" type="button" onClick={() => setConfirmingAll(true)} disabled={!liveConnections.length || busyId !== null}><ShieldClose size={15} />{t("connections.action.closeAll")}</button>
      </div>

      <div className="connections-workspace">
        <div className="surface-panel compact-table-wrap connection-table-wrap">
          {rendered.length ? (
            <table className="compact-table connection-table">
              <thead><tr>{([['host', t("connections.field.host")], ['process', t("connections.field.process")], ['network', t("connections.field.network")], ['rule', t("connections.field.rule")], ['chain', t("connections.field.chain")], ['upload', t("connections.field.upload")], ['download', t("connections.field.download")]] as Array<[SortKey, string]>).map(([key, label]) => <th key={key}><button type="button" onClick={() => changeSort(key)}>{label}{sortKey === key ? sortDescending ? " ↓" : " ↑" : ""}</button></th>)}</tr></thead>
              <tbody tabIndex={0} onKeyDown={tableKeyboard}>
                {rendered.map((connection, index) => (
                  <tr id={`connection-row-${index}`} key={connection.id} tabIndex={-1} className={selected?.id === connection.id ? "selected-row" : ""} onClick={() => setSelectedId(connection.id)} onContextMenu={(event) => openContextMenu(event, connection)}>
                    <td title={connectionTarget(connection)}>{connectionHost(connection)}</td>
                    <td title={connection.metadata.processPath || undefined}>{processName(connection)}</td>
                    <td>{connection.metadata.network || "—"}</td>
                    <td title={connection.rulePayload || undefined}>{connection.rule || "—"}</td>
                    <td title={connectionChain(connection)}>{connectionChain(connection)}</td>
                    <td>{formatBytes(connection.upload)}</td>
                    <td>{formatBytes(connection.download)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="table-empty"><Unplug size={20} /><strong>{t(liveConnections.length ? "connections.empty.filterTitle" : "connections.empty.noActiveTitle")}</strong><span>{t(liveConnections.length ? "connections.empty.filterDescription" : "connections.empty.noActiveDescription")}</span></div>}
          {visible.length > rendered.length && <div className="table-limit-note">{t("connections.limit", { count: visible.length })}</div>}
        </div>
        {selected
          ? <ConnectionDetails connection={selected} busy={busyId !== null} onDismiss={() => setSelectedId(null)} onCloseConnection={() => void closeConnection(selected)} />
          : <aside className="connection-detail connection-detail-empty surface-panel" aria-label={t("connections.details.label")}><div className="table-empty"><Eye size={20} /><strong>{t("connections.empty.noSelectedTitle")}</strong><span>{t("connections.empty.noSelectedDescription")}</span></div></aside>}
      </div>

      {confirmingAll && <ConfirmDialog title={t("connections.confirm.title")} message={t("connections.confirm.message", { count: liveConnections.length })} confirmLabel={t("connections.action.closeAll")} danger onCancel={() => setConfirmingAll(false)} onConfirm={() => void closeAll()} />}
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} actions={[
        { label: t("connections.context.inspect"), icon: <Eye size={14} />, onSelect: () => setSelectedId(contextMenu.connection.id) },
        { label: t("connections.context.close"), icon: <X size={14} />, danger: true, disabled: busyId !== null, onSelect: () => void closeConnection(contextMenu.connection) },
      ]} />}
    </section>
  );
}
