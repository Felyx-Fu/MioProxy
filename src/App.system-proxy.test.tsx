import "@testing-library/jest-dom/vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemProxyStatus } from "./api/mihomo";
import App from "./App";
import { I18nProvider } from "./i18n/I18nProvider";

type SystemProxyHandler = (command: string, args?: InvokeArgs) => unknown;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function systemProxyStatus(enabled: boolean, external = false): SystemProxyStatus {
  return {
    enabled: external ? false : enabled,
    coreRunning: true,
    mixedPort: 7890,
    proxyServer: external ? "192.0.2.10:8888" : "127.0.0.1:7890",
    managed: true,
    desiredEnabled: external ? false : enabled,
    actualState: external ? "externalEndpoint" : enabled ? "mioproxyEndpoint" : "disabled",
    owner: external ? "external" : enabled ? "mioproxy" : "none",
    externalDetected: external,
    windowsState: external ? "external" : enabled ? "mioproxy" : "disabled",
    stateConsistent: true,
  };
}

function baseInvoke(command: string) {
  switch (command) {
    case "mihomo_status":
      return { state: "ready", running: true, controller: "127.0.0.1:19090", configPath: "config.yaml", mixedPort: 7890, mode: "rule", recoveryMessage: null };
    case "mihomo_version":
      return { meta: true, version: "1.19.29" };
    case "mihomo_proxies":
      return { proxies: {} };
    case "mihomo_connections":
      return { downloadTotal: 0, uploadTotal: 0, memory: 0, connections: [] };
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

function installIPC(systemProxyHandler: SystemProxyHandler) {
  mockIPC((command: string, args?: InvokeArgs) => {
    if (command === "system_proxy_status" || command === "system_proxy_set_enabled") {
      return systemProxyHandler(command, args);
    }
    return baseInvoke(command);
  }, { shouldMockEvents: true });
}

function renderApp() {
  (window as Window & { __MIOPROXY_VISUAL_PREVIEW__?: boolean }).__MIOPROXY_VISUAL_PREVIEW__ = true;
  render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
}

function systemProxyRow() {
  return screen.getByText("System Proxy", { exact: true, selector: "dt" }).parentElement as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe("Dashboard System Proxy synchronization", () => {
  it("renders an initially disabled snapshot with an Enable proxy action", async () => {
    installIPC((command) => command === "system_proxy_status" ? systemProxyStatus(false) : systemProxyStatus(false));

    renderApp();

    await screen.findByText("System Proxy", { exact: true, selector: "dt" });
    expect(systemProxyRow()).toHaveTextContent("Disabled");
    expect(screen.getByRole("button", { name: "Enable proxy" })).toBeInTheDocument();
  });

  it("waits for authoritative enable status before showing the success toast", async () => {
    let commandReturned = false;
    let observedEnabled = false;
    const authoritativeRefresh = deferred<SystemProxyStatus>();
    let statusCalls = 0;

    installIPC((command) => {
      if (command === "system_proxy_status") {
        statusCalls += 1;
        if (commandReturned) return authoritativeRefresh.promise;
        return systemProxyStatus(false);
      }
      commandReturned = true;
      observedEnabled = true;
      // The command response is intentionally stale; the subsequent status
      // read is the only result the UI is allowed to use as final state.
      return systemProxyStatus(false);
    });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Enable proxy" }));

    await waitFor(() => {
      expect(statusCalls).toBeGreaterThanOrEqual(3);
      expect(screen.getByRole("button", { name: "Working…" })).toBeInTheDocument();
      expect(screen.getByText("Pending", { exact: true })).toBeInTheDocument();
    });
    expect(observedEnabled).toBe(true);
    expect(screen.queryByText("系统代理已开启")).not.toBeInTheDocument();

    authoritativeRefresh.resolve(systemProxyStatus(true));

    await waitFor(() => {
      expect(systemProxyRow()).toHaveTextContent("Enabled");
      expect(screen.getByRole("button", { name: "Disable proxy" })).toBeInTheDocument();
      expect(screen.getByText("System Proxy", { exact: true, selector: "small" })).toBeInTheDocument();
      expect(screen.getByText("系统代理已开启")).toBeInTheDocument();
    });
  });

  it("keeps the observed state and reports a mismatch when enable is not confirmed", async () => {
    let commandReturned = false;

    installIPC((command) => {
      if (command === "system_proxy_status") return systemProxyStatus(false);
      commandReturned = true;
      // The mutation claims success, but the authoritative read remains off.
      return systemProxyStatus(true);
    });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Enable proxy" }));

    await waitFor(() => {
      expect(commandReturned).toBe(true);
      expect(systemProxyRow()).toHaveTextContent("Disabled");
      expect(screen.getByRole("button", { name: "Enable proxy" })).toBeInTheDocument();
      expect(document.querySelector(".toast-error")).toHaveTextContent("系统代理命令已返回成功，但权威状态仍为已关闭（预期已开启）");
    });
    expect(screen.queryByText("系统代理已开启")).not.toBeInTheDocument();
  });

  it("uses the refreshed disabled snapshot after a successful disable", async () => {
    let commandReturned = false;

    installIPC((command) => {
      if (command === "system_proxy_status") return systemProxyStatus(commandReturned ? false : true);
      commandReturned = true;
      // Keep the command return stale so this test exercises the post-action
      // system_proxy_status call rather than the mutation response.
      return systemProxyStatus(true);
    });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Disable proxy" }));

    await waitFor(() => {
      expect(systemProxyRow()).toHaveTextContent("Disabled");
      expect(screen.getByRole("button", { name: "Enable proxy" })).toBeInTheDocument();
      expect(screen.getByText("系统代理已关闭")).toBeInTheDocument();
    });
  });

  it("ignores an older in-flight refresh after the successful enable action", async () => {
    const initialRefreshStarted = deferred<void>();
    const initialRefresh = deferred<SystemProxyStatus>();
    let statusCalls = 0;
    let commandReturned = false;

    installIPC((command) => {
      if (command === "system_proxy_status") {
        statusCalls += 1;
        if (statusCalls === 1) {
          initialRefreshStarted.resolve();
          return initialRefresh.promise;
        }
        return systemProxyStatus(commandReturned);
      }
      commandReturned = true;
      return systemProxyStatus(false);
    });

    renderApp();
    await initialRefreshStarted.promise;
    fireEvent.click(await screen.findByRole("button", { name: "Enable proxy" }));

    await waitFor(() => {
      expect(systemProxyRow()).toHaveTextContent("Enabled");
      expect(screen.getByRole("button", { name: "Disable proxy" })).toBeInTheDocument();
    });

    initialRefresh.resolve(systemProxyStatus(false));

    await waitFor(() => {
      expect(systemProxyRow()).toHaveTextContent("Enabled");
      expect(screen.getByRole("button", { name: "Disable proxy" })).toBeInTheDocument();
    });
  });

  it("does not take over an externally owned System Proxy", async () => {
    let setCalls = 0;

    installIPC((command) => {
      if (command === "system_proxy_status") return systemProxyStatus(false, true);
      setCalls += 1;
      return systemProxyStatus(false, true);
    });

    renderApp();

    const button = await screen.findByRole("button", { name: "External proxy" });
    expect(button).toBeDisabled();
    expect(setCalls).toBe(0);
  });
});
