import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import type { TrafficSnapshot } from "../api/mihomo";
import { trafficStore } from "../stores/trafficStore";

export function useTraffic() {
  const state = useSyncExternalStore(trafficStore.subscribe, trafficStore.getSnapshot, trafficStore.getSnapshot);

  useEffect(() => {
    let active = true;
    let unlistenTraffic: (() => void) | undefined;
    let unlistenStopped: (() => void) | undefined;
    void listen<TrafficSnapshot>("mihomo-traffic", (event) => trafficStore.setSnapshot(event.payload)).then((unlisten) => {
      if (active) unlistenTraffic = unlisten;
      else unlisten();
    });
    void listen("mihomo-stopped", () => trafficStore.reset()).then((unlisten) => {
      if (active) unlistenStopped = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      unlistenTraffic?.();
      unlistenStopped?.();
    };
  }, []);

  return state;
}
