import type {
  PipelinePrepareResponse,
  PipelineRunInput,
  SubscriptionScheduleRuntimeInput,
  SubscriptionScheduleRuntimeStatus,
  SubscriptionScheduleSaveInput,
  SubscriptionScheduleTickInput,
  SubscriptionScheduleTickResponse,
  SubscriptionUpdateSchedule
} from "../../shared/pipelineTypes.js";
import { createProfilePipelineService } from "../pipeline/profilePipelineService.js";
import {
  createSubscriptionScheduleStore,
  defaultSubscriptionSchedule
} from "../state/subscriptionScheduleStore.js";

export interface SubscriptionUpdateRunner {
  prepareProfile(input: PipelineRunInput): Promise<PipelinePrepareResponse>;
}

export interface SubscriptionUpdateServiceOptions {
  appDataDir: string;
  now?: () => Date;
  runner?: SubscriptionUpdateRunner;
  intervalMs?: number;
}

export function createSubscriptionUpdateService(options: SubscriptionUpdateServiceOptions) {
  const now = options.now ?? (() => new Date());
  const store = createSubscriptionScheduleStore(options.appDataDir, { now });
  const runner = options.runner ?? createProfilePipelineService({ appDataDir: options.appDataDir });
  const runtimeInputs = new Map<string, PipelineRunInput>();
  const runtimeStatuses = new Map<string, SubscriptionScheduleRuntimeStatus>();
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  async function loadSchedule(profileId: string): Promise<SubscriptionUpdateSchedule> {
    return (await store.load(profileId)) ?? defaultSubscriptionSchedule(profileId, now());
  }

  function saveSchedule(input: SubscriptionScheduleSaveInput): Promise<SubscriptionUpdateSchedule> {
    return store.save(input);
  }

  async function tick(input: SubscriptionScheduleTickInput): Promise<SubscriptionScheduleTickResponse> {
    const profileId = input.profileId.trim();
    if (profileId !== input.pipelineInput.profileId.trim()) {
      throw new Error("profileId must match pipelineInput.profileId");
    }

    const schedule = await loadSchedule(profileId);
    if (!schedule.enabled && input.force !== true) {
      return {
        ok: true,
        status: "skipped",
        reason: "disabled",
        schedule
      };
    }

    if (input.force !== true && !isDue(schedule, now())) {
      return {
        ok: true,
        status: "skipped",
        reason: "not-due",
        schedule
      };
    }

    try {
      const prepared = await runner.prepareProfile(input.pipelineInput);
      if (prepared.ok) {
        const updated = await store.markRun(profileId, {
          status: "success",
          stage: prepared.stage
        });
        recordRuntimeTick(profileId, "success");
        return {
          ok: true,
          status: "success",
          stage: prepared.stage,
          prepare: prepared,
          schedule: updated
        };
      }

      const updated = await store.markRun(profileId, {
        status: "failed",
        stage: prepared.stage,
        errorMessage: prepared.error.message
      });
      recordRuntimeTick(profileId, "failed", prepared.error.message);
      return {
        ok: false,
        status: "failed",
        stage: prepared.stage,
        error: prepared.error,
        prepare: prepared,
        schedule: updated
      };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const updated = await store.markRun(profileId, {
        status: "failed",
        stage: "subscription-update",
        errorMessage: normalized.message
      });
      recordRuntimeTick(profileId, "failed", normalized.message);
      return {
        ok: false,
        status: "failed",
        stage: "subscription-update",
        error: {
          name: normalized.name,
          message: normalized.message
        },
        schedule: updated
      };
    }
  }

  function arm(input: SubscriptionScheduleRuntimeInput): SubscriptionScheduleRuntimeStatus {
    const profileId = input.profileId.trim();
    if (profileId !== input.pipelineInput.profileId.trim()) {
      throw new Error("profileId must match pipelineInput.profileId");
    }

    runtimeInputs.set(profileId, input.pipelineInput);
    const status: SubscriptionScheduleRuntimeStatus = {
      ...runtimeStatuses.get(profileId),
      profileId,
      armed: true,
      armedAt: now().toISOString()
    };
    runtimeStatuses.set(profileId, status);
    return status;
  }

  function disarm(profileId: string): SubscriptionScheduleRuntimeStatus {
    const normalizedProfileId = profileId.trim();
    runtimeInputs.delete(normalizedProfileId);
    const status: SubscriptionScheduleRuntimeStatus = {
      ...runtimeStatuses.get(normalizedProfileId),
      profileId: normalizedProfileId,
      armed: false,
      armedAt: undefined
    };
    runtimeStatuses.set(normalizedProfileId, status);
    return status;
  }

  function getRuntimeStatus(profileId: string): SubscriptionScheduleRuntimeStatus {
    const normalizedProfileId = profileId.trim();
    return (
      runtimeStatuses.get(normalizedProfileId) ?? {
        profileId: normalizedProfileId,
        armed: runtimeInputs.has(normalizedProfileId)
      }
    );
  }

  async function tickDueSchedules(): Promise<SubscriptionScheduleTickResponse[]> {
    const schedules = await store.list();
    const dueSchedules = schedules.filter((schedule) => schedule.enabled && isDue(schedule, now()));
    const responses: SubscriptionScheduleTickResponse[] = [];

    for (const schedule of dueSchedules) {
      const pipelineInput = runtimeInputs.get(schedule.profileId);
      if (!pipelineInput || inFlight.has(schedule.profileId)) {
        continue;
      }

      inFlight.add(schedule.profileId);
      try {
        responses.push(await tick({ profileId: schedule.profileId, pipelineInput }));
      } finally {
        inFlight.delete(schedule.profileId);
      }
    }

    return responses;
  }

  function start(): void {
    if (timer) {
      return;
    }

    timer = setInterval(() => {
      void tickDueSchedules().catch(() => undefined);
    }, options.intervalMs ?? 60_000);
    timer.unref?.();
  }

  function stop(): void {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = undefined;
  }

  function recordRuntimeTick(
    profileId: string,
    status: SubscriptionScheduleRuntimeStatus["lastTickStatus"],
    errorMessage?: string
  ): void {
    const previous = getRuntimeStatus(profileId);
    runtimeStatuses.set(profileId, {
      ...previous,
      lastTickAt: now().toISOString(),
      lastTickStatus: status,
      lastErrorMessage: errorMessage
    });
  }

  return {
    loadSchedule,
    saveSchedule,
    tick,
    arm,
    disarm,
    getRuntimeStatus,
    tickDueSchedules,
    start,
    stop
  };
}

function isDue(schedule: SubscriptionUpdateSchedule, now: Date): boolean {
  if (!schedule.nextRunAt) {
    return true;
  }

  const nextRunAt = Date.parse(schedule.nextRunAt);
  return Number.isNaN(nextRunAt) || nextRunAt <= now.getTime();
}
