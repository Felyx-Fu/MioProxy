import { FileText, Gauge, Network, Radio, Settings2, SlidersHorizontal, Workflow } from "lucide-react";
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
  const primaryPage = primaryItems.some((item) => item.id === page) ? page : null;
  const settingsLabel = t("nav.settings");

  return (
    <aside className="sidebar" aria-label={t("nav.main")}>
      <nav className="sidebar-nav">
        {primaryItems.map(({ id, labelKey, icon: Icon, shortcut }) => {
          const label = t(labelKey);
          return (
            <button
              key={id}
              type="button"
              className={primaryPage === id ? "nav-item active" : "nav-item"}
              onClick={() => onChange(id)}
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

      <button
        type="button"
        className={page === "settings" || page === "dns" || page === "tun" || page === "overrides" ? "nav-item nav-settings active" : "nav-item nav-settings"}
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
