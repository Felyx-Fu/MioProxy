import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerClient, ControllerClientResult } from "../runtime/controllerClient.js";
import { createConfigStore } from "../store/configStore.js";
import { applyActiveConfig } from "./applyActiveConfig.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-apply-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function ok(status = 204): ControllerClientResult {
  return { ok: true, status, body: "" };
}

function fail(message: string): ControllerClientResult {
  return { ok: false, error: new Error(message), timedOut: false };
}

function controller(results: {
  reload?: ControllerClientResult;
  restart?: ControllerClientResult[];
}): ControllerClient & { reloadConfig: ReturnType<typeof vi.fn>; restart: ReturnType<typeof vi.fn> } {
  const restarts = [...(results.restart ?? [])];
  return {
    getVersion: vi.fn(async () => ok(200)),
    getConfigs: vi.fn(async () => ok(200)),
    getTraffic: vi.fn(async () => ok(200)),
    getConnections: vi.fn(async () => ok(200)),
    getProxies: vi.fn(async () => ok(200)),
    getRules: vi.fn(async () => ok(200)),
    getRuleProviders: vi.fn(async () => ok(200)),
    switchProxy: vi.fn(async () => ok(200)),
    testProxyDelay: vi.fn(async () => ok(200)),
    reloadConfig: vi.fn(async () => results.reload ?? ok()),
    restart: vi.fn(async () => restarts.shift() ?? ok())
  };
}

describe("applyActiveConfig", () => {
  it("marks last-known-good after hot reload succeeds", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await writeFile(paths.activePath, "mixed-port: 7890\n", { flag: "w" }).catch(async () => {
      await store.writeCandidate("default", "mixed-port: 7890\n");
      await store.promoteCandidateToActive("default");
    });
    const client = controller({ reload: ok(204) });

    const result = await applyActiveConfig({
      profileId: "default",
      activePath: paths.activePath,
      store,
      controller: client
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("hot-reload");
      expect(result.lastKnownGoodPath).toBe(paths.lastKnownGoodPath);
    }
    expect(client.reloadConfig).toHaveBeenCalledWith(paths.activePath);
    expect(client.restart).not.toHaveBeenCalled();
    await expect(readFile(paths.lastKnownGoodPath, "utf8")).resolves.toBe("mixed-port: 7890\n");
  });

  it("falls back to restart when hot reload fails", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "mixed-port: 7890\n");
    await store.promoteCandidateToActive("default");
    const client = controller({ reload: fail("reload failed"), restart: [ok(200)] });

    const result = await applyActiveConfig({
      profileId: "default",
      activePath: paths.activePath,
      store,
      controller: client
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("restart");
    }
    expect(client.restart).toHaveBeenCalledWith(paths.activePath);
    await expect(readFile(paths.lastKnownGoodPath, "utf8")).resolves.toBe("mixed-port: 7890\n");
  });

  it("rolls back to last-known-good when reload and restart fail", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "mixed-port: 7890\n");
    await store.promoteCandidateToActive("default");
    await store.markLastKnownGood("default");
    await writeFile(paths.activePath, "mixed-port: 9999\n");
    const client = controller({
      reload: fail("reload failed"),
      restart: [fail("restart failed"), ok(200)]
    });

    const result = await applyActiveConfig({
      profileId: "default",
      activePath: paths.activePath,
      store,
      controller: client
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("restart");
      expect(result.rolledBack).toBe(true);
      expect(result.rollbackPath).toBe(paths.activePath);
    }
    expect(client.restart).toHaveBeenNthCalledWith(1, paths.activePath);
    expect(client.restart).toHaveBeenNthCalledWith(2, paths.activePath);
    await expect(readFile(paths.activePath, "utf8")).resolves.toBe("mixed-port: 7890\n");
  });

  it("reports rollback-restart when rollback config cannot restart", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "mixed-port: 7890\n");
    await store.promoteCandidateToActive("default");
    await store.markLastKnownGood("default");
    await writeFile(paths.activePath, "mixed-port: 9999\n");
    const client = controller({
      reload: fail("reload failed"),
      restart: [fail("restart failed"), fail("rollback restart failed")]
    });

    const result = await applyActiveConfig({
      profileId: "default",
      activePath: paths.activePath,
      store,
      controller: client
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("rollback-restart");
      expect(result.rolledBack).toBe(true);
      expect(result.error.message).toBe("rollback restart failed");
    }
    await expect(readFile(paths.activePath, "utf8")).resolves.toBe("mixed-port: 7890\n");
  });

  it("reports failure without rollback when no last-known-good exists", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "mixed-port: 9999\n");
    await store.promoteCandidateToActive("default");
    const client = controller({
      reload: fail("reload failed"),
      restart: [fail("restart failed")]
    });

    const result = await applyActiveConfig({
      profileId: "default",
      activePath: paths.activePath,
      store,
      controller: client
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("restart");
      expect(result.rolledBack).toBe(false);
      expect(result.error.message).toBe("restart failed");
    }
    await expect(readFile(paths.activePath, "utf8")).resolves.toBe("mixed-port: 9999\n");
  });
});
