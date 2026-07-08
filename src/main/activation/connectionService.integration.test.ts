import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClashPartyImportService } from "../migration/clashPartyImportService.js";
import { createProfilePipelineService } from "../pipeline/profilePipelineService.js";
import { createControllerHealthService } from "../core/controllerHealthService.js";
import { createControllerLogService } from "../core/controllerLogService.js";
import { createCoreProcessService } from "../core/coreProcessService.js";
import { createConnectionService } from "./connectionService.js";
import type {
  SystemProxyActionResponse,
  SystemProxyStatusResponse
} from "../../shared/pipelineTypes.js";

const clashPartySource = process.env.MIOPROXY_CLASH_PARTY_SOURCE;
const mihomoBinary = process.env.MIOPROXY_MIHOMO_BINARY;
const describeIfReady = clashPartySource && mihomoBinary ? describe : describe.skip;
let appDataDir: string;
let workDir: string;

beforeEach(async () => {
  appDataDir = await mkdtemp(join(tmpdir(), "mioproxy-real-connection-"));
  workDir = await mkdtemp(join(tmpdir(), "mioproxy-real-connection-work-"));
});

afterEach(async () => {
  await rm(appDataDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

function response(body: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => body
  } as Response;
}

describeIfReady("createConnectionService real core health", () => {
  it("starts a real Mihomo core and reaches controller health without changing system proxy", async () => {
    const controllerPort = await freePort();
    const mixedPort = await freePort();
    const controllerBaseUrl = `http://127.0.0.1:${controllerPort}`;
    const secret = "integration-secret";
    const importResult = await createClashPartyImportService({ appDataDir }).importFrom({
      sourceDir: clashPartySource ?? ""
    });
    const profile = importResult.profiles.find((item) => item.cacheImported) ?? importResult.profiles[0];
    expect(profile).toBeDefined();
    await cp(join(clashPartySource ?? "", "work"), workDir, {
      recursive: true,
      filter: (source) => !basename(source).endsWith(".db")
    });
    const pipeline = createProfilePipelineService({
      appDataDir,
      fetcher: vi.fn(async () => {
        throw new Error("network disabled for connection validation");
      }) as unknown as typeof fetch,
      controllerFetcher: vi.fn(async () => response("", { status: 204 })) as unknown as typeof fetch
    });
    const pipelineResult = await pipeline.prepareProfile({
      profileId: profile?.profileId ?? "",
      subscription: {
        url: profile?.subscriptionUrl || "https://example.invalid/sub.yaml",
        retries: 1
      },
      yamlOverrides: [{ id: "runtime-ports", value: { "mixed-port": mixedPort } }],
      checker: {
        binaryPath: mihomoBinary ?? "",
        dataDir: workDir,
        timeoutMs: 30_000
      },
      controller: {
        baseUrl: controllerBaseUrl,
        secret
      }
    });
    expect(pipelineResult.ok).toBe(true);
    const core = createCoreProcessService({ appDataDir });
    const controllerLogs = createControllerLogService({ appDataDir });
    const connection = createConnectionService({
      core,
      controllerHealth: createControllerHealthService(),
      controllerLogs,
      systemProxy: fakeSystemProxy(),
      sleep: async (timeoutMs) => {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      }
    });

    const connected = await connection.connect({
      profileId: profile?.profileId ?? "",
      binaryPath: mihomoBinary ?? "",
      dataDir: workDir,
      controller: {
        baseUrl: controllerBaseUrl,
        secret,
        timeoutMs: 2_000
      },
      systemProxy: {
        host: "127.0.0.1",
        port: mixedPort
      },
      startControllerLogs: true,
      enableSystemProxy: false,
      health: {
        attempts: 10,
        delayMs: 300
      }
    });

    expect(connected.ok).toBe(true);
    if (connected.ok) {
      expect(connected.status.health?.ok).toBe(true);
      const health = connected.status.health;
      if (!health?.ok) {
        throw new Error("Expected controller health to be ok");
      }
      expect(health.config.mixedPort).toBe(mixedPort);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(controllerLogs.status(profile?.profileId ?? "")).toMatchObject({
      running: true,
      lastError: undefined
    });

    const disconnected = await connection.disconnect(profile?.profileId ?? "");
    expect(disconnected.ok).toBe(true);
    expect(controllerLogs.status(profile?.profileId ?? "").running).toBe(false);
  });
});

function fakeSystemProxy() {
  return {
    async status(): Promise<SystemProxyStatusResponse> {
      return proxyStatus();
    },
    async enable(): Promise<SystemProxyActionResponse> {
      return { ok: true, status: proxyStatus() };
    },
    async disable(): Promise<SystemProxyActionResponse> {
      return { ok: true, status: proxyStatus() };
    },
    async restore(): Promise<SystemProxyActionResponse> {
      return { ok: true, status: proxyStatus() };
    }
  };
}

function proxyStatus(): SystemProxyStatusResponse {
  return {
    supported: true,
    enabled: false,
    managedSnapshot: false
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not allocate a free port")));
      }
    });
    server.on("error", reject);
  });
}
