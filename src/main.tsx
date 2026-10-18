import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppearanceProvider, bootstrapAppearance } from "./appearance/AppearanceProvider";
import { I18nProvider } from "./i18n/I18nProvider";
const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./styles.css", import.meta.url).href;
document.head.append(stylesheet);

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
