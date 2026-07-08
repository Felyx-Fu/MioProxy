import { describe, expect, it, vi } from "vitest";
import type {
  ActivationStartInput,
  ControllerHealthResponse,
  ControllerLogActionResponse,
  ControllerLogStatusResponse,
  CoreProcessActionResponse,
  CoreProcessStatusResponse,
  SystemProxyActionResponse,
  SystemProxyStatusResponse
} from "../../shared/pipelineTypes.js";
import type { ControllerHealthService } from "../core/controllerHealthService.js";
import type { ControllerLogService } from "../core/controllerLogService.js";
import type { CoreProcessService } from "../core/coreProcessService.js";
import type { SystemProxyService } from "../system/systemProxyService.js";
import type { ConfigStore } from "@mioproxy/core-runtime";
import { createConnectionService } from "./connectionService.js";

describe("createConnectionService", () => {
  it("connects in order: core, health, logs, system proxy", async () => {
    const calls: string[] = [];
    const services = fakeServices(calls);
    const service = createConnectionService({
      ...services,
      configStore: fakeConfigStore(calls),
      sleep: async () => undefined
    });

    const result = await service.connect(input());

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["core.start", "health.check", "logs.start", "proxy.enable", "config.mark-lkg"]);
    expect(result.status).toMatchObject({
      profileId: "default",
      connected: true,
      steps: [
        { name: "start-core", ok: true },
        { name: "controller-health", ok: true },
        { name: "start-controller-logs", ok: true },
        { name: "enable-system-proxy", ok: true },
        { name: "mark-last-known-good", ok: true }
      ]
    });
  });

  it("retries health and rolls back when controller never becomes healthy", async () => {
    const calls: string[] = [];
    const services = fakeServices(calls, {
      health: {
        ok: false,
        online: false,
        checkedAt: "2026-07-07T10:00:00.000Z",
        error: { name: "Error", message: "connection refused" }
      }
    });
    const service = createConnectionService({
      ...services,
      configStore: fakeConfigStore(calls),
      sleep: async () => undefined
    });

    const result = await service.connect(input({ health: { attempts: 2, delayMs: 0 } }));

    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      "core.start",
      "health.check",
      "health.check",
      "proxy.status",
      "logs.status",
      "core.stop",
      "config.rollback-lkg"
    ]);
    expect(result.status.steps).toEqual([
      { name: "start-core", ok: true },
      { name: "controller-health", ok: false, errorMessage: "connection refused" }
    ]);
    expect(result.status.rollback).toMatchObject({
      systemProxy: { ok: true },
      controllerLogs: { ok: true },
      core: { ok: true },
      config: { ok: true }
    });
  });

  it("rolls back logs and core when system proxy enable fails", async () => {
    const calls: string[] = [];
    const services = fakeServices(calls, {
      proxyEnable: {
        ok: false,
        error: { name: "Error", message: "registry denied" },
        status: proxyStatus(false)
      }
    });
    const service = createConnectionService({
      ...services,
      configStore: fakeConfigStore(calls),
      sleep: async () => undefined
    });

    const result = await service.connect(input());

    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      "core.start",
      "health.check",
      "logs.start",
      "proxy.enable",
      "proxy.status",
      "logs.stop",
      "core.stop",
      "config.rollback-lkg"
    ]);
    expect(result.status.steps.at(-1)).toEqual({
      name: "enable-system-proxy",
      ok: false,
      errorMessage: "registry denied"
    });
  });

  it("records mark-last-known-good failures and rolls back the connection", async () => {
    const calls: string[] = [];
    const services = fakeServices(calls);
    const service = createConnectionService({
      ...services,
      configStore: fakeConfigStore(calls, { markError: new Error("copy failed") }),
      sleep: async () => undefined
    });

    const result = await service.connect(input());

    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      "core.start",
      "health.check",
      "logs.start",
      "proxy.enable",
      "config.mark-lkg",
      "proxy.restore",
      "logs.stop",
      "core.stop",
      "config.rollback-lkg"
    ]);
    expect(result.status.steps.at(-1)).toEqual({
      name: "mark-last-known-good",
      ok: false,
      errorMessage: "copy failed"
    });
  });

  it("disconnects in reverse order", async () => {
    const calls: string[] = [];
    const services = fakeServices(calls);
    const service = createConnectionService({
      ...services,
      configStore: fakeConfigStore(calls),
      sleep: async () => undefined
    });

    const result = await service.disconnect("default");

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["proxy.restore", "logs.stop", "core.stop", "config.rollback-lkg"]);
    expect(result.status).toMatchObject({
      profileId: "default",
      connected: false,
      steps: [
        { name: "restore-system-proxy", ok: true },
        { name: "stop-controller-logs", ok: true },
        { name: "stop-core", ok: true },
        { name: "restore-active-config", ok: true }
      ]
    });
  });
});

function input(partial: Partial<ActivationStartInput> = {}): ActivationStartInput {
  return {
    profileId: "default",
    binaryPath: "mihomo.exe",
    dataDir: "work",
    controller: {
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    },
    systemProxy: {
      host: "127.0.0.1",
      port: 7890,
      bypass: "localhost;127.*;<local>"
    },
    ...partial
  };
}

function fakeConfigStore(
  calls: string[],
  options: { markError?: Error; rollbackError?: Error } = {}
): ConfigStore {
  return {
    pathsForProfile: vi.fn(() => ({
      profileDir: "profile",
      candidatePath: "candidate.yaml",
      activePath: "active.yaml",
      lastKnownGoodPath: "last-known-good.yaml"
    })),
    writeCandidate: vi.fn(async () => "candidate.yaml"),
    promoteCandidateToActive: vi.fn(async () => "active.yaml"),
    markLastKnownGood: vi.fn(async () => {
      calls.push("config.mark-lkg");
      if (options.markError) {
        throw options.markError;
      }
      return "last-known-good.yaml";
    }),
    rollbackToLastKnownGood: vi.fn(async () => {
      calls.push("config.rollback-lkg");
      if (options.rollbackError) {
        throw options.rollbackError;
      }
      return "active.yaml";
    })
  };
}

function fakeServices(
  calls: string[],
  overrides: {
    health?: ControllerHealthResponse;
    proxyEnable?: SystemProxyActionResponse;
  } = {}
): {
  core: CoreProcessService;
  controllerHealth: ControllerHealthService;
  controllerLogs: ControllerLogService;
  systemProxy: SystemProxyService;
} {
  const coreStatus: CoreProcessStatusResponse = { profileId: "default", running: true };
  const logStatus: ControllerLogStatusResponse = { profileId: "default", running: true };

  return {
    core: {
      start: vi.fn(async () => {
        calls.push("core.start");
        return { ok: true, status: coreStatus } satisfies CoreProcessActionResponse;
      }),
      stop: vi.fn(async () => {
        calls.push("core.stop");
        return { ok: true, status: { profileId: "default", running: false } } satisfies CoreProcessActionResponse;
      }),
      stopAll: vi.fn(async () => []),
      status: vi.fn(() => {
        calls.push("core.status");
        return { profileId: "default", running: false };
      }),
      hasRunning: vi.fn(() => true)
    },
    controllerHealth: {
      check: vi.fn(async () => {
        calls.push("health.check");
        return overrides.health ?? healthOk();
      })
    },
    controllerLogs: {
      start: vi.fn(async () => {
        calls.push("logs.start");
        return { ok: true, status: logStatus } satisfies ControllerLogActionResponse;
      }),
      stop: vi.fn(async () => {
        calls.push("logs.stop");
        return {
          ok: true,
          status: { profileId: "default", running: false }
        } satisfies ControllerLogActionResponse;
      }),
      stopAll: vi.fn(async () => []),
      status: vi.fn(() => {
        calls.push("logs.status");
        return { profileId: "default", running: false };
      }),
      hasRunning: vi.fn(() => true)
    },
    systemProxy: {
      status: vi.fn(async () => {
        calls.push("proxy.status");
        return proxyStatus(false);
      }),
      enable: vi.fn(async () => {
        calls.push("proxy.enable");
        return overrides.proxyEnable ?? ({ ok: true, status: proxyStatus(true) } satisfies SystemProxyActionResponse);
      }),
      disable: vi.fn(async () => ({ ok: true, status: proxyStatus(false) } satisfies SystemProxyActionResponse)),
      restore: vi.fn(async () => {
        calls.push("proxy.restore");
        return { ok: true, status: proxyStatus(false) } satisfies SystemProxyActionResponse;
      })
    }
  };
}

function healthOk(): ControllerHealthResponse {
  return {
    ok: true,
    online: true,
    checkedAt: "2026-07-07T10:00:00.000Z",
    version: { version: "v1.19.1" },
    config: { mixedPort: 7890 },
    versionStatus: 200,
    configsStatus: 200
  };
}

function proxyStatus(enabled: boolean): SystemProxyStatusResponse {
  return {
    supported: true,
    enabled,
    managedSnapshot: true
  };
}
