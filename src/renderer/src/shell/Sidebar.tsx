import brandMarkUrl from "../../../../assets/icons/Win/mioproxy-app-icon.svg";
import { navItems } from "../routes/navItems";
import { useMioProxyApp } from "../state/MioProxyAppState";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarStatusCard } from "./SidebarStatusCard";

export function Sidebar() {
  const app = useMioProxyApp();
  const controllerPort = parsePort(app.form.controllerBaseUrl) ?? "controller pending";
  const mixedPort = app.form.systemProxyPort ? `mixed ${app.form.systemProxyPort}` : "mixed pending";
  const coreVersion = extractVersion(app.healthResult) ?? "version pending";

  return (
    <aside className="sidebar">
      <div className="brand-block">
        <img src={brandMarkUrl} alt="" className="brand-mark" />
        <div>
          <h1>MioProxy</h1>
          <p>Windows-first Mihomo Controller</p>
        </div>
      </div>

      <section className="sidebar-status-stack" aria-label="Runtime quick status">
        <SidebarStatusCard
          title="Core Status"
          value={app.coreStatusLabel}
          detail={`${coreVersion} / ${controllerPort}`}
          to="/dashboard"
          tone={app.coreStatus?.running ? "success" : "neutral"}
        />
        <SidebarStatusCard
          title="System Proxy"
          value={app.systemProxyLabel}
          detail={mixedPort}
          to="/settings"
          tone={app.systemProxyStatus?.enabled ? "success" : "neutral"}
        />
        <SidebarStatusCard
          title="Profile"
          value={app.form.profileId || "default"}
          detail={app.configHealthLabel}
          to="/profiles"
          tone={app.latestRun?.ok ? "success" : app.latestRun ? "warning" : "neutral"}
        />
      </section>

      <nav className="sidebar-nav" aria-label="Primary">
        {navItems.map((item) => (
          <SidebarNavItem key={item.path} item={item} />
        ))}
      </nav>

      <div className="sidebar-footer">
        <div>
          <strong>MioProxy</strong>
          <span>MVP channel</span>
        </div>
        <div className="sidebar-footer-links" aria-label="Project links">
          <a href="https://github.com/Felyx-Fu/MioProxy" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="https://github.com/Felyx-Fu/MioProxy/issues" target="_blank" rel="noreferrer">
            Feedback
          </a>
          <a href="https://github.com/Felyx-Fu/MioProxy/releases" target="_blank" rel="noreferrer">
            Releases
          </a>
        </div>
      </div>
    </aside>
  );
}

function parsePort(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.port ? `controller ${parsed.port}` : "controller default";
  } catch {
    return null;
  }
}

function extractVersion(value: string): string | null {
  const match = value.match(/^version:\s*(.+)$/m);
  return match ? `core ${match[1]}` : null;
}
