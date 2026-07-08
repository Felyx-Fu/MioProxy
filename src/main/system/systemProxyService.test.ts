import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemProxyService, type SystemProxyManager } from "./systemProxyService.js";
import type { WindowsSystemProxySnapshot } from "./windowsSystemProxy.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-system-proxy-service-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createSystemProxyService", () => {
  it("reports current proxy status", async () => {
    const service = createSystemProxyService({
      appDataDir: tempDir,
      platform: "win32",
      manager: fakeManager(snapshot({ enabled: true, server: "127.0.0.1:7890" }))
    });

    await expect(service.status()).resolves.toMatchObject({
      supported: true,
      enabled: true,
      server: "127.0.0.1:7890",
      managedSnapshot: false
    });
  });

  it("saves the previous proxy snapshot before enabling", async () => {
    const manager = fakeManager(snapshot({ enabled: false, server: "old:8080" }));
    const service = createSystemProxyService({
      appDataDir: tempDir,
      platform: "win32",
      manager
    });

    const result = await service.enable({
      host: "127.0.0.1",
      port: 7890,
      bypass: "localhost"
    });

    expect(result.ok).toBe(true);
    expect(result.status).toMatchObject({
      enabled: true,
      server: "127.0.0.1:7890",
      managedSnapshot: true
    });
    expect(manager.enable).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 7890,
      bypass: "localhost"
    });
  });

  it("restores a managed snapshot and removes it", async () => {
    const manager = fakeManager(snapshot({ enabled: false, server: "old:8080" }));
    const service = createSystemProxyService({
      appDataDir: tempDir,
      platform: "win32",
      manager
    });

    await service.enable({ host: "127.0.0.1", port: 7890 });
    const restored = await service.restore();

    expect(manager.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        server: "old:8080"
      })
    );
    expect(restored).toMatchObject({
      ok: true,
      status: { enabled: false, server: "old:8080", managedSnapshot: false }
    });
  });

  it("returns unsupported on non-Windows platforms", async () => {
    const service = createSystemProxyService({
      appDataDir: tempDir,
      platform: "linux",
      manager: fakeManager(snapshot({ enabled: false }))
    });

    await expect(service.status()).resolves.toEqual({
      supported: false,
      enabled: false,
      managedSnapshot: false
    });
    await expect(service.enable({ host: "127.0.0.1", port: 7890 })).resolves.toMatchObject({
      ok: false,
      error: { name: "UnsupportedPlatformError" }
    });
  });

  it("returns safe errors and best-effort status", async () => {
    const manager = fakeManager(snapshot({ enabled: false }));
    vi.mocked(manager.enable).mockRejectedValueOnce(new Error("registry denied"));
    const service = createSystemProxyService({
      appDataDir: tempDir,
      platform: "win32",
      manager
    });

    await expect(service.enable({ host: "127.0.0.1", port: 7890 })).resolves.toMatchObject({
      ok: false,
      error: { message: "registry denied" },
      status: { supported: true, enabled: false, managedSnapshot: false }
    });
    expect(manager.restore).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("keeps the managed snapshot when enable failure rollback also fails", async () => {
    const manager = fakeManager(snapshot({ enabled: true, server: "old:8080" }));
    vi.mocked(manager.enable).mockImplementationOnce(async (input) => {
      await fakeManager(snapshot({ enabled: false })).enable(input);
      throw new Error("registry denied");
    });
    vi.mocked(manager.restore).mockRejectedValueOnce(new Error("restore denied"));
    const service = createSystemProxyService({
      appDataDir: tempDir,
      platform: "win32",
      manager
    });

    await expect(service.enable({ host: "127.0.0.1", port: 7890 })).resolves.toMatchObject({
      ok: false,
      error: { message: "registry denied" },
      status: { supported: true, managedSnapshot: true }
    });
  });
});

function fakeManager(initial: WindowsSystemProxySnapshot): SystemProxyManager {
  let current = initial;
  return {
    read: vi.fn(async () => current),
    enable: vi.fn(async (input) => {
      current = snapshot({
        enabled: true,
        server: `${input.host}:${input.port}`,
        bypass: input.bypass ?? "localhost;127.*;<local>"
      });
      return current;
    }),
    disable: vi.fn(async () => {
      current = snapshot({ ...current, enabled: false });
      return current;
    }),
    restore: vi.fn(async (saved) => {
      current = saved;
      return current;
    })
  };
}

function snapshot(input: {
  enabled: boolean;
  server?: string;
  bypass?: string;
}): WindowsSystemProxySnapshot {
  return {
    enabled: input.enabled,
    server: input.server,
    bypass: input.bypass,
    capturedAt: "2026-07-07T10:00:00.000Z"
  };
}
