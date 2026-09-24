import "@testing-library/jest-dom/vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n/I18nProvider";
import App from "./App";

type InvokeRecord = { command: string; args?: InvokeArgs };

const initialProfile = {
  id: "profile-1",
  name: "example",
  url: "https://example.test/subscribe",
  filePath: null,
  updatedAt: null,
  nodeCount: null,
};

const downloadedProfile = {
  ...initialProfile,
  filePath: "C:\\Users\\tester\\AppData\\Roaming\\MioProxy\\profiles\\profile-1.yaml",
  updatedAt: 1_700_000_000,
  nodeCount: 2,
};

function renderApp() {
  (window as Window & { __MIOPROXY_VISUAL_PREVIEW__?: boolean }).__MIOPROXY_VISUAL_PREVIEW__ = true;
  render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
}

function installIPC(calls: InvokeRecord[]) {
  mockIPC((command: string, args?: InvokeArgs) => {
    calls.push({ command, args });
    switch (command) {
      case "mihomo_status":
        return { state: "ready", running: true, controller: "127.0.0.1:19090", configPath: "config.yaml", mixedPort: 7890, mode: "rule", recoveryMessage: null };
      case "mihomo_version":
        return { meta: true, version: "1.19.29" };
      case "mihomo_proxies":
        return { proxies: { PROXY: { type: "Selector", now: "node-a", all: ["node-a", "node-b"] }, "node-a": { type: "Vmess" }, "node-b": { type: "Vmess" } } };
      case "mihomo_proxy_delay":
        return { delay: 100 };
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
      case "profile_add":
        return initialProfile;
      case "profile_download":
        return downloadedProfile;
      case "profile_apply":
        return downloadedProfile.filePath;
      case "update_preferences_status":
        return { checkOnStartup: false, autoDownload: false };
      case "update_status":
        return { currentVersion: "1.0.1", updating: false, checkpoint: null, recoveryError: null };
      case "mihomo_core_update_status":
        return { currentVersion: "1.19.29", availableVersion: null, assetName: null, phase: "idle", error: null };
      default:
        return null;
    }
  }, { shouldMockEvents: true });
}

describe("Profile import workflow", () => {
  afterEach(() => cleanup());

  it("downloads and enables an imported Profile without selecting a node or changing traffic mode", async () => {
    const calls: InvokeRecord[] = [];
    installIPC(calls);
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Profiles" }));
    fireEvent.change(screen.getByLabelText("Subscription URL"), { target: { value: initialProfile.url } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(calls.some(({ command }) => command === "profile_apply")).toBe(true);
      expect(screen.getByRole("button", { name: "Enabled this session" })).toBeInTheDocument();
    });

    const workflowCommands = calls
      .map(({ command }) => command)
      .filter((command) => ["profile_add", "profile_download", "profile_apply"].includes(command));
    expect(workflowCommands).toEqual(["profile_add", "profile_download", "profile_apply"]);
    expect(calls.some(({ command }) => command === "mihomo_select_proxy")).toBe(false);
    expect(calls.some(({ command }) => command === "mihomo_set_mode")).toBe(false);
    expect(calls.some(({ command }) => command === "system_proxy_set_enabled")).toBe(false);
    expect(calls.some(({ command }) => command === "tun_set_enabled")).toBe(false);
  });
});
