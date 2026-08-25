import { AlertTriangle, ArrowLeft, CirclePower, Network, Route, ShieldCheck } from "lucide-react";
import type { TunStatusSnapshot } from "../api/mihomo";
import type { Page } from "../components/Sidebar";
import { useI18n } from "../i18n/I18nProvider";

export function TunPage({ profileId, coreRunning, systemProxyEnabled, snapshot, loading, error, onRequestTransition, onNavigate }: {
  profileId: string | null;
  coreRunning: boolean;
  systemProxyEnabled: boolean;
  snapshot: TunStatusSnapshot | null;
  loading: boolean;
  error: string | null;
  onRequestTransition: () => void;
  onNavigate: (page: Page) => void;
}) {
  const { t } = useI18n();
  const status = snapshot?.status ?? "disabled";
  const projection = snapshot?.projection;
  const transitioning = projection === "waitingForService" || projection === "enabling" || projection === "disabling" || projection === "recovering";
  const projectionError = projection === "error";
  const external = Boolean(snapshot?.owner === "external" || snapshot?.actualState === "externalTun" || snapshot?.externalDetected);
  const owned = projection === "on" || Boolean(snapshot?.owner === "mioproxy" && snapshot?.actualState === "mioproxyTun" && status === "running");
  const willDisable = !external && Boolean(owned || snapshot?.desiredEnabled);
  const blockedForEnable = !coreRunning || !profileId || external;

  return (
    <section className="page-stack tun-page">
      <header className="page-header compact-header">
        <div><button className="back-link" type="button" onClick={() => onNavigate("settings")}><ArrowLeft size={14} />{t("tun.settings")}</button><h1>{t("tun.title")}</h1><p>{t("tun.description")}</p></div>
        <button className={willDisable ? "danger-button" : "primary-button"} type="button" onClick={onRequestTransition} disabled={loading || !snapshot || transitioning || (!willDisable && blockedForEnable)} aria-pressed={Boolean(snapshot?.desiredEnabled)}><CirclePower size={15} />{loading || transitioning ? t("tun.working") : external ? t("tun.externalTun") : willDisable ? t("tun.turnOff") : projectionError ? t("tun.retry") : t("tun.turnOn")}</button>
      </header>
      {error && <div className="info-bar error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
      {snapshot?.message && <div className={projectionError ? "info-bar error" : transitioning || external ? "info-bar warning" : "info-bar success"} role={projectionError ? "alert" : "status"}><ShieldCheck size={16} /><span>{snapshot.message}</span></div>}

      <section className="surface-panel tun-runtime-panel">
        <div className="section-title-row"><div><h2>{t("tun.runtimeProjection")}</h2><p>{external ? t("tun.externalOwnershipDescription") : t("tun.runtimeDescription")}</p></div><span className={`state-value tone-${projectionError ? "error" : external || transitioning ? "warning" : owned ? "success" : "muted"}`}><span className="state-dot" />{external ? t("tun.stateExternal") : transitioning ? t("tun.stateTransitioning") : owned ? t("tun.stateOn") : projectionError ? t("tun.stateError") : snapshot ? t("tun.stateOff") : t("tun.stateChecking")}</span></div>
        <dl className="form-details">
          <div><dt>{t("tun.owner")}</dt><dd>{snapshot?.owner ?? "—"}</dd></div>
          <div><dt>{t("tun.actualState")}</dt><dd>{snapshot?.actualState ?? "—"}</dd></div>
          <div><dt>{t("tun.desired")}</dt><dd>{snapshot ? snapshot.desiredEnabled ? t("tun.enabled") : t("tun.disabled") : "—"}</dd></div>
          <div><dt>{t("tun.core")}</dt><dd>{coreRunning ? t("tun.ready") : t("tun.notReady")}</dd></div>
          <div><dt>{t("tun.systemProxy")}</dt><dd>{systemProxyEnabled ? t("tun.stateOn") : t("tun.stateOff")}</dd></div>
          <div><dt>{t("tun.sessionProfile")}</dt><dd>{snapshot?.profileId ?? profileId ?? "—"}</dd></div>
        </dl>
      </section>

      {(!coreRunning || !profileId || external) && <div className="surface-panel prerequisite-row"><AlertTriangle size={16} /><div><strong>{external ? t("tun.externalActive") : t("tun.enablePrerequisites")}</strong><span>{external ? t("tun.externalActiveDescription") : !coreRunning ? t("tun.waitForCore") : t("tun.selectProfile")}</span></div></div>}
      <section className="surface-panel tun-contract-note"><Route size={16} /><div><strong>{t("tun.configurationDetails")}</strong><span>{t("tun.configurationDescription")}</span></div><Network size={16} /></section>
    </section>
  );
}
