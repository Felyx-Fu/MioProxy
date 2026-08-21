import { Clipboard, Pause, Play, Search, Trash2 } from "lucide-react";
import { UIEvent, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, LogLevel } from "../hooks/useLogs";
import { useI18n } from "../i18n/I18nProvider";

const LEVELS: Array<"ALL" | LogLevel> = ["ALL", "INFO", "WARN", "ERROR", "DEBUG"];

function timeLabel(timestamp: number, locale: string) {
  return new Date(timestamp).toLocaleTimeString(locale, { hour12: false });
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
  const { t, locale } = useI18n();
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
    await navigator.clipboard.writeText(visible.map((entry) => `${timeLabel(entry.timestamp, locale)}  ${entry.level.padEnd(5)}  ${entry.message}`).join("\n"));
  }

  function clearLogs() {
    clear();
  }

  return (
    <section className="page-stack logs-page">
      <header className="page-header compact-header"><div><h1>{t("logs.title")}</h1><p>{paused ? t("logs.pausedSummary", { count: bufferedCount }) : entries.length ? t("logs.bufferedSummary", { count: entries.length }) : t("logs.waitingFirstEvent")}</p></div></header>

      <div className="compact-toolbar surface-panel log-toolbar">
        <label className="search-box"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("logs.searchPlaceholder")} aria-label={t("logs.searchAriaLabel")} /></label>
        <label className="select-field"><select value={level} onChange={(event) => setLevel(event.target.value as (typeof LEVELS)[number])} aria-label={t("logs.levelAriaLabel")}>{LEVELS.map((item) => <option key={item} value={item}>{item === "ALL" ? t("logs.allLevels") : item}</option>)}</select></label>
        <button className="toolbar-button" type="button" onClick={togglePaused}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? bufferedCount ? t("logs.resumeBuffered", { count: bufferedCount }) : t("logs.resume") : t("logs.pause")}</button>
        <label className="check-control"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} disabled={paused} />{t("logs.autoScroll")}</label>
        <button className="toolbar-button" type="button" onClick={() => void copyLogs()} disabled={!visible.length}><Clipboard size={15} />{t("logs.copy")}</button>
        <button className="icon-button" type="button" onClick={clearLogs} disabled={!entries.length} aria-label={t("logs.clearAriaLabel")} title={t("logs.clearAriaLabel")}><Trash2 size={15} /></button>
      </div>

      {!autoScroll && !paused && <button className="resume-live" type="button" onClick={() => setAutoScroll(true)}>{t("logs.resumeLive")}</button>}

      <div className="surface-panel log-table-wrap" ref={scrollRef} onScroll={handleScroll}>
        <table className="compact-table log-table">
          <thead><tr><th>{t("logs.timestamp")}</th><th>{t("logs.level")}</th><th>{t("logs.message")}</th></tr></thead>
          <tbody>
            {rendered.map((entry, index) => (
              <tr key={`${entry.timestamp}-${index}`}>
                <td><time>{timeLabel(entry.timestamp, locale)}</time></td>
                <td><span className={`log-level ${entry.level.toLowerCase()}`}>{entry.level}</span></td>
                <td className="log-message">{entry.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && <div className="table-empty"><span>{entries.length ? t("logs.noMatches") : t("logs.waiting")}</span></div>}
        {visible.length > rendered.length && <div className="table-limit-note">{t("logs.limitNote", { count: visible.length })}</div>}
      </div>
    </section>
  );
}
