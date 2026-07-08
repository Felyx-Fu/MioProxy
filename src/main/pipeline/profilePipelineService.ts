import { join } from "node:path";
import {
  renderProfile
} from "@mioproxy/config-pipeline";
import {
  createCoreLogStore,
  createConfigStore,
  createControllerClient,
  exportFailureReport as exportCoreFailureReport,
  renderValidateAndPromote,
  runProfilePipeline,
  type CommandRunner,
  type RenderForStageResult,
  type RenderValidateAndPromoteResult,
  type RunProfilePipelineResult
} from "@mioproxy/core-runtime";
import type {
  CoreLogViewEvent,
  FailureReportExportInput,
  FailureReportExportResponse,
  PipelineRunHistoryRecord,
  PipelineRunInput,
  PipelinePrepareResponse,
  PipelineRunResponse
} from "../../shared/pipelineTypes.js";
import { createOverrideSettingsStore } from "../state/overrideSettingsStore.js";
import { createPipelineHistoryStore } from "../state/pipelineHistoryStore.js";
import { RawProfileCache } from "../state/rawProfileCache.js";

export type { PipelineRunInput, PipelineRunResponse } from "../../shared/pipelineTypes.js";

export interface ProfilePipelineServiceOptions {
  appDataDir: string;
  fetcher?: typeof fetch;
  controllerFetcher?: typeof fetch;
  checkerRunner?: CommandRunner;
  now?: () => Date;
  sessionId?: () => string;
}

export function createProfilePipelineService(options: ProfilePipelineServiceOptions) {
  const store = createConfigStore(options.appDataDir);
  const historyStore = createPipelineHistoryStore(options.appDataDir);
  const coreLogStore = createCoreLogStore(options.appDataDir);
  const overrideSettingsStore = createOverrideSettingsStore(options.appDataDir);

  return {
    async runProfilePipeline(input: PipelineRunInput): Promise<PipelineRunResponse> {
      const sessionId = input.diagnostics?.sessionId ?? options.sessionId?.() ?? randomSessionId();
      const createdAt = options.now?.() ?? new Date();
      const result = await runProfilePipeline({
        profileId: input.profileId,
        store,
        render: () =>
          renderForProfile(input, {
            appDataDir: options.appDataDir,
            fetcher: options.fetcher,
            overrideSettingsStore
          }),
        checker: {
          ...input.checker,
          runner: options.checkerRunner
        },
        controller: createControllerClient({
          ...input.controller,
          fetcher: options.controllerFetcher
        }),
        diagnostics: {
          rootDir: join(options.appDataDir, "logs"),
          sessionId,
          now: createdAt
        }
      });

      const response = toPipelineRunResponse(result);
      await historyStore.append(input, response, createdAt);
      return response;
    },

    async prepareProfile(input: PipelineRunInput): Promise<PipelinePrepareResponse> {
      const result = await renderValidateAndPromote({
        profileId: input.profileId,
        store,
        render: () =>
          renderForProfile(input, {
            appDataDir: options.appDataDir,
            fetcher: options.fetcher,
            overrideSettingsStore
          }),
        checker: {
          ...input.checker,
          runner: options.checkerRunner
        }
      });

      return toPipelinePrepareResponse(result);
    },

    listPipelineHistory(): Promise<PipelineRunHistoryRecord[]> {
      return historyStore.list();
    },

    async listCoreLogs(profileId: string): Promise<CoreLogViewEvent[]> {
      const events = await coreLogStore.read(profileId);
      return events.slice(-100).map((event) => ({
        time: event.time,
        source: event.source,
        level: event.level,
        message: event.message
      }));
    },

    async exportFailureReport(
      input: FailureReportExportInput
    ): Promise<FailureReportExportResponse> {
      try {
        const history = await historyStore.list();
        const record = history.find((item) => item.id === input.historyId);
        if (!record) {
          throw new Error("Pipeline history record was not found");
        }
        if (!record.failureBundlePath) {
          throw new Error("Pipeline history record has no failure bundle");
        }

        const coreLogs = await coreLogStore.read(record.profileId);
        const report = await exportCoreFailureReport({
          rootDir: options.appDataDir,
          profileId: record.profileId,
          sessionId: record.id,
          failureBundlePath: record.failureBundlePath,
          history: history.map(toDiagnosticHistoryRecord),
          coreLogs: coreLogs.slice(-200).map((event) => ({
            time: event.time,
            source: event.source,
            level: event.level,
            message: event.message
          })),
          now: options.now?.()
        });

        return {
          ok: true,
          reportDir: report.reportDir,
          files: report.files
        };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        return {
          ok: false,
          error: {
            name: normalized.name,
            message: normalized.message
          }
        };
      }
    }
  };
}

async function renderForProfile(
  input: PipelineRunInput,
  options: {
    appDataDir: string;
    fetcher?: typeof fetch;
    overrideSettingsStore: ReturnType<typeof createOverrideSettingsStore>;
  }
): Promise<RenderForStageResult> {
  const selectedOverrides = await materializeSelectedOverrides(
    options.overrideSettingsStore,
    input.profileId
  );
  if (selectedOverrides instanceof Error) {
    return {
      ok: false,
      stage: "yaml-override",
      error: selectedOverrides,
      overrideId: "selected-overrides"
    };
  }
  const runtimeConfig = controllerRuntimeConfig(
    input.controller.baseUrl,
    input.controller.secret
  );
  if (runtimeConfig instanceof Error) {
    return {
      ok: false,
      stage: "yaml-override",
      error: runtimeConfig,
      overrideId: "runtime-controller"
    };
  }

  return renderProfile({
    profileId: input.profileId,
    subscription: {
      ...input.subscription,
      cache: new RawProfileCache(options.appDataDir),
      fetcher: options.fetcher,
      sleep: async () => undefined
    },
    overrides: selectedOverrides.overrides,
    yamlOverrides: input.yamlOverrides,
    jsOverrides: input.jsOverrides,
    finalYamlOverrides: [
      {
        id: "runtime-controller",
        value: runtimeConfig
      }
    ]
  });
}

function controllerRuntimeConfig(baseUrl: string, secret: string): Record<string, string> | Error {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "0.0.0.0") {
      throw new Error("Controller baseUrl must not use 0.0.0.0");
    }

    return {
      "external-controller": `${url.hostname}:${url.port || "9090"}`,
      secret
    };
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function materializeSelectedOverrides(
  store: ReturnType<typeof createOverrideSettingsStore>,
  profileId: string
): Promise<
  | Awaited<ReturnType<ReturnType<typeof createOverrideSettingsStore>["materializeSelected"]>>
  | Error
> {
  try {
    return await store.materializeSelected(profileId);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function toPipelineRunResponse(result: RunProfilePipelineResult): PipelineRunResponse {
  if (result.ok) {
    return {
      ok: true,
      stage: "applied",
      mode: result.result.apply.mode,
      activePath: result.result.apply.activePath,
      lastKnownGoodPath: result.result.apply.lastKnownGoodPath,
      warnings: result.result.render.warnings
    };
  }

  return {
    ok: false,
    stage: result.result.stage,
    error: {
      name: result.result.error.name,
      message: result.result.error.message
    },
    failureBundlePath: result.failureBundle.bundlePath
  };
}

function toPipelinePrepareResponse(result: RenderValidateAndPromoteResult): PipelinePrepareResponse {
  if (result.ok) {
    return {
      ok: true,
      stage: "promoted",
      activePath: result.promotion.activePath,
      candidatePath: result.promotion.candidatePath,
      warnings: result.render.warnings
    };
  }

  return {
    ok: false,
    stage: result.stage,
    error: {
      name: result.error.name,
      message: result.error.message
    }
  };
}

function toDiagnosticHistoryRecord(record: PipelineRunHistoryRecord) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    profileId: record.profileId,
    subscriptionHost: record.subscriptionHost,
    ok: record.ok,
    stage: record.stage,
    mode: record.mode,
    errorMessage: record.errorMessage
  };
}

function randomSessionId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
