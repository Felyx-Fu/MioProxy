import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { mihomoApi } from "../api/mihomo";
import { connectionStore } from "../stores/connectionStore";

export function useConnections(enabled: boolean) {
  const state = useSyncExternalStore(connectionStore.subscribe, connectionStore.getSnapshot, connectionStore.getSnapshot);
  const requestInFlight = useRef(false);
  const generation = useRef(0);
  const active = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || !active.current || requestInFlight.current) return;
    const currentGeneration = generation.current;
    const isCurrent = () => active.current && generation.current === currentGeneration;
    requestInFlight.current = true;
    connectionStore.setLoading(true);
    try {
      const data = await mihomoApi.connections();
      if (isCurrent()) connectionStore.setData(data);
    } catch (error) {
      if (isCurrent()) connectionStore.setError(String(error));
    } finally {
      if (isCurrent()) requestInFlight.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    active.current = enabled;
    if (!enabled) {
      connectionStore.reset();
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      window.clearInterval(timer);
      active.current = false;
      // Retired requests must not publish data or unlock a newer request.
      generation.current += 1;
      requestInFlight.current = false;
    };
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
