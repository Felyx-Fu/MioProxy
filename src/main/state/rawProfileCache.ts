import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SubscriptionCache } from "@mioproxy/config-pipeline";

export class RawProfileCache implements SubscriptionCache {
  constructor(private readonly appDataDir: string) {}

  async read(profileId: string): Promise<string | null> {
    try {
      return await readFile(this.rawPath(profileId), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async write(profileId: string, contents: string): Promise<void> {
    const path = this.rawPath(profileId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }

  rawPath(profileId: string): string {
    return join(this.appDataDir, "profiles", sanitizeProfileId(profileId), "raw.yaml");
  }
}

export function sanitizeProfileId(profileId: string): string {
  const safe = profileId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safe.length === 0) {
    throw new Error("profileId must contain at least one safe character");
  }
  return safe;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
