import { copyFile, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimePaths } from "../types.js";

export interface ConfigStore {
  pathsForProfile(profileId: string): RuntimePaths;
  writeCandidate(profileId: string, renderedYaml: string): Promise<string>;
  promoteCandidateToActive(profileId: string): Promise<string>;
  markLastKnownGood(profileId: string): Promise<string>;
  rollbackToLastKnownGood(profileId: string): Promise<string | null>;
}

export function createConfigStore(rootDir: string): ConfigStore {
  return {
    pathsForProfile(profileId: string): RuntimePaths {
      const profileDir = join(rootDir, "profiles", sanitizeProfileId(profileId));
      return {
        profileDir,
        candidatePath: join(profileDir, "candidate.yaml"),
        activePath: join(profileDir, "active.yaml"),
        lastKnownGoodPath: join(profileDir, "last-known-good.yaml")
      };
    },

    async writeCandidate(profileId: string, renderedYaml: string): Promise<string> {
      const paths = this.pathsForProfile(profileId);
      await mkdir(paths.profileDir, { recursive: true });
      await atomicWrite(paths.candidatePath, renderedYaml);
      return paths.candidatePath;
    },

    async promoteCandidateToActive(profileId: string): Promise<string> {
      const paths = this.pathsForProfile(profileId);
      await mkdir(paths.profileDir, { recursive: true });
      await rename(paths.candidatePath, paths.activePath);
      return paths.activePath;
    },

    async markLastKnownGood(profileId: string): Promise<string> {
      const paths = this.pathsForProfile(profileId);
      await copyFile(paths.activePath, paths.lastKnownGoodPath);
      return paths.lastKnownGoodPath;
    },

    async rollbackToLastKnownGood(profileId: string): Promise<string | null> {
      const paths = this.pathsForProfile(profileId);
      try {
        await copyFile(paths.lastKnownGoodPath, paths.activePath);
        return paths.activePath;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    }
  };
}

async function atomicWrite(targetPath: string, contents: string): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(targetPath), { recursive: true });

  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
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
