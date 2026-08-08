export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";
export type LogEntry = {
  timestamp: number;
  level: LogLevel;
  message: string;
};

export type LogState = {
  entries: LogEntry[];
  paused: boolean;
};

const MAX_ENTRIES = 600;
const listeners = new Set<() => void>();
let state: LogState = { entries: [], paused: false };

export const logStore = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  append: (entry: LogEntry) => {
    state = { ...state, entries: [...state.entries, entry].slice(-MAX_ENTRIES) };
    listeners.forEach((listener) => listener());
  },
  clear: () => {
    state = { ...state, entries: [] };
    listeners.forEach((listener) => listener());
  },
  setPaused: (paused: boolean) => {
    state = { ...state, paused };
    listeners.forEach((listener) => listener());
  },
};
