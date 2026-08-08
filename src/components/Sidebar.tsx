import { Activity, Globe2, Home, Network, Settings2, Shield } from "lucide-react";

export type Page = "home" | "profiles" | "proxies" | "settings";

const items: Array<{ id: Page; label: string; icon: typeof Home }> = [
  { id: "home", label: "概览", icon: Home },
  { id: "profiles", label: "订阅", icon: Globe2 },
  { id: "proxies", label: "节点", icon: Network },
  { id: "settings", label: "设置", icon: Settings2 },
];

export function Sidebar({ page, onChange }: { page: Page; onChange: (page: Page) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Shield size={19} /></div>
        <div>
          <strong>MioProxy</strong>
          <span>Network Client</span>
        </div>
      </div>

      <nav>
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} className={page === id ? "nav-item active" : "nav-item"} onClick={() => onChange(id)}>
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <Activity size={16} />
        <span>V0.2 Core Preview</span>
      </div>
    </aside>
  );
}
