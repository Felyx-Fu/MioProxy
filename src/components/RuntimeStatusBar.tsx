import { ArrowDown, ArrowUp, Circle, Network, Route, SlidersHorizontal } from "lucide-react";
import type { CoreState, CoreStatus, ProxyState, SystemProxyStatus, TrafficSnapshot, TunStatusSnapshot } from "../api/mihomo";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../locales/en-US";
import { formatRate } from "../utils/format";
import type { Page } from "./Sidebar";

type StatusProjection = {
  label: MessageKey;
  tone: "success" | "warning" | "error" | "muted" | "unknown";
};

function systemProxyProjection(snapshot: SystemProxyStatus | null, transitioning: boolean): StatusProjection {
  if (!snapshot) return { label: "statusbar.proxy.unknown", tone: "unknown" };
  if (snapshot.owner === "external" || snapshot.actualState === "externalEndpoint" || snapshot.externalDetected) return { label: "statusbar.proxy.external", tone: "warning" };
  if (transitioning) return { label: "statusbar.proxy.pending", tone: "warning" };
  if (snapshot.owner === "mioproxy" && snapshot.actualState === "mioproxyEndpoint" && snapshot.enabled) return { label: "statusbar.proxy.on", tone: "success" };
  if (snapshot.owner === "none" && snapshot.actualState === "disabled") return { label: "statusbar.proxy.off", tone: "muted" };
  if (!snapshot.stateConsistent) return { label: "statusbar.proxy.error", tone: "error" };
  return { label: "statusbar.proxy.unknown", tone: "unknown" };
}

function tunProjection(snapshot: TunStatusSnapshot | null): StatusProjection {
  if (!snapshot) return { label: "statusbar.tun.unknown", tone: "unknown" };
  if (snapshot.projection === "waitingForService" || snapshot.projection === "enabling" || snapshot.projection === "disabling") return { label: "statusbar.tun.pending", tone: "warning" };
  if (snapshot.projection === "recovering") return { label: "statusbar.tun.recovery", tone: "warning" };
  if (snapshot.projection === "external") return { label: "statusbar.tun.external", tone: "warning" };
  if (snapshot.projection === "error") return { label: "statusbar.tun.error", tone: "error" };
  if (snapshot.projection === "on") return { label: "statusbar.tun.on", tone: "success" };
  if (snapshot.projection === "off") return { label: "statusbar.tun.off", tone: "muted" };
  if (snapshot.status === "starting" || snapshot.status === "stopping") return { label: "statusbar.tun.pending", tone: "warning" };
  if (snapshot.status === "error") return { label: "statusbar.tun.error", tone: "error" };
  if (snapshot.owner === "external" || snapshot.actualState === "externalTun" || snapshot.externalDetected) return { label: "statusbar.tun.external", tone: "warning" };
  if (snapshot.owner === "mioproxy" && snapshot.actualState === "mioproxyTun" && snapshot.status === "running") return { label: "statusbar.tun.on", tone: "success" };
  if (snapshot.desiredEnabled) return { label: "statusbar.tun.recovery", tone: "warning" };
  if (snapshot.owner === "none" && snapshot.actualState === "disabled") return { label: "statusbar.tun.off", tone: "muted" };
  return { label: "statusbar.tun.unknown", tone: "unknown" };
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
  const { t } = useI18n();
  const coreKey: MessageKey = !status ? "statusbar.core.checking" : coreState === "ready" ? "statusbar.core.ready" : coreState === "starting" ? "statusbar.core.starting" : coreState === "stopped" ? "statusbar.core.stopped" : "statusbar.core.error";
  const coreLabel = t(coreKey);
  const coreTone = !status ? "unknown" : coreState === "ready" ? "success" : coreState === "error" ? "error" : "warning";
  const profileLabel = appliedProfileName ? t("statusbar.profile.session", { name: appliedProfileName }) : selectedProfileName ? t("statusbar.profile.selected", { name: selectedProfileName }) : t("statusbar.profile.empty");
  const proxy = systemProxyProjection(proxyStatus, proxyState === "enabling" || proxyState === "disabling");
  const tun = tunProjection(tunStatus);

  return (
    <footer className="runtime-statusbar" aria-label={t("statusbar.label")}>
      <button type="button" className={`statusbar-item tone-${coreTone}`} onClick={() => onNavigate("home")} title={t("statusbar.coreTitle", { state: coreLabel })}>
        <Circle size={7} fill="currentColor" />
        <span>{coreLabel}</span>
      </button>
      <button type="button" className="statusbar-item" onClick={() => onNavigate("profiles")} title={appliedProfileName ? t("statusbar.profile.appliedTitle") : t("statusbar.profile.selectedTitle")}>
        <SlidersHorizontal size={12} />
        <span>{profileLabel}</span>
      </button>
      <button type="button" className="statusbar-item" onClick={() => onNavigate("proxies")} title={t("statusbar.nodeTitle")}>
        <Network size={12} />
        <span>{currentNode ?? t("statusbar.nodeEmpty")}</span>
      </button>
      <span className="statusbar-item statusbar-traffic" title={t("statusbar.trafficTitle")}>
        <ArrowDown size={12} /><span>{formatRate(traffic?.down)}</span>
        <ArrowUp size={12} /><span>{formatRate(traffic?.up)}</span>
      </span>
      <button type="button" className="statusbar-item" onClick={() => onNavigate("connections")} title={t("statusbar.connectionsTitle")}>
        <span>{connectionCount === null ? t("statusbar.connectionEmpty") : t("statusbar.connectionCount", { count: connectionCount })}</span>
      </button>
      <button type="button" className={`statusbar-item tone-${proxy.tone}`} onClick={() => onNavigate("settings")} title={t("statusbar.proxyTitle")}>
        <span>{t(proxy.label)}</span>
      </button>
      <button type="button" className={`statusbar-item tone-${tun.tone}`} onClick={() => onNavigate("tun")} title={t("statusbar.tunTitle")}>
        <Route size={12} />
        <span>{t(tun.label)}</span>
      </button>
    </footer>
  );
}
