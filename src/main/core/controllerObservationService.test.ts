import { describe, expect, it, vi } from "vitest";
import type { ControllerClient, ControllerClientResult } from "@mioproxy/core-runtime";
import { createControllerObservationService } from "./controllerObservationService.js";

describe("createControllerObservationService", () => {
  it("summarizes traffic and active connections", async () => {
    const client = fakeClient({
      traffic: ok(JSON.stringify({ up: 1024, down: 2048 })),
      connections: ok(
        JSON.stringify({
          uploadTotal: 4096,
          downloadTotal: 8192,
          connections: [
            {
              id: "conn-1",
              upload: 100,
              download: 200,
              rule: "RuleSet",
              rulePayload: "streaming",
              chains: ["Proxy", "Node A"],
              start: "2026-07-07T10:00:00.000Z",
              metadata: {
                network: "tcp",
                type: "HTTP",
                host: "example.test",
                destinationPort: 443,
                process: "browser.exe"
              }
            }
          ]
        })
      )
    });
    const service = createControllerObservationService({
      clientFactory: vi.fn(() => client),
      now: () => new Date("2026-07-07T10:05:00.000Z")
    });

    const result = await service.snapshot({
      baseUrl: " http://127.0.0.1:9090 ",
      secret: " secret "
    });

    expect(result).toMatchObject({
      ok: true,
      checkedAt: "2026-07-07T10:05:00.000Z",
      traffic: { upload: 1024, download: 2048 },
      connections: {
        uploadTotal: 4096,
        downloadTotal: 8192,
        count: 1,
        items: [
          {
            id: "conn-1",
            network: "tcp",
            type: "HTTP",
            host: "example.test",
            destination: "example.test:443",
            rule: "RuleSet",
            rulePayload: "streaming",
            chain: ["Proxy", "Node A"],
            upload: 100,
            download: 200,
            process: "browser.exe"
          }
        ]
      },
      trafficStatus: 200,
      connectionsStatus: 200
    });
  });

  it("returns a safe failure response when a controller request fails", async () => {
    const service = createControllerObservationService({
      clientFactory: () =>
        fakeClient({
          traffic: ok(JSON.stringify({ up: 1, down: 2 })),
          connections: fail("Mihomo controller request failed with HTTP 401", 401)
        })
    });

    const result = await service.snapshot({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: "Mihomo controller request failed with HTTP 401" },
      trafficStatus: 200,
      connectionsStatus: 401
    });
  });

  it("returns JSON parse failures without throwing", async () => {
    const service = createControllerObservationService({
      clientFactory: () =>
        fakeClient({
          traffic: ok("not-json"),
          connections: ok(JSON.stringify({ connections: [] }))
        })
    });

    const result = await service.snapshot({
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
  traffic: ControllerClientResult;
  connections: ControllerClientResult;
}): ControllerClient {
  return {
    getVersion: vi.fn(async () => ok("")),
    getConfigs: vi.fn(async () => ok("")),
    getTraffic: vi.fn(async () => results.traffic),
    getConnections: vi.fn(async () => results.connections),
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
