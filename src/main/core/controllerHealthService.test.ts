import { describe, expect, it, vi } from "vitest";
import type { ControllerClient, ControllerClientResult } from "@mioproxy/core-runtime";
import { createControllerHealthService } from "./controllerHealthService.js";

describe("createControllerHealthService", () => {
  it("summarizes controller version and running config", async () => {
    const client = fakeClient({
      version: ok(JSON.stringify({ version: "v1.19.1", meta: true })),
      configs: ok(
        JSON.stringify({
          mode: "rule",
          "log-level": "info",
          "mixed-port": 7890,
          "allow-lan": false,
          tun: { enable: true }
        })
      )
    });
    const service = createControllerHealthService({
      clientFactory: vi.fn(() => client)
    });

    const result = await service.check({
      baseUrl: " http://127.0.0.1:9090 ",
      secret: " secret "
    });

    expect(result).toMatchObject({
      ok: true,
      online: true,
      version: { version: "v1.19.1", meta: true },
      config: {
        mode: "rule",
        logLevel: "info",
        mixedPort: 7890,
        allowLan: false,
        tunEnabled: true
      },
      versionStatus: 200,
      configsStatus: 200
    });
  });

  it("returns a safe failure response when a controller request fails", async () => {
    const service = createControllerHealthService({
      clientFactory: () =>
        fakeClient({
          version: ok(JSON.stringify({ version: "v1.19.1" })),
          configs: fail("Mihomo controller request failed with HTTP 401", 401)
        })
    });

    const result = await service.check({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    });

    expect(result).toMatchObject({
      ok: false,
      online: false,
      error: { message: "Mihomo controller request failed with HTTP 401" },
      versionStatus: 200,
      configsStatus: 401
    });
  });

  it("returns JSON parse failures without throwing", async () => {
    const service = createControllerHealthService({
      clientFactory: () =>
        fakeClient({
          version: ok("not-json"),
          configs: ok(JSON.stringify({ mode: "rule" }))
        })
    });

    const result = await service.check({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unexpected token");
    }
  });
});

function fakeClient(results: {
  version: ControllerClientResult;
  configs: ControllerClientResult;
}): ControllerClient {
  return {
    getVersion: vi.fn(async () => results.version),
    getConfigs: vi.fn(async () => results.configs),
    getTraffic: vi.fn(async () => ok("")),
    getConnections: vi.fn(async () => ok("")),
    getProxies: vi.fn(async () => ok("")),
    getRules: vi.fn(async () => ok("")),
    getRuleProviders: vi.fn(async () => ok("")),
    switchProxy: vi.fn(async () => ok("")),
    testProxyDelay: vi.fn(async () => ok("")),
    reloadConfig: vi.fn(async () => ok("")),
    restart: vi.fn(async () => ok(""))
  };
}

function ok(body: string): ControllerClientResult {
  return { ok: true, status: 200, body };
}

function fail(message: string, status: number): ControllerClientResult {
  return {
    ok: false,
    status,
    body: "",
    timedOut: false,
    error: new Error(message)
  };
}
