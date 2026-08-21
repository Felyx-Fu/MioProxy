import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppearanceProvider, bootstrapAppearance } from "./appearance/AppearanceProvider";
import { I18nProvider } from "./i18n/I18nProvider";
import "./styles.css";

bootstrapAppearance();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <AppearanceProvider>
        <App />
      </AppearanceProvider>
    </I18nProvider>
  </React.StrictMode>,
);
