import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineRunInput } from "../../shared/pipelineTypes.js";
import { createSubscriptionUpdateService } from "./subscriptionUpdateService.js";

let tempDir: string;
let currentTime: Date;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-subscription-service-"));
  currentTime = new Date("2026-07-08T00:00:00.000Z");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createSubscriptionUpdateService", () => {
  it("skips disabled schedules", async () => {
    const runner = {
      prepareProfile: vi.fn()
    };
    const service = createSubscriptionUpdateService({
      appDataDir: tempDir,
      now: () => currentTime,
      runner
    });

    await expect(
      service.tick({
        profileId: "default",
        pipelineInput: buildPipelineInput()
      })
    ).resolves.toMatchObject({
      ok: true,
      status: "skipped",
      reason: "disabled",
      schedule: {
        profileId: "default",
        enabled: false
      }
    });
    expect(runner.prepareProfile).not.toHaveBeenCalled();
  });

  it("skips enabled schedules that are not due", async () => {
    const runner = {
      prepareProfile: vi.fn()
    };
    const service = createSubscriptionUpdateService({
      appDataDir: tempDir,
      now: () => currentTime,
      runner
    });
    await service.saveSchedule({
      profileId: "default",
      enabled: true,
      intervalMinutes: 60
    });

    await expect(
      service.tick({
        profileId: "default",
        pipelineInput: buildPipelineInput()
      })
    ).resolves.toMatchObject({
      ok: true,
      status: "skipped",
      reason: "not-due"
    });
    expect(runner.prepareProfile).not.toHaveBeenCalled();
  });

  it("prepares due schedules and records success", async () => {
    const runner = {
      prepareProfile: vi.fn().mockResolvedValue({
        ok: true,
        stage: "promoted",
        activePath: "active.yaml",
        candidatePath: "candidate.yaml",
        warnings: []
      })
    };
    const service = createSubscriptionUpdateService({
      appDataDir: tempDir,
      now: () => currentTime,
      runner
    });
    await service.saveSchedule({
      profileId: "default",
      enabled: true,
      intervalMinutes: 60
    });
    currentTime = new Date("2026-07-08T01:00:00.000Z");

    await expect(
      service.tick({
        profileId: "default",
        pipelineInput: buildPipelineInput()
      })
    ).resolves.toMatchObject({
      ok: true,
      status: "success",
      stage: "promoted",
      schedule: {
        lastStatus: "success",
        lastStage: "promoted",
        nextRunAt: "2026-07-08T02:00:00.000Z"
      }
    });
    expect(runner.prepareProfile).toHaveBeenCalledOnce();
  });

  it("does not run due background schedules until the profile is armed", async () => {
    const runner = {
      prepareProfile: vi.fn().mockResolvedValue({
        ok: true,
        stage: "promoted",
        activePath: "active.yaml",
        candidatePath: "candidate.yaml",
        warnings: []
      })
    };
    const service = createSubscriptionUpdateService({
      appDataDir: tempDir,
      now: () => currentTime,
      runner
    });
    await service.saveSchedule({
      profileId: "default",
      enabled: true,
      intervalMinutes: 60
    });
    currentTime = new Date("2026-07-08T01:00:00.000Z");

    await expect(service.tickDueSchedules()).resolves.toEqual([]);
    expect(runner.prepareProfile).not.toHaveBeenCalled();
    expect(service.getRuntimeStatus("default")).toEqual({
      profileId: "default",
      armed: false
    });
  });

  it("runs due background schedules when the profile is armed in memory", async () => {
    const runner = {
      prepareProfile: vi.fn().mockResolvedValue({
        ok: true,
        stage: "promoted",
        activePath: "active.yaml",
        candidatePath: "candidate.yaml",
        warnings: []
      })
    };
    const service = createSubscriptionUpdateService({
      appDataDir: tempDir,
      now: () => currentTime,
      runner
    });
    await service.saveSchedule({
      profileId: "default",
      enabled: true,
      intervalMinutes: 60
    });
    expect(
      service.arm({
        profileId: "default",
        pipelineInput: buildPipelineInput()
      })
    ).toMatchObject({
      profileId: "default",
      armed: true,
      armedAt: "2026-07-08T00:00:00.000Z"
    });
    currentTime = new Date("2026-07-08T01:00:00.000Z");

    await expect(service.tickDueSchedules()).resolves.toMatchObject([
      {
        ok: true,
        status: "success",
        stage: "promoted"
      }
    ]);
    expect(runner.prepareProfile).toHaveBeenCalledOnce();
    expect(service.getRuntimeStatus("default")).toMatchObject({
      profileId: "default",
      armed: true,
      lastTickAt: "2026-07-08T01:00:00.000Z",
      lastTickStatus: "success"
    });
  });

  it("clears the armed timestamp when a profile is disarmed", async () => {
    const service = createSubscriptionUpdateService({
      appDataDir: tempDir,
      now: () => currentTime,
      runner: {
        prepareProfile: vi.fn()
      }
    });
    service.arm({
      profileId: "default",
      pipelineInput: buildPipelineInput()
    });

    expect(service.disarm("default")).toEqual({
      profileId: "default",
      armed: false,
      armedAt: undefined
    });
  });

  it("records prepare failures", async () => {
    const runner = {
      prepareProfile: vi.fn().mockResolvedValue({
        ok: false,
        stage: "validate",
        error: {
          name: "Error",
          message: "bad config"
        }
      })
    };
    const service = createSubscriptionUpdateService({
      appDataDir: tempDir,
      now: () => currentTime,
      runner
    });
    await service.saveSchedule({
      profileId: "default",
      enabled: true,
      intervalMinutes: 60
    });
    currentTime = new Date("2026-07-08T01:00:00.000Z");

    await expect(
      service.tick({
        profileId: "default",
        pipelineInput: buildPipelineInput()
      })
    ).resolves.toMatchObject({
      ok: false,
      status: "failed",
      stage: "validate",
      error: {
        message: "bad config"
      },
      schedule: {
        lastStatus: "failed",
        lastStage: "validate",
        lastErrorMessage: "bad config"
      }
    });
  });

  it("records thrown prepare errors as failed subscription updates", async () => {
    const runner = {
      prepareProfile: vi.fn().mockRejectedValue(new Error("runner exploded"))
    };
    const service = createSubscriptionUpdateService({
      appDataDir: tempDir,
      now: () => currentTime,
      runner
    });
    await service.saveSchedule({
      profileId: "default",
      enabled: true,
      intervalMinutes: 60
    });
    currentTime = new Date("2026-07-08T01:00:00.000Z");

    await expect(
      service.tick({
        profileId: "default",
        pipelineInput: buildPipelineInput()
      })
    ).resolves.toMatchObject({
      ok: false,
      status: "failed",
      stage: "subscription-update",
      error: {
        message: "runner exploded"
      },
      schedule: {
        lastStatus: "failed",
        lastStage: "subscription-update",
        lastErrorMessage: "runner exploded"
      }
    });
  });
});

function buildPipelineInput(): PipelineRunInput {
  return {
    profileId: "default",
    subscription: {
      url: "https://example.test/sub.yaml"
    },
    checker: {
      binaryPath: "mihomo.exe",
      dataDir: "work"
    },
    controller: {
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    }
  };
}
