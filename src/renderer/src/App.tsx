import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { AppRoutes } from "./routes";
import { MioProxyAppProvider } from "./state/MioProxyAppState";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <HashRouter>
    <MioProxyAppProvider>
      <AppRoutes />
    </MioProxyAppProvider>
  </HashRouter>
);
