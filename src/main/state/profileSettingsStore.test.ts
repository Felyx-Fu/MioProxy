import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProfileSettingsStore } from "./profileSettingsStore.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-profile-settings-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createProfileSettingsStore", () => {
  it("returns null for missing profile settings", async () => {
    await expect(createProfileSettingsStore(tempDir).load("default")).resolves.toBeNull();
  });

  it("saves profile settings without controller secret or URL query token", async () => {
    const store = createProfileSettingsStore(tempDir);
    const saved = await store.save({
      profileId: "default",
      subscriptionUrl: "https://example.test/sub.yaml?token=private#hash",
      mihomoBinaryPath: " mihomo.exe ",
      mihomoDataDir: " work ",
      controllerBaseUrl: " http://127.0.0.1:9090 ",
      systemProxyHost: " 127.0.0.1 ",
      systemProxyPort: " 7890 ",
      systemProxyBypass: " localhost ",
      updatedAt: "2026-07-07T10:00:00.000Z"
    });

    expect(saved).toEqual({
      profileId: "default",
      subscriptionUrl: "https://example.test/sub.yaml",
      mihomoBinaryPath: "mihomo.exe",
      mihomoDataDir: "work",
      controllerBaseUrl: "http://127.0.0.1:9090",
      systemProxyHost: "127.0.0.1",
      systemProxyPort: "7890",
      systemProxyBypass: "localhost",
      updatedAt: "2026-07-07T10:00:00.000Z"
    });

    const raw = await readFile(join(tempDir, "state", "profiles", "default.json"), "utf8");
    expect(raw).not.toContain("private");
    expect(raw).not.toContain("controllerSecret");
  });

  it("sanitizes profile id in path", async () => {
    const store = createProfileSettingsStore(tempDir);
    await store.save({
      profileId: "bad/profile",
      subscriptionUrl: "",
      mihomoBinaryPath: "mihomo.exe",
      mihomoDataDir: "work",
      controllerBaseUrl: "http://127.0.0.1:9090",
      systemProxyHost: "127.0.0.1",
      systemProxyPort: "7890",
      systemProxyBypass: "localhost",
      updatedAt: "2026-07-07T10:00:00.000Z"
    });

    await expect(readFile(join(tempDir, "state", "profiles", "bad_profile.json"), "utf8")).resolves.toContain(
      "bad/profile"
    );
  });

  it("normalizes invalid system proxy port to default", async () => {
    const saved = await createProfileSettingsStore(tempDir).save({
      profileId: "default",
      subscriptionUrl: "",
      mihomoBinaryPath: "",
      mihomoDataDir: "",
      controllerBaseUrl: "",
      systemProxyHost: "",
      systemProxyPort: "70000",
      systemProxyBypass: "",
      updatedAt: "2026-07-07T10:00:00.000Z"
    });

    expect(saved.systemProxyPort).toBe("7890");
  });
});
