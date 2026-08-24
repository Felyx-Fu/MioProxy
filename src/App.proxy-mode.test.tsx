import "@testing-library/jest-dom/vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreMode } from "./api/mihomo";
import App from "./App";
import { I18nProvider } from "./i18n/I18nProvider";

type ModeHandler = (command: string, args?: InvokeArgs) => unknown;

function commonInvoke(command: string, mode: CoreMode) {
  switch (command) {
    case "mihomo_status":
      return { state: "ready", running: true, controller: "127.0.0.1:19090", configPath: "config.yaml", mixedPort: 7890, mode, recoveryMessage: null };
    case "mihomo_version":
      return { meta: true, version: "1.19.29" };
    case "mihomo_proxies":
      return { proxies: {} };
    case "mihomo_connections":
      return { downloadTotal: 0, uploadTotal: 0, memory: 0, connections: [] };
    case "system_proxy_status":
      return { enabled: false, coreRunning: true, mixedPort: 7890, proxyServer: "127.0.0.1:7890", managed: true, desiredEnabled: false, actualState: "disabled", owner: "none", externalDetected: false, windowsState: "disabled", stateConsistent: true };
    case "startup_status":
      return { enabled: false, startMinimized: false };
    case "tun_status":
      return { status: "stopped", message: null, admin: true, profileId: null, snapshot: null, desiredEnabled: false, actualState: "disabled", owner: "none", externalDetected: false, projection: "off" };
    case "service_status_command":
      return { state: "running", reachable: true, protocolVersion: 1, serviceVersion: "1.0.1", versionMismatch: false, error: null, admin: true, ownsCore: true, coreRunning: true, ownershipConflict: false, tunStatus: "stopped", tunMessage: null, desiredCoreRunning: true, coreRecoveryMessage: null, connectivity: "ready" };
    case "profile_list":
      return [];
    case "update_preferences_status":
      return { checkOnStartup: false, autoDownload: false };
    case "update_status":
      return { currentVersion: "1.0.1", updating: false, checkpoint: null, recoveryError: null };
    case "mihomo_core_update_status":
      return { currentVersion: "1.19.29", availableVersion: null, assetName: null, phase: "idle", error: null };
    default:
      return null;
  }
}

function installIPC(handler: ModeHandler) {
  mockIPC((command: string, args?: InvokeArgs) => handler(command, args), { shouldMockEvents: true });
}

function renderApp() {
  (window as Window & { __MIOPROXY_VISUAL_PREVIEW__?: boolean }).__MIOPROXY_VISUAL_PREVIEW__ = true;
  render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
}

afterEach(() => cleanup());

describe("Proxy traffic mode synchronization", () => {
  it("updates the selector only after the follow-up authoritative status read", async () => {
    let mode: CoreMode = "rule";
    const calls: string[] = [];
    installIPC((command, args) => {
      calls.push(command);
      if (command === "mihomo_set_mode") {
        expect(args).toEqual({ mode: "global" });
        mode = "global";
        // The UI must not trust this mutation response as its final state.
        return { state: "ready", running: true, controller: "127.0.0.1:19090", configPath: "config.yaml", mixedPort: 7890, mode: "rule", recoveryMessage: null };
      }
      return commonInvoke(command, mode);
    });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Proxies" }));
    await screen.findByText("Choose how traffic is routed");
    const modeGroup = screen.getByRole("group", { name: "Traffic mode" });
    fireEvent.click(within(modeGroup).getByRole("button", { name: /Global/ }));

    await waitFor(() => {
      expect(within(modeGroup).getByRole("button", { name: /Global/ })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Mihomo 模式已切换为 global")).toBeInTheDocument();
    });
    expect(calls.indexOf("mihomo_set_mode")).toBeGreaterThan(-1);
    expect(calls.lastIndexOf("mihomo_status")).toBeGreaterThan(calls.indexOf("mihomo_set_mode"));
  });

  it("keeps the previous authoritative mode selected when the mutation fails", async () => {
    let mode: CoreMode = "rule";
    installIPC((command) => {
      if (command === "mihomo_set_mode") throw new Error("Controller rejected mode");
      return commonInvoke(command, mode);
    });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Proxies" }));
    await screen.findByText("Choose how traffic is routed");
    const modeGroup = screen.getByRole("group", { name: "Traffic mode" });
    fireEvent.click(within(modeGroup).getByRole("button", { name: /Global/ }));

    await waitFor(() => {
      expect(within(modeGroup).getByRole("button", { name: /Rule/ })).toHaveAttribute("aria-pressed", "true");
      expect(within(modeGroup).getByRole("button", { name: /Global/ })).toHaveAttribute("aria-pressed", "false");
      expect(document.querySelector(".toast-error")).toHaveTextContent("Controller rejected mode");
    });
  });
});
