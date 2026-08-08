import type { ConnectionsResponse } from "../api/mihomo";

export type ConnectionState = {
  data: ConnectionsResponse | null;
  loading: boolean;
  error: string | null;
};

const listeners = new Set<() => void>();
let state: ConnectionState = { data: null, loading: false, error: null };

export const connectionStore = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setLoading: (loading: boolean) => {
    state = { ...state, loading };
    listeners.forEach((listener) => listener());
  },
  setData: (data: ConnectionsResponse) => {
    state = { data, loading: false, error: null };
    listeners.forEach((listener) => listener());
  },
  setError: (error: string) => {
    state = { ...state, loading: false, error };
    listeners.forEach((listener) => listener());
  },
  reset: () => {
    state = { data: null, loading: false, error: null };
    listeners.forEach((listener) => listener());
  },
};
