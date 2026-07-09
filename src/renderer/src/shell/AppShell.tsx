import { Sidebar } from "./Sidebar";
import { MainContent } from "./MainContent";

export function AppShell() {
  return (
    <div className="app-shell">
      <Sidebar />
      <MainContent />
    </div>
  );
}
