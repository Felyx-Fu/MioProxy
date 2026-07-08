import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseYamlToObject,
  type ConfigOverrideRef,
  type JsOverrideRef,
  type YamlOverrideRef
} from "@mioproxy/config-pipeline";
import type {
  OverrideMetadata,
  OverrideSelection,
  OverrideSettingsState
} from "../../shared/pipelineTypes.js";

export interface OverrideSettingsStore {
  getState(): Promise<OverrideSettingsState>;
  saveImported(overrides: OverrideMetadata[]): Promise<OverrideSettingsState>;
  setSelection(selection: OverrideSelection): Promise<OverrideSettingsState>;
  materializeSelected(profileId: string): Promise<{
    overrides: ConfigOverrideRef[];
    yamlOverrides: YamlOverrideRef[];
    jsOverrides: JsOverrideRef[];
  }>;
}

export function createOverrideSettingsStore(appDataDir: string): OverrideSettingsStore {
  const statePath = join(appDataDir, "state", "overrides.json");

  return {
    getState(): Promise<OverrideSettingsState> {
      return readState(statePath);
    },

    async saveImported(overrides: OverrideMetadata[]): Promise<OverrideSettingsState> {
      const current = await readState(statePath);
      const byId = new Map(current.items.map((item) => [item.id, item]));
      for (const override of overrides) {
        byId.set(override.id, {
          ...byId.get(override.id),
          ...normalizeOverride(override)
        });
      }
      const next = {
        ...current,
        items: [...byId.values()]
      };
      await writeState(statePath, next);
      return next;
    },

    async setSelection(selection: OverrideSelection): Promise<OverrideSettingsState> {
      const current = await readState(statePath);
      const selectedIds = [...new Set(selection.selectedIds)];
      const nextSelections = {
        ...current.selections,
        [selection.profileId]: selectedIds
      };
      const next = {
        ...current,
        selections: nextSelections
      };
      await writeState(statePath, next);
      return next;
    },

    async materializeSelected(profileId: string): Promise<{
      overrides: ConfigOverrideRef[];
      yamlOverrides: YamlOverrideRef[];
      jsOverrides: JsOverrideRef[];
    }> {
      const current = await readState(statePath);
      const selectedIds = new Set(current.selections[profileId] ?? []);
      const global = current.items.filter((item) => item.global);
      const selected = current.items.filter((item) => !item.global && selectedIds.has(item.id));
      const ordered = [...global, ...selected];
      const overrides: ConfigOverrideRef[] = [];
      const yamlOverrides: YamlOverrideRef[] = [];
      const jsOverrides: JsOverrideRef[] = [];

      for (const item of ordered) {
        if (!item.path) {
          throw new Error(`Override ${item.id} has no source path`);
        }

        const contents = await readFile(item.path, "utf8");
        if (item.ext === "yaml") {
          const yamlOverride = { id: item.id, value: parseYamlToObject(contents) };
          yamlOverrides.push(yamlOverride);
          overrides.push({ kind: "yaml", ...yamlOverride });
        } else if (item.ext === "js") {
          const jsOverride = { id: item.id, script: contents };
          jsOverrides.push(jsOverride);
          overrides.push({ kind: "js", ...jsOverride });
        }
      }

      return { overrides, yamlOverrides, jsOverrides };
    }
  };
}

async function readState(path: string): Promise<OverrideSettingsState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (isState(parsed)) {
      return parsed;
    }
    return emptyState();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
}

async function writeState(path: string, state: OverrideSettingsState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function emptyState(): OverrideSettingsState {
  return {
    items: [],
    selections: {}
  };
}

function normalizeOverride(override: OverrideMetadata): OverrideMetadata {
  return {
    id: normalizeRequired(override.id, "override id"),
    name: override.name.trim() || override.id,
    type: override.type?.trim() || undefined,
    ext: override.ext === "yaml" ? "yaml" : "js",
    global: Boolean(override.global),
    path: override.path,
    importedFrom: override.importedFrom
  };
}

function normalizeRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function isState(value: unknown): value is OverrideSettingsState {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as OverrideSettingsState).items) &&
    typeof (value as OverrideSettingsState).selections === "object" &&
    (value as OverrideSettingsState).selections !== null
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
