import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseYamlToObject } from "@mioproxy/config-pipeline";
import type {
  ClashPartyImportInput,
  ClashPartyImportResult,
  ClashPartyImportedOverride,
  ClashPartyImportedProfile,
  OverrideMetadata,
  ProfileSettings
} from "../../shared/pipelineTypes.js";
import type { OverrideSettingsStore } from "../state/overrideSettingsStore.js";
import { createOverrideSettingsStore } from "../state/overrideSettingsStore.js";
import type { ProfileSettingsStore } from "../state/profileSettingsStore.js";
import { createProfileSettingsStore } from "../state/profileSettingsStore.js";
import { RawProfileCache } from "../state/rawProfileCache.js";

export interface ClashPartyImportServiceOptions {
  appDataDir: string;
  store?: ProfileSettingsStore;
  overrideStore?: OverrideSettingsStore;
  now?: () => Date;
}

export function createClashPartyImportService(options: ClashPartyImportServiceOptions) {
  const store = options.store ?? createProfileSettingsStore(options.appDataDir);
  const overrideStore = options.overrideStore ?? createOverrideSettingsStore(options.appDataDir);
  const rawProfileCache = new RawProfileCache(options.appDataDir);
  const now = options.now ?? (() => new Date());

  return {
    async importFrom(input: ClashPartyImportInput): Promise<ClashPartyImportResult> {
      const sourceDir = normalizeRequired(input.sourceDir, "sourceDir");
      const config = await readYamlObject(join(sourceDir, "config.yaml"));
      const mihomo = await readYamlObject(join(sourceDir, "mihomo.yaml"));
      const profileConfig = await readYamlObject(join(sourceDir, "profile.yaml"));
      const overrideConfig = await readYamlObject(join(sourceDir, "override.yaml"));
      const profiles = profileItems(profileConfig).map((item) =>
        toImportedProfile(item, sourceDir, config, mihomo)
      );
      const overrides = overrideItems(overrideConfig).map((item) => toImportedOverride(item, sourceDir));
      const importedProfiles: ClashPartyImportedProfile[] = [];
      await overrideStore.saveImported(overrides.map((override) => toOverrideMetadata(override, sourceDir)));

      for (const profile of profiles) {
        const cacheImported = await importRawProfileCache({
          sourceDir,
          profile,
          cache: rawProfileCache
        });
        const saved = await store.save({
          profileId: profile.profileId,
          subscriptionUrl: profile.subscriptionUrl,
          mihomoBinaryPath: profile.mihomoBinaryPath,
          mihomoDataDir: profile.mihomoDataDir,
          controllerBaseUrl: profile.controllerBaseUrl,
          systemProxyHost: profile.systemProxyHost,
          systemProxyPort: profile.systemProxyPort,
          systemProxyBypass: profile.systemProxyBypass,
          updatedAt: now().toISOString()
        });
        importedProfiles.push({
          ...profile,
          subscriptionUrl: saved.subscriptionUrl,
          cacheImported
        });
        await overrideStore.setSelection({
          profileId: profile.profileId,
          selectedIds: profile.overrideIds
        });
      }

      return {
        ok: true,
        sourceDir,
        profiles: importedProfiles,
        overrides,
        warnings: buildWarnings(importedProfiles, overrides)
      };
    }
  };
}

async function readYamlObject(path: string): Promise<Record<string, unknown>> {
  const parsed = parseYamlToObject(await readFile(path, "utf8"));
  return parsed;
}

function profileItems(record: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(record.items) ? record.items.filter(isRecord) : [];
}

function overrideItems(record: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(record.items) ? record.items.filter(isRecord) : [];
}

function toImportedProfile(
  item: Record<string, unknown>,
  sourceDir: string,
  config: Record<string, unknown>,
  mihomo: Record<string, unknown>
): ClashPartyImportedProfile & ProfileSettings {
  const name = stringValue(item.name) ?? stringValue(item.id) ?? "default";
  const mixedPort = numberValue(mihomo["mixed-port"]) ?? numberValue(config.showMixedPort) ?? 7890;

  return {
    profileId: name,
    name,
    sourceId: stringValue(item.id),
    sourceType: stringValue(item.type),
    overrideIds: stringArray(item.override),
    cacheImported: false,
    subscriptionUrl: stringValue(item.url) ?? "",
    mihomoBinaryPath: "mihomo.exe",
    mihomoDataDir: join(sourceDir, "work"),
    controllerBaseUrl: controllerBaseUrl(stringValue(mihomo["external-controller"])),
    systemProxyHost: "127.0.0.1",
    systemProxyPort: String(mixedPort),
    systemProxyBypass: "localhost;127.*;<local>",
    updatedAt: ""
  };
}

function toImportedOverride(
  item: Record<string, unknown>,
  sourceDir: string
): ClashPartyImportedOverride {
  const id = stringValue(item.id) ?? "unknown";
  const ext = stringValue(item.ext) === "yaml" ? "yaml" : "js";
  const filePath = join(sourceDir, "override", `${id}.${ext}`);
  return {
    id,
    name: stringValue(item.name) ?? id,
    type: stringValue(item.type),
    ext,
    global: booleanValue(item.global) ?? false,
    path: filePath && existsSync(filePath) ? filePath : undefined
  };
}

function toOverrideMetadata(
  override: ClashPartyImportedOverride,
  sourceDir: string
): OverrideMetadata {
  return {
    id: override.id,
    name: override.name,
    type: override.type,
    ext: override.ext,
    global: override.global,
    path: override.path,
    importedFrom: sourceDir
  };
}

async function importRawProfileCache(options: {
  sourceDir: string;
  profile: ClashPartyImportedProfile;
  cache: RawProfileCache;
}): Promise<boolean> {
  if (!options.profile.sourceId) {
    return false;
  }

  const sourcePath = join(options.sourceDir, "profiles", `${options.profile.sourceId}.yaml`);
  if (!existsSync(sourcePath)) {
    return false;
  }

  const contents = await readFile(sourcePath, "utf8");
  if (contents.trim().length === 0) {
    return false;
  }

  await options.cache.write(options.profile.profileId, contents);
  return true;
}

function controllerBaseUrl(value: string | undefined): string {
  if (!value) {
    return "http://127.0.0.1:9090";
  }

  const normalized = value.startsWith("http://") || value.startsWith("https://")
    ? value
    : `http://${value}`;
  try {
    const url = new URL(normalized);
    if (url.hostname === "0.0.0.0" || url.hostname === "::") {
      url.hostname = "127.0.0.1";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "http://127.0.0.1:9090";
  }
}

function buildWarnings(
  profiles: ClashPartyImportedProfile[],
  overrides: ClashPartyImportedOverride[]
): string[] {
  const warnings: string[] = [];
  if (profiles.length === 0) {
    warnings.push("No Clash Party profiles were found.");
  }
  for (const profile of profiles) {
    if (!profile.subscriptionUrl) {
      warnings.push(`Profile ${profile.profileId} has no subscription URL.`);
    }
    if (!profile.cacheImported) {
      warnings.push(`Profile ${profile.profileId} old subscription cache was not found.`);
    }
  }
  for (const override of overrides) {
    if (!override.path) {
      warnings.push(`Override ${override.name} metadata was found but file ${basename(override.id)}.${override.ext} was missing.`);
    }
  }
  if (overrides.length > 0) {
    warnings.push("Override metadata was imported for review only; override file contents were not copied.");
  }
  return warnings;
}

function normalizeRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
