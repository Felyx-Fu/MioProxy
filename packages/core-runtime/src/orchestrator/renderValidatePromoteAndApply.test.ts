import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerClient, ControllerClientResult } from "../runtime/controllerClient.js";
import type { CommandRunner } from "../types.js";
import { createConfigStore } from "../store/configStore.js";
import { renderValidatePromoteAndApply } from "./renderValidatePromoteAndApply.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-full-"));
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

function controller(options?: {
  reload?: ControllerClientResult;
  restart?: ControllerClientResult[];
}): ControllerClient & { reloadConfig: ReturnType<typeof vi.fn>; restart: ReturnType<typeof vi.fn> } {
  const restarts = [...(options?.restart ?? [])];
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
    reloadConfig: vi.fn(async () => options?.reload ?? ok()),
    restart: vi.fn(async () => restarts.shift() ?? ok())
  };
}

function passingChecker(): CommandRunner {
  return vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false })) as unknown as CommandRunner;
}

describe("renderValidatePromoteAndApply", () => {
  it("runs the full pipeline and applies via hot reload", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    const client = controller({ reload: ok(204) });
    const result = await renderValidatePromoteAndApply({
      profileId: "default",
      store,
      render: vi.fn(async () => ({
        ok: true,
        renderedYaml: "mixed-port: 7890\n",
        rawSource: "network",
        downloadAttempts: 1,
        warnings: []
      })),
      checker: {
        binaryPath: "mihomo.exe",
        dataDir: join(tempDir, "work"),
        runner: passingChecker()
      },
      controller: client
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stage).toBe("applied");
      expect(result.apply.mode).toBe("hot-reload");
      expect(result.promotion.activePath).toBe(paths.activePath);
    }
    await expect(readFile(paths.activePath, "utf8")).resolves.toBe("mixed-port: 7890\n");
    await expect(readFile(paths.lastKnownGoodPath, "utf8")).resolves.toBe("mixed-port: 7890\n");
  });

  it("stops when render staging fails", async () => {
    const store = createConfigStore(tempDir);
    const result = await renderValidatePromoteAndApply({
      profileId: "default",
      store,
      render: vi.fn(async () => ({
        ok: false,
        stage: "parse",
        error: new Error("YAML root must be an object")
      })),
      checker: {
        binaryPath: "mihomo.exe",
        dataDir: join(tempDir, "work"),
        runner: passingChecker()
      },
      controller: controller()
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("render-stage");
      expect(result.error.message).toContain("YAML root");
    }
  });

  it("stops when offline check fails and leaves active untouched", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    const checker = vi.fn(async () => ({
      exitCode: 1,
      stdout: "deprecated field",
      stderr: "panic: lightgbm",
      timedOut: false
    })) as unknown as CommandRunner;

    const result = await renderValidatePromoteAndApply({
      profileId: "default",
      store,
      render: vi.fn(async () => ({
        ok: true,
        renderedYaml: "global-client-fingerprint: chrome\n",
        rawSource: "network",
        downloadAttempts: 1,
        warnings: []
      })),
      checker: {
        binaryPath: "mihomo.exe",
        dataDir: join(tempDir, "work"),
        runner: checker
      },
      controller: controller()
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("offline-check");
      expect(result.validation?.ok).toBe(false);
    }
    await expect(readFile(paths.activePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.candidatePath, "utf8")).resolves.toBe(
      "global-client-fingerprint: chrome\n"
    );
  });

  it("returns apply-active failure after rollback", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "mixed-port: 7890\n");
    await store.promoteCandidateToActive("default");
    await store.markLastKnownGood("default");
    const client = controller({
      reload: fail("reload failed"),
      restart: [fail("restart failed"), ok(200)]
    });

    const result = await renderValidatePromoteAndApply({
      profileId: "default",
      store,
      render: vi.fn(async () => ({
        ok: true,
        renderedYaml: "mixed-port: 9999\n",
        rawSource: "network",
        downloadAttempts: 1,
        warnings: []
      })),
      checker: {
        binaryPath: "mihomo.exe",
        dataDir: join(tempDir, "work"),
        runner: passingChecker()
      },
      controller: client
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("apply-active");
      expect(result.apply?.ok).toBe(false);
    }
    await expect(readFile(paths.activePath, "utf8")).resolves.toBe("mixed-port: 7890\n");
  });
});
