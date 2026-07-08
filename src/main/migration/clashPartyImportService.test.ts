import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverrideSettingsStore } from "../state/overrideSettingsStore.js";
import type { ProfileSettingsStore } from "../state/profileSettingsStore.js";
import { RawProfileCache } from "../state/rawProfileCache.js";
import { createClashPartyImportService } from "./clashPartyImportService.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-clash-party-import-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createClashPartyImportService", () => {
  it("imports profile settings and override metadata without copying override contents", async () => {
    await writeClashPartyFixture(tempDir);
    const saved: unknown[] = [];
    const store: ProfileSettingsStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async (settings) => {
        saved.push(settings);
        return {
          ...settings,
          subscriptionUrl: "https://example.test/sub.yaml?redacted=1"
        };
      })
    };
    const overrideStore: OverrideSettingsStore = {
      getState: vi.fn(async () => ({ items: [], selections: {} })),
      saveImported: vi.fn(async () => ({ items: [], selections: {} })),
      setSelection: vi.fn(async () => ({ items: [], selections: {} })),
      materializeSelected: vi.fn(async () => ({ overrides: [], yamlOverrides: [], jsOverrides: [] }))
    };
    const service = createClashPartyImportService({
      appDataDir: join(tempDir, "app"),
      store,
      overrideStore,
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    const result = await service.importFrom({ sourceDir: tempDir });

    expect(result.ok).toBe(true);
    expect(result.profiles).toEqual([
      expect.objectContaining({
        profileId: "Airport",
        sourceId: "profile-1",
        sourceType: "remote",
        overrideIds: ["override-1"],
        cacheImported: true,
        subscriptionUrl: "https://example.test/sub.yaml?redacted=1",
        controllerBaseUrl: "http://127.0.0.1:9090",
        systemProxyPort: "7890"
      })
    ]);
    expect(result.overrides).toEqual([
      expect.objectContaining({
        id: "override-1",
        name: "Smart override",
        ext: "js",
        global: false,
        path: join(tempDir, "override", "override-1.js")
      }),
      expect.objectContaining({
        id: "global-override",
        name: "Global override",
        ext: "yaml",
        global: true,
        path: join(tempDir, "override", "global-override.yaml")
      })
    ]);
    expect(result.warnings).toContain(
      "Override metadata was imported for review only; override file contents were not copied."
    );
    expect(result.warnings).not.toContain("Profile Airport old subscription cache was not found.");
    await expect(new RawProfileCache(join(tempDir, "app")).read("Airport")).resolves.toContain(
      "MATCH,DIRECT"
    );
    expect(saved).toEqual([
      expect.objectContaining({
        profileId: "Airport",
        subscriptionUrl: "https://example.test/sub.yaml?token=secret",
        updatedAt: "2026-07-07T10:00:00.000Z"
      })
    ]);
    expect(overrideStore.saveImported).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "override-1",
        ext: "js",
        importedFrom: tempDir
      }),
      expect.objectContaining({
        id: "global-override",
        ext: "yaml",
        global: true,
        importedFrom: tempDir
      })
    ]);
    expect(overrideStore.setSelection).toHaveBeenCalledWith({
      profileId: "Airport",
      selectedIds: ["override-1"]
    });
  });

  it("uses safe defaults when profile data is incomplete", async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(join(tempDir, "config.yaml"), "showMixedPort: 7891\n", "utf8");
    await writeFile(join(tempDir, "mihomo.yaml"), "external-controller: 0.0.0.0:9090\n", "utf8");
    await writeFile(join(tempDir, "profile.yaml"), "items:\n  - id: only-id\n", "utf8");
    await writeFile(join(tempDir, "override.yaml"), "items: []\n", "utf8");
    const store: ProfileSettingsStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async (settings) => settings)
    };
    const service = createClashPartyImportService({
      appDataDir: join(tempDir, "app"),
      store,
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    const result = await service.importFrom({ sourceDir: tempDir });

    expect(result.profiles[0]).toMatchObject({
      profileId: "only-id",
      subscriptionUrl: "",
      cacheImported: false,
      controllerBaseUrl: "http://127.0.0.1:9090",
      systemProxyPort: "7891"
    });
    expect(result.warnings).toContain("Profile only-id has no subscription URL.");
    expect(result.warnings).toContain("Profile only-id old subscription cache was not found.");
  });
});

async function writeClashPartyFixture(root: string): Promise<void> {
  await mkdir(join(root, "override"), { recursive: true });
  await mkdir(join(root, "profiles"), { recursive: true });
  await writeFile(join(root, "config.yaml"), "showMixedPort: 7890\n", "utf8");
  await writeFile(join(root, "mihomo.yaml"), "external-controller: 127.0.0.1:9090\nmixed-port: 7890\n", "utf8");
  await writeFile(
    join(root, "profile.yaml"),
    [
      "items:",
      "  - id: profile-1",
      "    name: Airport",
      "    type: remote",
      "    url: https://example.test/sub.yaml?token=secret",
      "    override:",
      "      - override-1",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(root, "override.yaml"),
    [
      "items:",
      "  - id: override-1",
      "    name: Smart override",
      "    type: script",
      "    ext: js",
      "    global: false",
      "  - id: global-override",
      "    name: Global override",
      "    type: local",
      "    ext: yaml",
      "    global: true",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(join(root, "override", "override-1.js"), "main = () => {}\n", "utf8");
  await writeFile(join(root, "override", "global-override.yaml"), "rules+:\n  - DOMAIN,global.test,DIRECT\n", "utf8");
  await writeFile(join(root, "profiles", "profile-1.yaml"), "rules:\n  - MATCH,DIRECT\n", "utf8");
}
