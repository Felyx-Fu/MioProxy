import { Clipboard, Pause, Play, Search, Trash2 } from "lucide-react";
import { UIEvent, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, LogLevel } from "../hooks/useLogs";

const LEVELS: Array<"ALL" | LogLevel> = ["ALL", "INFO", "WARN", "ERROR", "DEBUG"];

function timeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

type LogsState = {
  entries: LogEntry[];
  paused: boolean;
  frozenEntries: LogEntry[];
  bufferedCount: number;
  clear: () => void;
  setPaused: (paused: boolean) => void;
};

export function LogsPage({ state }: { state: LogsState }) {
  const { entries, paused, frozenEntries, bufferedCount, clear, setPaused } = state;
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("ALL");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sourceEntries = paused ? frozenEntries : entries;
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return sourceEntries.filter((entry) => (level === "ALL" || entry.level === level) && (!term || entry.message.toLowerCase().includes(term)));
  }, [level, query, sourceEntries]);
  const rendered = visible.slice(-1000);
  useEffect(() => {
    if (!autoScroll || paused) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [autoScroll, paused, visible.length]);

  function togglePaused() {
    setPaused(!paused);
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 28;
    if (!paused && atBottom !== autoScroll) setAutoScroll(atBottom);
  }

  async function copyLogs() {
    await navigator.clipboard.writeText(visible.map((entry) => `${timeLabel(entry.timestamp)}  ${entry.level.padEnd(5)}  ${entry.message}`).join("\n"));
  }

  function clearLogs() {
    clear();
  }

  return (
    <section className="page-stack logs-page">
      <header className="page-header compact-header"><div><h1>Logs</h1><p>{paused ? `Paused · ${bufferedCount} buffered` : entries.length ? `${entries.length} buffered locally` : "Waiting for the first Mihomo log event"}</p></div></header>

      <div className="compact-toolbar surface-panel log-toolbar">
        <label className="search-box"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search logs…" aria-label="Search logs" /></label>
        <label className="select-field"><select value={level} onChange={(event) => setLevel(event.target.value as (typeof LEVELS)[number])} aria-label="Log level">{LEVELS.map((item) => <option key={item} value={item}>{item === "ALL" ? "All levels" : item}</option>)}</select></label>
        <button className="toolbar-button" type="button" onClick={togglePaused}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? `Resume${bufferedCount ? ` · ${bufferedCount}` : ""}` : "Pause"}</button>
        <label className="check-control"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} disabled={paused} />Auto-scroll</label>
        <button className="toolbar-button" type="button" onClick={() => void copyLogs()} disabled={!visible.length}><Clipboard size={15} />Copy</button>
        <button className="icon-button" type="button" onClick={clearLogs} disabled={!entries.length} aria-label="Clear logs" title="Clear logs"><Trash2 size={15} /></button>
      </div>

      {!autoScroll && !paused && <button className="resume-live" type="button" onClick={() => setAutoScroll(true)}>Resume live</button>}

      <div className="surface-panel log-table-wrap" ref={scrollRef} onScroll={handleScroll}>
        <table className="compact-table log-table">
          <thead><tr><th>Timestamp</th><th>Level</th><th>Message</th></tr></thead>
          <tbody>
            {rendered.map((entry, index) => (
              <tr key={`${entry.timestamp}-${index}`}>
                <td><time>{timeLabel(entry.timestamp)}</time></td>
                <td><span className={`log-level ${entry.level.toLowerCase()}`}>{entry.level}</span></td>
                <td className="log-message">{entry.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && <div className="table-empty"><span>{entries.length ? "No logs match the current search and level." : "Waiting for Mihomo logs…"}</span></div>}
        {visible.length > rendered.length && <div className="table-limit-note">Showing the latest 1,000 of {visible.length} matching log entries.</div>}
      </div>
    </section>
  );
}
