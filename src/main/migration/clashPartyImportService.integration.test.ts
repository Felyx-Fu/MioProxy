import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOverrideSettingsStore } from "../state/overrideSettingsStore.js";
import { createProfileSettingsStore } from "../state/profileSettingsStore.js";
import { RawProfileCache } from "../state/rawProfileCache.js";
import { createClashPartyImportService } from "./clashPartyImportService.js";

const sourceDir = process.env.MIOPROXY_CLASH_PARTY_SOURCE;
const describeIfSource = sourceDir ? describe : describe.skip;
let appDataDir: string;

beforeEach(async () => {
  appDataDir = await mkdtemp(join(tmpdir(), "mioproxy-real-import-"));
});

afterEach(async () => {
  await rm(appDataDir, { recursive: true, force: true });
});

describeIfSource("createClashPartyImportService real source import", () => {
  it("imports real Clash Party settings into a temporary MioProxy state", async () => {
    const service = createClashPartyImportService({ appDataDir });

    const result = await service.importFrom({ sourceDir: sourceDir ?? "" });

    expect(result.ok).toBe(true);
    expect(result.profiles.length).toBeGreaterThan(0);
    const profile = result.profiles[0];
    expect(profile?.profileId).toBeTruthy();
    expect(profile?.cacheImported).toBe(true);
    expect(profile?.controllerBaseUrl).toMatch(/^https?:\/\/127\.0\.0\.1:/);
    const profileStore = createProfileSettingsStore(appDataDir);
    const savedProfile = await profileStore.load(profile?.profileId ?? "");
    expect(savedProfile?.subscriptionUrl).not.toContain("?");
    expect(savedProfile?.subscriptionUrl).not.toContain("#");
    const rawCache = await new RawProfileCache(appDataDir).read(profile?.profileId ?? "");
    expect(rawCache?.trim().length).toBeGreaterThan(0);

    const overrideState = await createOverrideSettingsStore(appDataDir).getState();
    expect(overrideState.items).toHaveLength(result.overrides.length);
    expect(overrideState.selections[profile?.profileId ?? ""]).toEqual(profile?.overrideIds ?? []);
  });
});
