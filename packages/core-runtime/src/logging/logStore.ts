import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CoreLogEvent } from "./logEvents.js";
import { serializeLogEvent } from "./logEvents.js";

export interface CoreLogStore {
  append(profileId: string, event: CoreLogEvent): Promise<string>;
  read(profileId: string): Promise<CoreLogEvent[]>;
}

export function createCoreLogStore(rootDir: string): CoreLogStore {
  return {
    async append(profileId: string, event: CoreLogEvent): Promise<string> {
      const path = logPath(rootDir, profileId);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${serializeLogEvent(event)}\n`, "utf8");
      return path;
    },

    async read(profileId: string): Promise<CoreLogEvent[]> {
      const path = logPath(rootDir, profileId);
      try {
        const contents = await readFile(path, "utf8");
        return contents
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as CoreLogEvent);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    }
  };
}

function logPath(rootDir: string, profileId: string): string {
  return join(rootDir, "logs", "core", `${sanitizeProfileId(profileId)}.jsonl`);
}

function sanitizeProfileId(profileId: string): string {
  const safe = profileId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safe.length === 0) {
    throw new Error("profileId must contain at least one safe character");
  }
  return safe;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
