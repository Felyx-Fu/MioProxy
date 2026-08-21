import { ArrowDown, ArrowUp, Circle, Network, Route, SlidersHorizontal } from "lucide-react";
import type { CoreState, CoreStatus, ProxyState, SystemProxyStatus, TrafficSnapshot, TunStatusSnapshot } from "../api/mihomo";
import { formatRate } from "../utils/format";
import type { Page } from "./Sidebar";

function systemProxyProjection(snapshot: SystemProxyStatus | null, transitioning: boolean) {
  if (!snapshot) return { label: "Proxy —", tone: "unknown" };
  if (snapshot.owner === "external" || snapshot.actualState === "externalEndpoint" || snapshot.externalDetected) return { label: "Proxy External", tone: "warning" };
  if (transitioning) return { label: "Proxy Pending", tone: "warning" };
  if (snapshot.owner === "mioproxy" && snapshot.actualState === "mioproxyEndpoint" && snapshot.enabled) return { label: "Proxy On", tone: "success" };
  if (snapshot.owner === "none" && snapshot.actualState === "disabled") return { label: "Proxy Off", tone: "muted" };
  if (!snapshot.stateConsistent) return { label: "Proxy Error", tone: "error" };
  return { label: "Proxy —", tone: "unknown" };
}

function tunProjection(snapshot: TunStatusSnapshot | null) {
  if (!snapshot) return { label: "TUN —", tone: "unknown" };
  if (snapshot.status === "starting" || snapshot.status === "stopping") return { label: "TUN Pending", tone: "warning" };
  if (snapshot.status === "error") return { label: "TUN Error", tone: "error" };
  if (snapshot.owner === "external" || snapshot.actualState === "externalTun" || snapshot.externalDetected) return { label: "TUN External", tone: "warning" };
  if (snapshot.owner === "mioproxy" && snapshot.actualState === "mioproxyTun" && snapshot.status === "running") return { label: "TUN On", tone: "success" };
  if (snapshot.desiredEnabled) return { label: "TUN Recovery", tone: "warning" };
  if (snapshot.owner === "none" && snapshot.actualState === "disabled") return { label: "TUN Off", tone: "muted" };
  return { label: "TUN —", tone: "unknown" };
}

export function RuntimeStatusBar({
  status,
  coreState,
  selectedProfileName,
  appliedProfileName,
  currentNode,
  traffic,
  connectionCount,
  proxyStatus,
  proxyState,
  tunStatus,
  onNavigate,
}: {
  status: CoreStatus | null;
  coreState: CoreState;
  selectedProfileName: string | null;
  appliedProfileName: string | null;
  currentNode: string | null;
  traffic: TrafficSnapshot | null;
  connectionCount: number | null;
  proxyStatus: SystemProxyStatus | null;
  proxyState: ProxyState;
  tunStatus: TunStatusSnapshot | null;
  onNavigate: (page: Page) => void;
}) {
  const coreLabel = !status ? "Checking" : coreState === "ready" ? "Ready" : coreState === "starting" ? "Starting" : coreState === "stopped" ? "Stopped" : "Error";
  const coreTone = !status ? "unknown" : coreState === "ready" ? "success" : coreState === "error" ? "error" : "warning";
  const profileLabel = appliedProfileName ? `${appliedProfileName} · session` : selectedProfileName ? `Selected ${selectedProfileName}` : "Profile —";
  const proxy = systemProxyProjection(proxyStatus, proxyState === "enabling" || proxyState === "disabling");
  const tun = tunProjection(tunStatus);

  return (
    <footer className="runtime-statusbar" aria-label="Runtime status">
      <button type="button" className={`statusbar-item tone-${coreTone}`} onClick={() => onNavigate("home")} title={`Core ${coreLabel}`}>
        <Circle size={7} fill="currentColor" />
        <span>{coreLabel}</span>
      </button>
      <button type="button" className="statusbar-item" onClick={() => onNavigate("profiles")} title={appliedProfileName ? "Applied in this session" : "No active-profile read contract; showing the selected profile"}>
        <SlidersHorizontal size={12} />
        <span>{profileLabel}</span>
      </button>
      <button type="button" className="statusbar-item" onClick={() => onNavigate("proxies")} title="Selected proxy group node">
        <Network size={12} />
        <span>{currentNode ?? "Node —"}</span>
      </button>
      <span className="statusbar-item statusbar-traffic" title="Current Mihomo traffic">
        <ArrowDown size={12} /><span>{formatRate(traffic?.down)}</span>
        <ArrowUp size={12} /><span>{formatRate(traffic?.up)}</span>
      </span>
      <button type="button" className="statusbar-item" onClick={() => onNavigate("connections")} title="Active connections">
        <span>{connectionCount === null ? "— conn" : `${connectionCount} conn`}</span>
      </button>
      <button type="button" className={`statusbar-item tone-${proxy.tone}`} onClick={() => onNavigate("settings")} title="System Proxy ownership">
        <span>{proxy.label}</span>
      </button>
      <button type="button" className={`statusbar-item tone-${tun.tone}`} onClick={() => onNavigate("tun")} title="TUN ownership">
        <Route size={12} />
        <span>{tun.label}</span>
      </button>
    </footer>
  );
}
