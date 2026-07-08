import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  PipelineRunHistoryRecord,
  PipelineRunInput,
  PipelineRunResponse
} from "../../shared/pipelineTypes.js";

export interface PipelineHistoryStore {
  list(): Promise<PipelineRunHistoryRecord[]>;
  append(input: PipelineRunInput, response: PipelineRunResponse, createdAt: Date): Promise<PipelineRunHistoryRecord>;
}

const MAX_HISTORY = 20;

export function createPipelineHistoryStore(appDataDir: string): PipelineHistoryStore {
  const historyPath = join(appDataDir, "state", "pipeline-history.json");

  return {
    async list(): Promise<PipelineRunHistoryRecord[]> {
      return readHistory(historyPath);
    },

    async append(
      input: PipelineRunInput,
      response: PipelineRunResponse,
      createdAt: Date
    ): Promise<PipelineRunHistoryRecord> {
      const current = await readHistory(historyPath);
      const record = toHistoryRecord(input, response, createdAt);
      const next = [record, ...current].slice(0, MAX_HISTORY);
      await mkdir(dirname(historyPath), { recursive: true });
      await writeFile(historyPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return record;
    }
  };
}

function toHistoryRecord(
  input: PipelineRunInput,
  response: PipelineRunResponse,
  createdAt: Date
): PipelineRunHistoryRecord {
  const base = {
    id: `${createdAt.getTime()}-${input.profileId.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    createdAt: createdAt.toISOString(),
    profileId: input.profileId,
    subscriptionHost: subscriptionHost(input.subscription.url),
    ok: response.ok,
    stage: response.stage
  };

  if (response.ok) {
    return {
      ...base,
      mode: response.mode,
      activePath: response.activePath,
      lastKnownGoodPath: response.lastKnownGoodPath
    };
  }

  return {
    ...base,
    failureBundlePath: response.failureBundlePath,
    errorMessage: response.error.message
  };
}

async function readHistory(historyPath: string): Promise<PipelineRunHistoryRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(historyPath, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isHistoryRecord) : [];
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function subscriptionHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "invalid-url";
  }
}

function isHistoryRecord(value: unknown): value is PipelineRunHistoryRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PipelineRunHistoryRecord).id === "string" &&
    typeof (value as PipelineRunHistoryRecord).createdAt === "string" &&
    typeof (value as PipelineRunHistoryRecord).profileId === "string"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
