import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOverrideSettingsStore } from "./overrideSettingsStore.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-overrides-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createOverrideSettingsStore", () => {
  it("returns empty state when no override state exists", async () => {
    await expect(createOverrideSettingsStore(tempDir).getState()).resolves.toEqual({
      items: [],
      selections: {}
    });
  });

  it("saves imported override metadata", async () => {
    const store = createOverrideSettingsStore(tempDir);
    await expect(
      store.saveImported([
        {
          id: "script",
          name: "Script",
          type: "local",
          ext: "js",
          global: true,
          path: "override/script.js",
          importedFrom: "source"
        }
      ])
    ).resolves.toEqual({
      items: [
        {
          id: "script",
          name: "Script",
          type: "local",
          ext: "js",
          global: true,
          path: "override/script.js",
          importedFrom: "source"
        }
      ],
      selections: {}
    });
  });

  it("stores selected override ids per profile without duplicates", async () => {
    const store = createOverrideSettingsStore(tempDir);
    await store.setSelection({ profileId: "default", selectedIds: ["a", "a", "b"] });

    await expect(store.getState()).resolves.toEqual({
      items: [],
      selections: {
        default: ["a", "b"]
      }
    });
  });

  it("materializes global overrides before selected profile overrides", async () => {
    const dir = join(tempDir, "source");
    await mkdir(dir, { recursive: true });
    const jsPath = join(dir, "override.js");
    const yamlPath = join(dir, "override.yaml");
    const globalYamlPath = join(dir, "global.yaml");
    await writeFile(jsPath, "function main(config) { config.mode = 'rule'; return config; }\n", "utf8");
    await writeFile(yamlPath, "+rules:\n  - DOMAIN,example.test,DIRECT\n", "utf8");
    await writeFile(globalYamlPath, "+rules:\n  - DOMAIN,global.test,DIRECT\n", "utf8");
    const store = createOverrideSettingsStore(tempDir);
    await store.saveImported([
      { id: "global-yaml", name: "Global YAML", ext: "yaml", global: true, path: globalYamlPath },
      { id: "script", name: "Script", ext: "js", global: false, path: jsPath },
      { id: "yaml", name: "Yaml", ext: "yaml", global: false, path: yamlPath }
    ]);
    await store.setSelection({ profileId: "default", selectedIds: ["script", "yaml"] });

    await expect(store.materializeSelected("default")).resolves.toEqual({
      overrides: [
        {
          id: "global-yaml",
          kind: "yaml",
          value: {
            "+rules": ["DOMAIN,global.test,DIRECT"]
          }
        },
        {
          id: "script",
          kind: "js",
          script: "function main(config) { config.mode = 'rule'; return config; }\n"
        },
        {
          id: "yaml",
          kind: "yaml",
          value: {
            "+rules": ["DOMAIN,example.test,DIRECT"]
          }
        }
      ],
      jsOverrides: [
        {
          id: "script",
          script: "function main(config) { config.mode = 'rule'; return config; }\n"
        }
      ],
      yamlOverrides: [
        {
          id: "global-yaml",
          value: {
            "+rules": ["DOMAIN,global.test,DIRECT"]
          }
        },
        {
          id: "yaml",
          value: {
            "+rules": ["DOMAIN,example.test,DIRECT"]
          }
        }
      ]
    });
  });
});
