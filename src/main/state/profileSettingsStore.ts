import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProfileSettings } from "../../shared/pipelineTypes.js";

export interface ProfileSettingsStore {
  load(profileId: string): Promise<ProfileSettings | null>;
  save(settings: ProfileSettings): Promise<ProfileSettings>;
}

export function createProfileSettingsStore(appDataDir: string): ProfileSettingsStore {
  return {
    async load(profileId: string): Promise<ProfileSettings | null> {
      try {
        const parsed = JSON.parse(await readFile(settingsPath(appDataDir, profileId), "utf8")) as unknown;
        return isProfileSettings(parsed) ? parsed : null;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async save(settings: ProfileSettings): Promise<ProfileSettings> {
      const normalized = normalizeProfileSettings(settings);
      const path = settingsPath(appDataDir, normalized.profileId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      return normalized;
    }
  };
}

function normalizeProfileSettings(settings: ProfileSettings): ProfileSettings {
  const profileId = normalizeRequired(settings.profileId, "profileId");
  return {
    profileId,
    subscriptionUrl: redactUrl(settings.subscriptionUrl?.trim()),
    mihomoBinaryPath: settings.mihomoBinaryPath?.trim() || "mihomo.exe",
    mihomoDataDir: settings.mihomoDataDir?.trim() || "work",
    controllerBaseUrl: settings.controllerBaseUrl?.trim() || "http://127.0.0.1:9090",
    systemProxyHost: settings.systemProxyHost?.trim() || "127.0.0.1",
    systemProxyPort: normalizePort(settings.systemProxyPort),
    systemProxyBypass: settings.systemProxyBypass?.trim() || "localhost;127.*;<local>",
    updatedAt: settings.updatedAt
  };
}

function settingsPath(appDataDir: string, profileId: string): string {
  return join(appDataDir, "state", "profiles", `${sanitizeProfileId(profileId)}.json`);
}

function sanitizeProfileId(profileId: string): string {
  const safe = profileId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safe.length === 0) {
    throw new Error("profileId must contain at least one safe character");
  }
  return safe;
}

function normalizeRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function normalizePort(value: string): string {
  const trimmed = value.trim();
  const port = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "7890";
  }
  return String(port);
}

function redactUrl(value: string | undefined): string {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function isProfileSettings(value: unknown): value is ProfileSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProfileSettings).profileId === "string"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
