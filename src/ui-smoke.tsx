import { AppearanceProvider, bootstrapAppearance } from "./appearance/AppearanceProvider";
import { I18nProvider } from "./i18n/I18nProvider";
import { uiSmokeFixture } from "./ui-smoke-fixtures";
import { emitUiSmokeEvents, installUiSmokeTauriMock, type UiSmokeAudit } from "./ui-smoke-tauri";
import "./styles.css";

declare global {
  interface Window {
    __MIOPROXY_SMOKE__?: UiSmokeAudit & { fixtureId: string };
  }
}

const localePreference = new URLSearchParams(window.location.search).get("locale");
if (localePreference === "zh-CN" || localePreference === "en-US") {
  window.localStorage.setItem("mioproxy.ui.language:v1", localePreference);
} else {
  window.localStorage.setItem("mioproxy.ui.language:v1", "en-US");
}
window.localStorage.setItem("mioproxy.ui.theme:v1", "light");
window.localStorage.setItem("mioproxy.ui.windows-material:v1", "on");
window.localStorage.setItem("mioproxy.proxyPreferences.v1", JSON.stringify({
  version: 1,
  profiles: {
    "profile:profile-a": uiSmokeFixture.proxyPreferences,
  },
}));

window.__MIOPROXY_VISUAL_PREVIEW__ = true;
bootstrapAppearance();

const audit: UiSmokeAudit = { reads: [], fixtureCommands: [], unsupportedCommands: [] };
window.__MIOPROXY_SMOKE__ = { fixtureId: uiSmokeFixture.id, ...audit };
document.documentElement.dataset.smokeFixture = uiSmokeFixture.id;
document.documentElement.dataset.smokeLocale = localePreference === "zh-CN" ? "zh-CN" : "en-US";
document.documentElement.dataset.smokeMutationAttempts = "0";
installUiSmokeTauriMock(uiSmokeFixture, audit);

const [{ default: App }, ReactDOM] = await Promise.all([import("./App"), import("react-dom/client")]);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <AppearanceProvider>
      <App initialState={uiSmokeFixture.initialState} />
    </AppearanceProvider>
  </I18nProvider>,
);

window.setTimeout(() => {
  const surface = document.getElementById("main-content");
  if (!surface) {
    document.documentElement.dataset.smokeGenericContextMenu = "missing-surface";
    document.documentElement.dataset.smokeContextMenuActions = "missing-surface";
    return;
  }
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  surface.dispatchEvent(event);
  document.documentElement.dataset.smokeGenericContextMenu = event.defaultPrevented ? "blocked" : "exposed";
  document.documentElement.dataset.smokeContextMenuActions = event.defaultPrevented
    ? "none"
    : "back-refresh-save-print-more-tools";
}, 100);

emitUiSmokeEvents(uiSmokeFixture);
