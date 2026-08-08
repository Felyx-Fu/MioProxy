import { Clipboard, Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLogs, type LogLevel } from "../hooks/useLogs";

const LEVELS: Array<"ALL" | LogLevel> = ["ALL", "INFO", "WARN", "ERROR", "DEBUG"];

function timeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

export function LogsPage() {
  const { entries, paused, clear, setPaused } = useLogs();
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("ALL");
  const bottomRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => entries.filter((entry) => level === "ALL" || entry.level === level), [entries, level]);
  const rendered = visible.slice(-800);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [paused, visible.length]);

  async function copyLogs() {
    await navigator.clipboard.writeText(visible.map((entry) => `${timeLabel(entry.timestamp)}  ${entry.level.padEnd(5)}  ${entry.message}`).join("\n"));
  }

  return (
    <section className="page-stack logs-page">
      <header className="page-header"><div><p className="eyebrow">LOGS / STREAM</p><h1>日志</h1><p>Rust 订阅 Mihomo <code>/logs</code> WebSocket，再以可筛选的终端流呈现。</p></div><div className="header-actions"><button className="secondary-button" onClick={() => setPaused(!paused)}>{paused ? <Play size={16} /> : <Pause size={16} />}{paused ? "继续滚动" : "暂停滚动"}</button><button className="secondary-button" onClick={() => void copyLogs()} disabled={!visible.length}><Clipboard size={16} />复制</button><button className="secondary-button" onClick={clear} disabled={!entries.length}><Trash2 size={16} />清空</button></div></header>
      <div className="log-levels">{LEVELS.map((item) => <button key={item} className={level === item ? "active" : ""} onClick={() => setLevel(item)}>{item}<span>{item === "ALL" ? entries.length : entries.filter((entry) => entry.level === item).length}</span></button>)}</div>
      <div className="terminal-card"><div className="terminal-topbar"><span><i /> <i /> <i /></span><small>{paused ? "STREAM PAUSED" : "MIHOMO /logs · LIVE"}</small><b>{rendered.length}{rendered.length < visible.length ? ` / ${visible.length}` : ""} lines</b></div><div className="terminal-body">{visible.length === 0 ? <div className="terminal-empty">等待 Mihomo 日志流…</div> : rendered.map((entry, index) => <div className="log-line" key={`${entry.timestamp}-${index}`}><time>{timeLabel(entry.timestamp)}</time><span className={`log-level ${entry.level.toLowerCase()}`}>{entry.level}</span><p>{entry.message}</p></div>)}<div ref={bottomRef} /></div></div>
    </section>
  );
}
