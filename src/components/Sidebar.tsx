import { FileText, Gauge, Network, Radio, Search, Settings2, SlidersHorizontal, Workflow } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../locales/en-US";

export type Page = "home" | "connections" | "logs" | "profiles" | "proxies" | "rules" | "dns" | "overrides" | "tun" | "settings";

const primaryItems: Array<{ id: Page; labelKey: MessageKey; icon: typeof Gauge; shortcut: string }> = [
  { id: "home", labelKey: "nav.overview", icon: Gauge, shortcut: "Ctrl+1" },
  { id: "proxies", labelKey: "nav.proxies", icon: Network, shortcut: "Ctrl+2" },
  { id: "profiles", labelKey: "nav.profiles", icon: SlidersHorizontal, shortcut: "Ctrl+3" },
  { id: "connections", labelKey: "nav.connections", icon: Radio, shortcut: "Ctrl+4" },
  { id: "rules", labelKey: "nav.rules", icon: Workflow, shortcut: "Ctrl+5" },
  { id: "logs", labelKey: "nav.logs", icon: FileText, shortcut: "Ctrl+6" },
];

export function Sidebar({ page, onChange }: { page: Page; onChange: (page: Page) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const primaryPage = primaryItems.some((item) => item.id === page) ? page : null;
  const settingsLabel = t("nav.settings");

  return (
    <aside className="sidebar" aria-label={t("nav.main")}>
      <div className="sidebar-brand" aria-label="MioProxy">
        <span className="sidebar-brand-mark" aria-hidden="true"><Network size={21} strokeWidth={1.7} /></span>
        <span className="sidebar-brand-name">Mio<span>Proxy</span></span>
      </div>
      <label className="sidebar-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" aria-label={t("nav.search")} placeholder={t("nav.search")} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
      </label>
      <nav className="sidebar-nav">
        {primaryItems.filter(({ labelKey }) => t(labelKey).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(({ id, labelKey, icon: Icon, shortcut }) => {
          const label = t(labelKey);
          return (
            <button
              key={id}
              type="button"
              className={primaryPage === id ? "nav-item active" : "nav-item"}
              onClick={() => { onChange(id); setQuery(""); }}
              aria-current={primaryPage === id ? "page" : undefined}
              aria-label={label}
              title={t("nav.shortcut", { label, shortcut })}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-tools">
        <span className="sidebar-section-label">{t("nav.tools")}</span>
        {([{ id: "dns", label: "dns.title" }, { id: "tun", label: "tun.title" }, { id: "overrides", label: "overrides.title" }] as const)
          .filter(({ label }) => t(label).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
          .map(({ id, label }) => <button key={id} type="button" className={`nav-item${page === id ? " active" : ""}`} aria-label={t(label)} title={t(label)} aria-current={page === id ? "page" : undefined} onClick={() => { onChange(id); setQuery(""); }}><SlidersHorizontal size={16} strokeWidth={1.8} /><span>{t(label)}</span></button>)}
      </div>

      <button
        type="button"
        className={page === "settings" ? "nav-item nav-settings active" : "nav-item nav-settings"}
        onClick={() => onChange("settings")}
        aria-current={page === "settings" ? "page" : undefined}
        aria-label={settingsLabel}
        title={t("nav.shortcut", { label: settingsLabel, shortcut: "Ctrl+," })}
      >
        <Settings2 size={16} strokeWidth={1.8} />
        <span>{settingsLabel}</span>
      </button>
    </aside>
  );
}
