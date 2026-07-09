import { Navigate, useRoutes } from "react-router-dom";
import { DashboardPage } from "../pages/DashboardPage";
import { LogsPage } from "../pages/LogsPage";
import { NodesPage } from "../pages/NodesPage";
import { OverridesPage } from "../pages/OverridesPage";
import { ProfilesPage } from "../pages/ProfilesPage";
import { RulesPage } from "../pages/RulesPage";
import { SettingsPage } from "../pages/SettingsPage";
import { AppShell } from "../shell/AppShell";

export function AppRoutes() {
  return useRoutes([
    {
      path: "/",
      element: <AppShell />,
      children: [
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: "dashboard", element: <DashboardPage /> },
        { path: "profiles", element: <ProfilesPage /> },
        { path: "nodes", element: <NodesPage /> },
        { path: "rules", element: <RulesPage /> },
        { path: "overrides", element: <OverridesPage /> },
        { path: "logs", element: <LogsPage /> },
        { path: "settings", element: <SettingsPage /> },
        { path: "*", element: <Navigate to="/dashboard" replace /> }
      ]
    }
  ]);
}
