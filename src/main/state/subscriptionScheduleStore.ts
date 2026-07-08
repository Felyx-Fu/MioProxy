import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  SubscriptionScheduleSaveInput,
  SubscriptionScheduleStatus,
  SubscriptionUpdateSchedule
} from "../../shared/pipelineTypes.js";

const DEFAULT_INTERVAL_MINUTES = 1440;
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 10080;

interface ScheduleStateFile {
  schedules: Record<string, SubscriptionUpdateSchedule>;
}

export interface SubscriptionScheduleStore {
  load(profileId: string): Promise<SubscriptionUpdateSchedule | null>;
  list(): Promise<SubscriptionUpdateSchedule[]>;
  save(input: SubscriptionScheduleSaveInput): Promise<SubscriptionUpdateSchedule>;
  markRun(
    profileId: string,
    result: {
      status: SubscriptionScheduleStatus;
      stage?: string;
      errorMessage?: string;
    }
  ): Promise<SubscriptionUpdateSchedule>;
}

export interface SubscriptionScheduleStoreOptions {
  now?: () => Date;
}

export function createSubscriptionScheduleStore(
  appDataDir: string,
  options: SubscriptionScheduleStoreOptions = {}
): SubscriptionScheduleStore {
  const now = options.now ?? (() => new Date());

  return {
    async load(profileId: string): Promise<SubscriptionUpdateSchedule | null> {
      const normalizedProfileId = normalizeRequired(profileId, "profileId");
      const state = await readState(appDataDir);
      return state.schedules[normalizedProfileId] ?? null;
    },

    async list(): Promise<SubscriptionUpdateSchedule[]> {
      const state = await readState(appDataDir);
      return Object.values(state.schedules);
    },

    async save(input: SubscriptionScheduleSaveInput): Promise<SubscriptionUpdateSchedule> {
      const state = await readState(appDataDir);
      const profileId = normalizeRequired(input.profileId, "profileId");
      const previous = state.schedules[profileId];
      const currentTime = now();
      const intervalMinutes = normalizeInterval(input.intervalMinutes);
      const normalized: SubscriptionUpdateSchedule = {
        profileId,
        enabled: input.enabled,
        intervalMinutes,
        nextRunAt: input.enabled
          ? addMinutes(currentTime, intervalMinutes).toISOString()
          : undefined,
        lastRunAt: previous?.lastRunAt,
        lastStatus: previous?.lastStatus,
        lastStage: previous?.lastStage,
        lastErrorMessage: previous?.lastErrorMessage,
        updatedAt: currentTime.toISOString()
      };

      state.schedules[profileId] = normalized;
      await writeState(appDataDir, state);
      return normalized;
    },

    async markRun(
      profileId: string,
      result: {
        status: SubscriptionScheduleStatus;
        stage?: string;
        errorMessage?: string;
      }
    ): Promise<SubscriptionUpdateSchedule> {
      const state = await readState(appDataDir);
      const normalizedProfileId = normalizeRequired(profileId, "profileId");
      const previous =
        state.schedules[normalizedProfileId] ?? defaultSchedule(normalizedProfileId, now());
      const currentTime = now();
      const normalized: SubscriptionUpdateSchedule = {
        ...previous,
        lastRunAt: currentTime.toISOString(),
        lastStatus: result.status,
        lastStage: result.stage,
        lastErrorMessage: result.errorMessage,
        nextRunAt: previous.enabled
          ? addMinutes(currentTime, previous.intervalMinutes).toISOString()
          : undefined,
        updatedAt: currentTime.toISOString()
      };

      state.schedules[normalizedProfileId] = normalized;
      await writeState(appDataDir, state);
      return normalized;
    }
  };
}

export function defaultSubscriptionSchedule(
  profileId: string,
  now: Date = new Date()
): SubscriptionUpdateSchedule {
  return defaultSchedule(normalizeRequired(profileId, "profileId"), now);
}

function defaultSchedule(profileId: string, now: Date): SubscriptionUpdateSchedule {
  return {
    profileId,
    enabled: false,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    updatedAt: now.toISOString()
  };
}

async function readState(appDataDir: string): Promise<ScheduleStateFile> {
  try {
    const parsed = JSON.parse(await readFile(statePath(appDataDir), "utf8")) as unknown;
    return isScheduleStateFile(parsed) ? parsed : { schedules: {} };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { schedules: {} };
    }
    throw error;
  }
}

async function writeState(appDataDir: string, state: ScheduleStateFile): Promise<void> {
  const path = statePath(appDataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function statePath(appDataDir: string): string {
  return join(appDataDir, "state", "subscription-schedules.json");
}

function normalizeRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function normalizeInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return Math.min(
    MAX_INTERVAL_MINUTES,
    Math.max(MIN_INTERVAL_MINUTES, Math.round(value))
  );
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function isScheduleStateFile(value: unknown): value is ScheduleStateFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ScheduleStateFile).schedules === "object" &&
    (value as ScheduleStateFile).schedules !== null
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
