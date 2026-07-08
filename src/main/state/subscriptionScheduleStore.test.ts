import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSubscriptionScheduleStore,
  defaultSubscriptionSchedule
} from "./subscriptionScheduleStore.js";

let tempDir: string;
let currentTime: Date;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-subscription-schedule-"));
  currentTime = new Date("2026-07-08T00:00:00.000Z");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createSubscriptionScheduleStore", () => {
  it("returns null for missing schedules and exposes a disabled default", async () => {
    await expect(createSubscriptionScheduleStore(tempDir).load("default")).resolves.toBeNull();

    expect(defaultSubscriptionSchedule("default", currentTime)).toEqual({
      profileId: "default",
      enabled: false,
      intervalMinutes: 1440,
      updatedAt: "2026-07-08T00:00:00.000Z"
    });
  });

  it("saves enabled schedules with normalized intervals and next run time", async () => {
    const store = createSubscriptionScheduleStore(tempDir, { now: () => currentTime });
    const saved = await store.save({
      profileId: " default ",
      enabled: true,
      intervalMinutes: 5
    });

    expect(saved).toEqual({
      profileId: "default",
      enabled: true,
      intervalMinutes: 15,
      nextRunAt: "2026-07-08T00:15:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z"
    });

    const raw = await readFile(join(tempDir, "state", "subscription-schedules.json"), "utf8");
    expect(raw).toContain("\"default\"");
    await expect(store.list()).resolves.toEqual([saved]);
  });

  it("marks run results and schedules the next enabled run", async () => {
    const store = createSubscriptionScheduleStore(tempDir, { now: () => currentTime });
    await store.save({
      profileId: "default",
      enabled: true,
      intervalMinutes: 60
    });

    currentTime = new Date("2026-07-08T01:00:00.000Z");
    await expect(
      store.markRun("default", {
        status: "failed",
        stage: "validate",
        errorMessage: "bad config"
      })
    ).resolves.toMatchObject({
      profileId: "default",
      enabled: true,
      intervalMinutes: 60,
      lastRunAt: "2026-07-08T01:00:00.000Z",
      lastStatus: "failed",
      lastStage: "validate",
      lastErrorMessage: "bad config",
      nextRunAt: "2026-07-08T02:00:00.000Z"
    });
  });
});
