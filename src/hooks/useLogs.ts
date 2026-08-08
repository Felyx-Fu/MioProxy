import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import { logStore, type LogEntry } from "../stores/logStore";

export type { LogEntry, LogLevel } from "../stores/logStore";

export function useLogs() {
  const state = useSyncExternalStore(logStore.subscribe, logStore.getSnapshot, logStore.getSnapshot);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<LogEntry>("mihomo-log-entry", (event) => logStore.append(event.payload)).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return {
    ...state,
    clear: logStore.clear,
    setPaused: logStore.setPaused,
  };
}
