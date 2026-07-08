import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "@mioproxy/core-runtime";
import { parseYamlToObject } from "@mioproxy/config-pipeline";
import { createOverrideSettingsStore } from "../state/overrideSettingsStore.js";
import { RawProfileCache } from "../state/rawProfileCache.js";
import { createProfilePipelineService } from "./profilePipelineService.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-service-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function response(body: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => body
  } as Response;
}

function passingChecker(): CommandRunner {
  return vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false })) as unknown as CommandRunner;
}

describe("createProfilePipelineService", () => {
  it("runs the full injected pipeline and returns an IPC-safe success response", async () => {
    const service = createProfilePipelineService({
      appDataDir: tempDir,
      fetcher: vi.fn(async () => response("mixed-port: 7890\nrules:\n  - MATCH,DIRECT\n")) as unknown as typeof fetch,
      controllerFetcher: vi.fn(async () => response("", { status: 204 })) as unknown as typeof fetch,
      checkerRunner: passingChecker(),
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      sessionId: () => "session-1"
    });

    const result = await service.runProfilePipeline({
      profileId: "default",
      subscription: { url: "https://example.test/sub.yaml" },
      checker: { binaryPath: "mihomo.exe", dataDir: join(tempDir, "work") },
      controller: { baseUrl: "http://127.0.0.1:9090", secret: "controller-secret" }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("hot-reload");
      await expect(readFile(result.activePath, "utf8")).resolves.toContain("MATCH,DIRECT");
      await expect(readFile(result.lastKnownGoodPath, "utf8")).resolves.toContain("MATCH,DIRECT");
      const activeConfig = parseYamlToObject(await readFile(result.activePath, "utf8"));
      expect(activeConfig["external-controller"]).toBe("127.0.0.1:9090");
      expect(activeConfig.secret).toBe("controller-secret");
    }
    await expect(service.listPipelineHistory()).resolves.toHaveLength(1);
  });

  it("returns failure bundle path when apply fails", async () => {
    const service = createProfilePipelineService({
      appDataDir: tempDir,
      fetcher: vi.fn(async () => response("mixed-port: 7890\n")) as unknown as typeof fetch,
      controllerFetcher: vi.fn(async () =>
        response("bad", { ok: false, status: 500 })
      ) as unknown as typeof fetch,
      checkerRunner: passingChecker(),
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      sessionId: () => "session-1"
    });

    const result = await service.runProfilePipeline({
      profileId: "default",
      subscription: { url: "https://example.test/sub.yaml" },
      checker: { binaryPath: "mihomo.exe", dataDir: join(tempDir, "work") },
      controller: { baseUrl: "http://127.0.0.1:9090", secret: "controller-secret" }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("apply-active");
      await expect(readFile(result.failureBundlePath, "utf8")).resolves.toContain(
        "\"stage\": \"apply-active\""
      );
    }
    const history = await service.listPipelineHistory();
    expect(history[0]).toMatchObject({ ok: false, stage: "apply-active" });
  });

  it("exports a diagnostic report for a failed history record", async () => {
    const service = createProfilePipelineService({
      appDataDir: tempDir,
      fetcher: vi.fn(async () => response("mixed-port: 7890\n")) as unknown as typeof fetch,
      controllerFetcher: vi.fn(async () =>
        response("bad", { ok: false, status: 500 })
      ) as unknown as typeof fetch,
      checkerRunner: passingChecker(),
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      sessionId: () => "session-1"
    });

    await service.runProfilePipeline({
      profileId: "default",
      subscription: { url: "https://example.test/sub.yaml" },
      checker: { binaryPath: "mihomo.exe", dataDir: join(tempDir, "work") },
      controller: { baseUrl: "http://127.0.0.1:9090", secret: "controller-secret" }
    });
    const history = await service.listPipelineHistory();
    const failedHistory = history[0];
    if (!failedHistory) {
      throw new Error("Expected a failed history record");
    }

    const report = await service.exportFailureReport({ historyId: failedHistory.id });

    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.files).toContain("failure.json");
      await expect(readFile(join(report.reportDir, "history.json"), "utf8")).resolves.toContain(
        "\"stage\": \"apply-active\""
      );
    }
  });

  it("prepares active config without applying through a running controller", async () => {
    const controllerFetcher = vi.fn(async () => response("", { status: 204 })) as unknown as typeof fetch;
    const service = createProfilePipelineService({
      appDataDir: tempDir,
      fetcher: vi.fn(async () => response("mixed-port: 7890\nrules:\n  - MATCH,DIRECT\n")) as unknown as typeof fetch,
      controllerFetcher,
      checkerRunner: passingChecker()
    });

    const result = await service.prepareProfile({
      profileId: "default",
      subscription: { url: "https://example.test/sub.yaml" },
      checker: { binaryPath: "mihomo.exe", dataDir: join(tempDir, "work") },
      controller: { baseUrl: "http://127.0.0.1:9090", secret: "controller-secret" }
    });

    expect(result.ok).toBe(true);
    expect(controllerFetcher).not.toHaveBeenCalled();
    if (result.ok) {
      const activeConfig = parseYamlToObject(await readFile(result.activePath, "utf8"));
      expect(activeConfig["external-controller"]).toBe("127.0.0.1:9090");
      expect(activeConfig.secret).toBe("controller-secret");
    }
  });

  it("applies selected imported overrides when running a profile", async () => {
    const overridePath = join(tempDir, "source", "override.yaml");
    await mkdir(join(tempDir, "source"), { recursive: true });
    await appendFile(overridePath, "rules+:\n  - DOMAIN,selected.test,DIRECT\n", "utf8");
    const overrideStore = createOverrideSettingsStore(tempDir);
    await overrideStore.saveImported([
      {
        id: "selected-yaml",
        name: "Selected YAML",
        ext: "yaml",
        global: false,
        path: overridePath
      }
    ]);
    await overrideStore.setSelection({ profileId: "default", selectedIds: ["selected-yaml"] });
    const service = createProfilePipelineService({
      appDataDir: tempDir,
      fetcher: vi.fn(async () => response("mixed-port: 7890\nrules:\n  - MATCH,DIRECT\n")) as unknown as typeof fetch,
      controllerFetcher: vi.fn(async () => response("", { status: 204 })) as unknown as typeof fetch,
      checkerRunner: passingChecker()
    });

    const result = await service.runProfilePipeline({
      profileId: "default",
      subscription: { url: "https://example.test/sub.yaml" },
      checker: { binaryPath: "mihomo.exe", dataDir: join(tempDir, "work") },
      controller: { baseUrl: "http://127.0.0.1:9090", secret: "controller-secret" }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      await expect(readFile(result.activePath, "utf8")).resolves.toContain(
        "DOMAIN,selected.test,DIRECT"
      );
    }
  });

  it("uses imported raw profile cache when subscription download fails", async () => {
    await new RawProfileCache(tempDir).write("default", "mixed-port: 7890\nrules:\n  - MATCH,CACHE\n");
    const service = createProfilePipelineService({
      appDataDir: tempDir,
      fetcher: vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      controllerFetcher: vi.fn(async () => response("", { status: 204 })) as unknown as typeof fetch,
      checkerRunner: passingChecker()
    });

    const result = await service.runProfilePipeline({
      profileId: "default",
      subscription: { url: "https://example.test/sub.yaml", retries: 1 },
      checker: { binaryPath: "mihomo.exe", dataDir: join(tempDir, "work") },
      controller: { baseUrl: "http://127.0.0.1:9090", secret: "controller-secret" }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      await expect(readFile(result.activePath, "utf8")).resolves.toContain("MATCH,CACHE");
    }
  });

  it("returns a failure bundle when selected override materialization fails", async () => {
    const overrideStore = createOverrideSettingsStore(tempDir);
    await overrideStore.saveImported([
      {
        id: "missing-yaml",
        name: "Missing YAML",
        ext: "yaml",
        global: false
      }
    ]);
    await overrideStore.setSelection({ profileId: "default", selectedIds: ["missing-yaml"] });
    const service = createProfilePipelineService({
      appDataDir: tempDir,
      fetcher: vi.fn(async () => response("mixed-port: 7890\nrules:\n  - MATCH,DIRECT\n")) as unknown as typeof fetch,
      controllerFetcher: vi.fn(async () => response("", { status: 204 })) as unknown as typeof fetch,
      checkerRunner: passingChecker(),
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      sessionId: () => "session-override"
    });

    const result = await service.runProfilePipeline({
      profileId: "default",
      subscription: { url: "https://example.test/sub.yaml" },
      checker: { binaryPath: "mihomo.exe", dataDir: join(tempDir, "work") },
      controller: { baseUrl: "http://127.0.0.1:9090", secret: "controller-secret" }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("render-stage");
      await expect(readFile(result.failureBundlePath, "utf8")).resolves.toContain(
        "selected-overrides"
      );
    }
  });

  it("lists core logs for a profile", async () => {
    const service = createProfilePipelineService({ appDataDir: tempDir });
    const logPath = join(tempDir, "logs", "core", "default.jsonl");
    await mkdir(join(tempDir, "logs", "core"), { recursive: true });
    await appendFile(
      logPath,
      `${JSON.stringify({
        time: "2026-07-07T10:00:00.000Z",
        source: "process-stderr",
        level: "error",
        message: "panic: lightgbm",
        fields: { detail: "hidden from view model" }
      })}\n`,
      "utf8"
    );

    await expect(service.listCoreLogs("default")).resolves.toEqual([
      {
        time: "2026-07-07T10:00:00.000Z",
        source: "process-stderr",
        level: "error",
        message: "panic: lightgbm"
      }
    ]);
  });
});
