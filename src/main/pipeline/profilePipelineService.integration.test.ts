import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseYamlToObject } from "@mioproxy/config-pipeline";
import { createClashPartyImportService } from "../migration/clashPartyImportService.js";
import { createProfilePipelineService } from "./profilePipelineService.js";

const clashPartySource = process.env.MIOPROXY_CLASH_PARTY_SOURCE;
const mihomoBinary = process.env.MIOPROXY_MIHOMO_BINARY;
const describeIfReady = clashPartySource && mihomoBinary ? describe : describe.skip;
let appDataDir: string;
let workDir: string;

beforeEach(async () => {
  appDataDir = await mkdtemp(join(tmpdir(), "mioproxy-real-pipeline-"));
  workDir = await mkdtemp(join(tmpdir(), "mioproxy-real-work-"));
});

afterEach(async () => {
  await rm(appDataDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

function response(body: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => body
  } as Response;
}

describeIfReady("createProfilePipelineService real Clash Party cache validation", () => {
  it("renders imported cache and validates candidate.yaml with a real Mihomo binary", async () => {
    const importResult = await createClashPartyImportService({ appDataDir }).importFrom({
      sourceDir: clashPartySource ?? ""
    });
    const profile = importResult.profiles.find((item) => item.cacheImported) ?? importResult.profiles[0];
    expect(profile).toBeDefined();
    await cp(join(clashPartySource ?? "", "work"), workDir, {
      recursive: true,
      filter: (source) => !basename(source).endsWith(".db")
    });
    const service = createProfilePipelineService({
      appDataDir,
      fetcher: vi.fn(async () => {
        throw new Error("network disabled for cache validation");
      }) as unknown as typeof fetch,
      controllerFetcher: vi.fn(async () => response("", { status: 204 })) as unknown as typeof fetch,
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      sessionId: () => "real-cache-validation"
    });

    const result = await service.runProfilePipeline({
      profileId: profile?.profileId ?? "",
      subscription: {
        url: profile?.subscriptionUrl || "https://example.invalid/sub.yaml",
        retries: 1
      },
      checker: {
        binaryPath: mihomoBinary ?? "",
        dataDir: workDir,
        timeoutMs: 30_000
      },
      controller: {
        baseUrl: "http://127.0.0.1:9090",
        secret: "integration-secret"
      },
      diagnostics: {
        sessionId: "real-cache-validation"
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activePath).toContain("active.yaml");
      expect(result.lastKnownGoodPath).toContain("last-known-good.yaml");
      const activeConfig = parseYamlToObject(await readFile(result.activePath, "utf8"));
      expect(activeConfig["external-controller"]).toBe("127.0.0.1:9090");
      expect(activeConfig.secret).toBe("integration-secret");
    }
  });
});
