import "@testing-library/jest-dom/vitest";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreStatus, ProxiesResponse, ServiceConnectionStatus } from "./api/mihomo";
import { AppearanceProvider } from "./appearance/AppearanceProvider";
import App from "./App";
import { I18nProvider } from "./i18n/I18nProvider";

type InvokeHandler = (command: string, args?: InvokeArgs) => unknown;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function readyStatus(): CoreStatus {
  return { state: "ready", running: true, controller: "127.0.0.1:19090", configPath: "config.yaml", mixedPort: 7890, mode: "rule", recoveryMessage: null };
}

function stoppedStatus(): CoreStatus {
  return { ...readyStatus(), state: "stopped", running: false };
}

function serviceStatus(state: ServiceConnectionStatus["state"], reachable: boolean, error: string | null = null): ServiceConnectionStatus {
  return {
    state,
    reachable,
    protocolVersion: 1,
    serviceVersion: "1.0.1",
    versionMismatch: false,
    error,
    admin: true,
    ownsCore: true,
    coreRunning: reachable,
    ownershipConflict: false,
    tunStatus: "disabled",
    tunMessage: null,
    desiredCoreRunning: true,
    coreRecoveryMessage: null,
    connectivity: reachable ? "ready" : "transient",
  };
}

function proxySnapshot(current: string, nodes: string[] = [current]): ProxiesResponse {
  return {
    proxies: {
      PROXY: { type: "Selector", now: current, all: nodes, testUrl: "https://proxy.example.test/204" },
      ...Object.fromEntries(nodes.map((node) => [node, { type: "Vmess" }])),
    },
  };
}

function baseInvoke(command: string) {
  switch (command) {
    case "mihomo_status":
      return readyStatus();
    case "mihomo_version":
      return { meta: true, version: "1.19.29" };
    case "mihomo_proxies":
      return { proxies: {} };
    case "mihomo_proxy_delay":
      return { delay: 42 };
    case "mihomo_connections":
      return { downloadTotal: 0, uploadTotal: 0, memory: 0, connections: [] };
    case "system_proxy_status":
      return { enabled: false, coreRunning: true, mixedPort: 7890, proxyServer: "127.0.0.1:7890", managed: true, desiredEnabled: false, actualState: "disabled", owner: "none", externalDetected: false, windowsState: "disabled", stateConsistent: true };
    case "startup_status":
      return { enabled: false, startMinimized: false };
    case "tun_status":
      return { status: "stopped", message: null, admin: true, profileId: null, snapshot: null, desiredEnabled: false, actualState: "disabled", owner: "none", externalDetected: false, projection: "off" };
    case "service_status_command":
      return serviceStatus("running", true);
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

function installIPC(handler: InvokeHandler) {
  mockIPC((command: string, args?: InvokeArgs) => handler(command, args), { shouldMockEvents: true });
}

function renderApp() {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      } as MediaQueryList),
    });
  }
  (window as Window & { __MIOPROXY_VISUAL_PREVIEW__?: boolean }).__MIOPROXY_VISUAL_PREVIEW__ = true;
  render(
    <I18nProvider>
      <AppearanceProvider>
        <App />
      </AppearanceProvider>
    </I18nProvider>,
  );
}

async function advanceTimers(milliseconds: number) {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function resolveDeferred<T>(request: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    request.resolve(value);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function coreRow() {
  return screen.getByText("Core", { exact: true, selector: "dt" }).parentElement as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("App refresh response sequencing", () => {
  it("keeps the newer Core status when an older refresh resolves later", async () => {
    vi.useFakeTimers();
    const first = deferred<CoreStatus>();
    const second = deferred<CoreStatus>();
    const firstStarted = deferred<void>();
    let statusCalls = 0;

    installIPC((command) => {
      if (command === "mihomo_status") {
        statusCalls += 1;
        if (statusCalls === 1) {
          firstStarted.resolve();
          return first.promise;
        }
        if (statusCalls === 2) return second.promise;
      }
      return baseInvoke(command);
    });

    renderApp();
    await firstStarted.promise;
    await advanceTimers(2500);
    expect(statusCalls).toBeGreaterThanOrEqual(2);

    await resolveDeferred(second, readyStatus());
    expect(coreRow()).toHaveTextContent("Ready");
    await resolveDeferred(first, stoppedStatus());

    expect(coreRow()).toHaveTextContent("Ready");
  });

  it("does not replace a healthy Core state with an older refresh error", async () => {
    vi.useFakeTimers();
    const first = deferred<CoreStatus>();
    const second = deferred<CoreStatus>();
    const firstStarted = deferred<void>();
    let statusCalls = 0;

    installIPC((command) => {
      if (command === "mihomo_status") {
        statusCalls += 1;
        if (statusCalls === 1) {
          firstStarted.resolve();
          return first.promise;
        }
        if (statusCalls === 2) return second.promise;
      }
      return baseInvoke(command);
    });

    renderApp();
    await firstStarted.promise;
    await advanceTimers(2500);
    expect(statusCalls).toBeGreaterThanOrEqual(2);

    await resolveDeferred(second, readyStatus());
    expect(coreRow()).toHaveTextContent("Ready");
    await act(async () => {
      first.reject(new Error("late Core refresh failure"));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(coreRow()).toHaveTextContent("Ready");
    expect(screen.queryByText("late Core refresh failure")).not.toBeInTheDocument();
  });

  it("keeps the newer running Service state when an older response resolves later", async () => {
    vi.useFakeTimers();
    const first = deferred<ServiceConnectionStatus>();
    const second = deferred<ServiceConnectionStatus>();
    const firstStarted = deferred<void>();
    let serviceCalls = 0;

    installIPC((command) => {
      if (command === "service_status_command") {
        serviceCalls += 1;
        if (serviceCalls === 1) {
          firstStarted.resolve();
          return first.promise;
        }
        if (serviceCalls === 2) return second.promise;
      }
      return baseInvoke(command);
    });

    renderApp();
    await firstStarted.promise;
    await advanceTimers(2500);
    expect(serviceCalls).toBeGreaterThanOrEqual(2);

    await resolveDeferred(second, serviceStatus("running", true));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    const serviceRow = screen.getByText("Background Service", { exact: true }).closest("article") as HTMLElement;
    expect(serviceRow).toHaveTextContent("Running");

    await resolveDeferred(first, serviceStatus("stopped", false, "late service response"));
    expect(serviceRow).toHaveTextContent("Running");
  });

  it("applies the newest proxy snapshot and ignores an older poll response", async () => {
    vi.useFakeTimers();
    const first = deferred<ProxiesResponse>();
    const second = deferred<ProxiesResponse>();
    const firstStarted = deferred<void>();
    let proxyCalls = 0;

    installIPC((command) => {
      if (command === "mihomo_proxies") {
        proxyCalls += 1;
        if (proxyCalls === 1) {
          firstStarted.resolve();
          return first.promise;
        }
        if (proxyCalls === 2) return second.promise;
      }
      return baseInvoke(command);
    });

    renderApp();
    await firstStarted.promise;
    fireEvent.click(screen.getByRole("button", { name: "Proxies" }));
    await advanceTimers(5000);
    expect(proxyCalls).toBeGreaterThanOrEqual(2);

    await resolveDeferred(second, proxySnapshot("New Node"));
    expect(screen.getAllByText("New Node", { exact: true }).length).toBeGreaterThan(0);
    await resolveDeferred(first, proxySnapshot("Old Node"));

    expect(screen.getAllByText("New Node", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Old Node", { exact: true })).not.toBeInTheDocument();
  });

  it("does not let a proxy response from before core stop repopulate the page", async () => {
    const first = deferred<ProxiesResponse>();
    const firstStarted = deferred<void>();

    installIPC((command) => {
      if (command === "mihomo_proxies") {
        firstStarted.resolve();
        return first.promise;
      }
      return baseInvoke(command);
    });

    renderApp();
    await firstStarted.promise;
    fireEvent.click(await screen.findByRole("button", { name: "Proxies" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await emit("mihomo-stopped");
    await resolveDeferred(first, proxySnapshot("Stale Node"));

    await waitFor(() => {
      expect(screen.queryByText("Stale Node", { exact: true })).not.toBeInTheDocument();
      expect(screen.getByText("No Profiles yet", { exact: true })).toBeInTheDocument();
    });
  });

  it("lets an authoritative proxy-selection refresh supersede an older poll", async () => {
    vi.useFakeTimers();
    const background = deferred<ProxiesResponse>();
    let proxyCalls = 0;
    const initial = proxySnapshot("Active Node", ["Active Node", "Candidate Node"]);

    installIPC((command) => {
      if (command === "mihomo_proxies") {
        proxyCalls += 1;
        if (proxyCalls === 1) return initial;
        if (proxyCalls === 2) return background.promise;
        return proxySnapshot("Selected Node");
      }
      if (command === "mihomo_select_proxy") return null;
      return baseInvoke(command);
    });

    renderApp();
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Proxies" }));
    const candidate = screen.getByText("Candidate Node", { exact: true }).closest("article") as HTMLElement;
    await advanceTimers(5000);
    expect(proxyCalls).toBeGreaterThanOrEqual(2);

    fireEvent.click(within(candidate).getByRole("button", { name: "Use node" }));
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(proxyCalls).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("Selected Node", { exact: true }).length).toBeGreaterThan(0);

    await resolveDeferred(background, proxySnapshot("Background Node"));
    expect(screen.getAllByText("Selected Node", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Background Node", { exact: true })).not.toBeInTheDocument();
  });
});
