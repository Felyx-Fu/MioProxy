import type { TrafficSnapshot } from "../api/mihomo";

export type TrafficState = {
  snapshot: TrafficSnapshot | null;
  error: string | null;
};

const listeners = new Set<() => void>();
let state: TrafficState = { snapshot: null, error: null };

export const trafficStore = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setSnapshot: (snapshot: TrafficSnapshot) => {
    state = { snapshot, error: null };
    listeners.forEach((listener) => listener());
  },
  setError: (error: string) => {
    state = { ...state, error };
    listeners.forEach((listener) => listener());
  },
  reset: () => {
    state = { snapshot: null, error: null };
    listeners.forEach((listener) => listener());
  },
};
