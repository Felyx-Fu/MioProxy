import { FileText, Gauge, Network, Radio, Settings2, SlidersHorizontal, Workflow } from "lucide-react";

export type Page = "home" | "connections" | "logs" | "profiles" | "proxies" | "rules" | "dns" | "overrides" | "tun" | "settings";

const primaryItems: Array<{ id: Page; label: string; icon: typeof Gauge; shortcut: string }> = [
  { id: "home", label: "Overview", icon: Gauge, shortcut: "Ctrl+1" },
  { id: "proxies", label: "Proxies", icon: Network, shortcut: "Ctrl+2" },
  { id: "profiles", label: "Profiles", icon: SlidersHorizontal, shortcut: "Ctrl+3" },
  { id: "connections", label: "Connections", icon: Radio, shortcut: "Ctrl+4" },
  { id: "rules", label: "Rules", icon: Workflow, shortcut: "Ctrl+5" },
  { id: "logs", label: "Logs", icon: FileText, shortcut: "Ctrl+6" },
];

export function Sidebar({ page, onChange }: { page: Page; onChange: (page: Page) => void }) {
  const primaryPage = primaryItems.some((item) => item.id === page) ? page : null;

  return (
    <aside className="sidebar" aria-label="Main navigation">
      <nav className="sidebar-nav">
        {primaryItems.map(({ id, label, icon: Icon, shortcut }) => (
          <button
            key={id}
            type="button"
            className={primaryPage === id ? "nav-item active" : "nav-item"}
            onClick={() => onChange(id)}
            aria-current={primaryPage === id ? "page" : undefined}
            title={`${label} (${shortcut})`}
          >
            <Icon size={16} strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <button
        type="button"
        className={page === "settings" || page === "dns" || page === "tun" || page === "overrides" ? "nav-item nav-settings active" : "nav-item nav-settings"}
        onClick={() => onChange("settings")}
        aria-current={page === "settings" ? "page" : undefined}
        title="Settings (Ctrl+,)"
      >
        <Settings2 size={16} strokeWidth={1.8} />
        <span>Settings</span>
      </button>
    </aside>
  );
}
