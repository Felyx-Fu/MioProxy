import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerClient, ControllerClientResult } from "../runtime/controllerClient.js";
import type { CommandRunner } from "../types.js";
import { createConfigStore } from "../store/configStore.js";
import { runProfilePipeline } from "./runProfilePipeline.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-run-"));
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

function controller(
  reload: ControllerClientResult = ok(),
  restart: ControllerClientResult = ok(200)
): ControllerClient {
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
    reloadConfig: vi.fn(async () => reload),
    restart: vi.fn(async () => restart)
  };
}

function passingChecker(): CommandRunner {
  return vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false })) as unknown as CommandRunner;
}

describe("runProfilePipeline", () => {
  it("returns success without writing a failure bundle", async () => {
    const store = createConfigStore(tempDir);
    const result = await runProfilePipeline({
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
      controller: controller(),
      diagnostics: {
        rootDir: tempDir,
        sessionId: "session-1",
        now: new Date("2026-07-07T10:00:00.000Z")
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.stage).toBe("applied");
      expect(result.failureBundle).toBeUndefined();
    }
    await expect(readFile(join(tempDir, "bundles", "default"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("writes a redacted failure bundle when the pipeline fails", async () => {
    const store = createConfigStore(tempDir);
    const result = await runProfilePipeline({
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
      controller: controller(
        fail("reload failed with Bearer private-token"),
        fail("restart failed with Bearer private-token")
      ),
      diagnostics: {
        rootDir: tempDir,
        sessionId: "session-1",
        now: new Date("2026-07-07T10:00:00.000Z")
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.result.stage).toBe("apply-active");
      const written = await readFile(result.failureBundle.bundlePath, "utf8");
      expect(written).toContain("\"stage\": \"apply-active\"");
      expect(written).not.toContain("private-token");
      expect(written).toContain("Bearer [REDACTED]");
    }
  });
});
