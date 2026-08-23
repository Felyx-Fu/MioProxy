import "@testing-library/jest-dom/vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n/I18nProvider";
import App from "./App";

type InvokeRecord = { command: string; args?: InvokeArgs };

describe("App automatic proxy latency", () => {
  let calls: InvokeRecord[];

  beforeEach(() => {
    calls = [];
    (window as Window & { __MIOPROXY_VISUAL_PREVIEW__?: boolean }).__MIOPROXY_VISUAL_PREVIEW__ = true;
    mockIPC((command: string, args?: InvokeArgs) => {
      calls.push({ command, args });
      switch (command) {
        case "mihomo_status":
          return { state: "ready", running: true, controller: "127.0.0.1:19090", configPath: "config.yaml", mixedPort: 7890, mode: "rule", recoveryMessage: null };
        case "mihomo_version":
          return { meta: true, version: "1.19.29" };
        case "mihomo_proxies":
          return {
            proxies: {
              PROXY: {
                type: "Selector",
                now: "same node",
                all: ["same node"],
                testUrl: "https://active.example.test/204",
                memberContexts: {
                  "same node": { kind: "provider", provider: "PROXY", providerResolution: "resolved" },
                },
              },
              "same node": { type: "Vmess", "provider-name": "" },
            },
          };
        case "mihomo_proxy_delay":
          return { delay: 137 };
        case "mihomo_connections":
          return { downloadTotal: 0, uploadTotal: 0, memory: 0, connections: [] };
        case "system_proxy_status":
          return { enabled: false, coreRunning: true, mixedPort: 7890, proxyServer: "127.0.0.1:7890", managed: true, desiredEnabled: false, actualState: "disabled", owner: "mioproxy", externalDetected: false, windowsState: "disabled", stateConsistent: true };
        case "startup_status":
          return { enabled: false, startMinimized: false };
        case "tun_status":
          return { status: "stopped", message: null, admin: true, profileId: null, snapshot: null, desiredEnabled: false, actualState: "disabled", owner: "mioproxy", externalDetected: false };
        case "service_status_command":
          return { reachable: true, protocolVersion: 1, serviceVersion: "1.0.1", versionMismatch: false, error: null, admin: true, ownsCore: true, coreRunning: true, ownershipConflict: false, tunStatus: "stopped", tunMessage: null, desiredCoreRunning: true, coreRecoveryMessage: null };
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
    }, { shouldMockEvents: true });
  });

  afterEach(() => cleanup());

  it("passes the active group's URL and provider identity to automatic latency testing", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(calls.some(({ command }) => command === "mihomo_proxy_delay")).toBe(true);
    });
    const delayCall = calls.find(({ command }) => command === "mihomo_proxy_delay");
    expect(delayCall?.args).toEqual({
      request: {
        group: "PROXY",
        proxy: "same node",
        provider: "PROXY",
        testUrl: "https://active.example.test/204",
        kind: "provider",
      },
    });
  });
});
