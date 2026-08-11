export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";
export type LogEntry = {
  timestamp: number;
  level: LogLevel;
  message: string;
};

export type LogState = {
  entries: LogEntry[];
  paused: boolean;
  frozenEntries: LogEntry[];
  bufferedCount: number;
};

const MAX_ENTRIES = 3000;
const listeners = new Set<() => void>();
let state: LogState = { entries: [], paused: false, frozenEntries: [], bufferedCount: 0 };

export const logStore = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  append: (entry: LogEntry) => {
    state = {
      ...state,
      entries: [...state.entries, entry].slice(-MAX_ENTRIES),
      bufferedCount: state.paused ? state.bufferedCount + 1 : 0,
    };
    listeners.forEach((listener) => listener());
  },
  clear: () => {
    state = { ...state, entries: [], frozenEntries: [], bufferedCount: 0 };
    listeners.forEach((listener) => listener());
  },
  setPaused: (paused: boolean) => {
    if (paused === state.paused) return;
    state = paused
      ? { ...state, paused: true, frozenEntries: state.entries, bufferedCount: 0 }
      : { ...state, paused: false, frozenEntries: [], bufferedCount: 0 };
    listeners.forEach((listener) => listener());
  },
};
