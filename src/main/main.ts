import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { createConfigStore } from "@mioproxy/core-runtime";
import { registerClashPartyImportIpc } from "./ipc/clashPartyImportIpc.js";
import { registerConnectionIpc } from "./ipc/connectionIpc.js";
import { registerControllerLogIpc } from "./ipc/controllerLogIpc.js";
import { registerControllerHealthIpc } from "./ipc/controllerHealthIpc.js";
import { registerControllerObservationIpc } from "./ipc/controllerObservationIpc.js";
import { registerControllerProxyIpc } from "./ipc/controllerProxyIpc.js";
import { registerControllerRuleIpc } from "./ipc/controllerRuleIpc.js";
import { registerCoreProcessIpc } from "./ipc/coreProcessIpc.js";
import { registerOverrideSettingsIpc } from "./ipc/overrideSettingsIpc.js";
import { registerPipelineIpc } from "./ipc/pipelineIpc.js";
import { registerProfileSettingsIpc } from "./ipc/profileSettingsIpc.js";
import { registerSubscriptionScheduleIpc } from "./ipc/subscriptionScheduleIpc.js";
import { registerSystemProxyIpc } from "./ipc/systemProxyIpc.js";

const ELECTRON_SMOKE_RESULT_PREFIX = "MIOPROXY_ELECTRON_SMOKE_RESULT ";

if (process.env.MIOPROXY_ELECTRON_SMOKE_USER_DATA_DIR) {
  app.setPath("userData", process.env.MIOPROXY_ELECTRON_SMOKE_USER_DATA_DIR);
}

interface ElectronSmokeResult {
  title: string;
  hasAppShell: boolean;
  hasSubscriptionSchedule: boolean;
  hasRuntimeStatus: boolean;
  hasRendererCss: boolean;
  hasPreloadBridge: boolean;
  platform: string | null;
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: !isElectronSmokeMode(),
    title: "MioProxy",
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const load = process.env.VITE_DEV_SERVER_URL
    ? window.loadURL(process.env.VITE_DEV_SERVER_URL)
    : window.loadFile(join(__dirname, "../renderer/index.html"));

  if (isElectronSmokeMode()) {
    void runElectronSmoke(window, load);
  }

  return window;
}

function isElectronSmokeMode(): boolean {
  return process.env.MIOPROXY_ELECTRON_SMOKE === "1";
}

async function runElectronSmoke(
  window: BrowserWindow,
  load: Promise<void>
): Promise<void> {
  try {
    await load;
    const result = (await window.webContents.executeJavaScript(`
      (() => {
        const body = document.body?.innerText ?? "";
        const bridge = window.mioproxy;
        return {
          title: document.title,
          hasAppShell: Boolean(document.querySelector(".app-shell")),
          hasSubscriptionSchedule: body.includes("Subscription schedule"),
          hasRuntimeStatus: body.includes("Runtime:") && body.includes("not armed"),
          hasRendererCss: Array.from(document.styleSheets).some((sheet) => {
            try {
              return Array.from(sheet.cssRules).some((rule) =>
                rule.cssText.includes(".workspace-grid") &&
                  rule.cssText.includes("grid-template-columns")
              );
            } catch {
              return false;
            }
          }),
          hasPreloadBridge: Boolean(
            bridge &&
              typeof bridge.loadSubscriptionSchedule === "function" &&
              typeof bridge.armSubscriptionSchedule === "function" &&
              typeof bridge.getSubscriptionScheduleRuntimeStatus === "function"
          ),
          platform: bridge?.platform ?? null
        };
      })();
    `)) as ElectronSmokeResult;

    console.log(`${ELECTRON_SMOKE_RESULT_PREFIX}${JSON.stringify(result)}`);
    app.exit(allSmokeChecksPassed(result) ? 0 : 1);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    console.error(
      `${ELECTRON_SMOKE_RESULT_PREFIX}${JSON.stringify({
        error: {
          name: normalized.name,
          message: normalized.message
        }
      })}`
    );
    app.exit(1);
  }
}

function allSmokeChecksPassed(result: ElectronSmokeResult): boolean {
  return (
    result.title === "MioProxy" &&
    result.hasAppShell &&
    result.hasSubscriptionSchedule &&
    result.hasRuntimeStatus &&
    result.hasRendererCss &&
    result.hasPreloadBridge &&
    typeof result.platform === "string" &&
    result.platform.length > 0
  );
}

void app.whenReady().then(() => {
  const userDataDir = app.getPath("userData");
  registerPipelineIpc(userDataDir);
  registerClashPartyImportIpc(userDataDir);
  registerOverrideSettingsIpc(userDataDir);
  registerProfileSettingsIpc(userDataDir);
  const subscriptionScheduleService = registerSubscriptionScheduleIpc(userDataDir);
  const controllerHealthService = registerControllerHealthIpc();
  registerControllerObservationIpc();
  registerControllerProxyIpc();
  registerControllerRuleIpc();
  const systemProxyService = registerSystemProxyIpc(userDataDir);
  const coreProcessService = registerCoreProcessIpc(userDataDir);
  const controllerLogService = registerControllerLogIpc(userDataDir);
  registerConnectionIpc({
    core: coreProcessService,
    controllerHealth: controllerHealthService,
    controllerLogs: controllerLogService,
    systemProxy: systemProxyService,
    configStore: createConfigStore(userDataDir)
  });
  let quitAfterCoreStop = false;

  app.on("before-quit", (event) => {
    if (
      quitAfterCoreStop ||
      (!coreProcessService.hasRunning() && !controllerLogService.hasRunning())
    ) {
      subscriptionScheduleService.stop();
      return;
    }

    event.preventDefault();
    quitAfterCoreStop = true;
    subscriptionScheduleService.stop();
    void Promise.all([controllerLogService.stopAll(), coreProcessService.stopAll()]).finally(() =>
      app.quit()
    );
  });

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
