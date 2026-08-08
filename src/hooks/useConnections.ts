import { useCallback, useEffect, useSyncExternalStore } from "react";
import { mihomoApi } from "../api/mihomo";
import { connectionStore } from "../stores/connectionStore";

export function useConnections(enabled: boolean) {
  const state = useSyncExternalStore(connectionStore.subscribe, connectionStore.getSnapshot, connectionStore.getSnapshot);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    connectionStore.setLoading(true);
    try {
      connectionStore.setData(await mihomoApi.connections());
    } catch (error) {
      connectionStore.setError(String(error));
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      connectionStore.reset();
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  const closeConnection = useCallback(async (id: string) => {
    await mihomoApi.closeConnection(id);
    await refresh();
  }, [refresh]);

  const closeAllConnections = useCallback(async () => {
    await mihomoApi.closeAllConnections();
    await refresh();
  }, [refresh]);

  return { ...state, refresh, closeConnection, closeAllConnections };
}
