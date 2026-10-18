import type { CoreMode } from "../api/mihomo";
import { useI18n } from "../i18n/I18nProvider";

<<<<<<< HEAD
export function TrafficModeControl({ mode, busy, onChange }: {
  mode: CoreMode | null;
  busy: boolean;
=======
export function TrafficModeControl({ mode, busy, available = true, onChange }: {
  mode: CoreMode | null;
  busy: boolean;
  available?: boolean;
>>>>>>> a131c10b1e6f0d0a927fe847504073c7eec134b7
  onChange: (mode: CoreMode) => Promise<void>;
}) {
  const { t } = useI18n();
  return <div className="traffic-mode-wrapper"><div className="traffic-mode-control" role="group" aria-label={t("proxies.mode.label")} aria-busy={busy}>
<<<<<<< HEAD
    {(["rule", "global", "direct"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={busy || mode === null} title={t(`proxies.mode.${value}Description`)} onClick={() => { if (value !== mode) void onChange(value); }}>{t(`proxies.mode.${value}`)}</button>)}
=======
    {(["rule", "global", "direct"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={!available || busy || mode === null} title={t(`proxies.mode.${value}Description`)} onClick={() => { if (value !== mode) void onChange(value); }}>{t(`proxies.mode.${value}`)}</button>)}
>>>>>>> a131c10b1e6f0d0a927fe847504073c7eec134b7
  </div>{busy && <span className="home-caption" role="status">{t("proxies.mode.switching")}</span>}</div>;
}
