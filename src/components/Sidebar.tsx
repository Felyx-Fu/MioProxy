import { Activity, Braces, FileText, Globe2, Home, Network, Radio, RadioTower, Settings2, Shield, Waypoints, Workflow } from "lucide-react";

export type Page = "home" | "connections" | "logs" | "profiles" | "proxies" | "rules" | "dns" | "overrides" | "tun" | "settings";

const items: Array<{ id: Page; label: string; icon: typeof Home }> = [
  { id: "home", label: "Dashboard", icon: Home },
  { id: "connections", label: "连接", icon: Radio },
  { id: "logs", label: "日志", icon: FileText },
  { id: "profiles", label: "订阅", icon: Globe2 },
  { id: "proxies", label: "节点", icon: Network },
  { id: "rules", label: "规则", icon: Workflow },
  { id: "dns", label: "DNS", icon: Waypoints },
  { id: "overrides", label: "Override", icon: Braces },
  { id: "tun", label: "TUN", icon: RadioTower },
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
        <span>V0.7 TUN Layer</span>
      </div>
    </aside>
  );
}
