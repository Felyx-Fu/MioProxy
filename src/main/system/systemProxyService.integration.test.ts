import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemProxyService } from "./systemProxyService.js";

const shouldMutateSystemProxy = process.env.MIOPROXY_TEST_SYSTEM_PROXY === "1";
const describeIfOptIn = shouldMutateSystemProxy ? describe : describe.skip;
let appDataDir: string;

beforeEach(async () => {
  appDataDir = await mkdtemp(join(tmpdir(), "mioproxy-system-proxy-real-"));
});

afterEach(async () => {
  await rm(appDataDir, { recursive: true, force: true });
});

describeIfOptIn("createSystemProxyService real Windows proxy mutation", () => {
  it("enables and restores the current user WinINET proxy state", async () => {
    const service = createSystemProxyService({ appDataDir, platform: "win32" });
    const before = await service.status();
    expect(before.supported).toBe(true);

    try {
      const enabled = await service.enable({
        host: "127.0.0.1",
        port: 65530,
        bypass: "localhost;127.*;<local>"
      });
      expect(enabled.ok).toBe(true);
      expect(enabled.status).toMatchObject({
        enabled: true,
        server: "127.0.0.1:65530",
        managedSnapshot: true
      });
    } finally {
      const restored = await service.restore();
      expect(restored.ok).toBe(true);
      const after = await service.status();
      expect(after.enabled).toBe(before.enabled);
      expect(after.server).toBe(before.server);
      expect(after.bypass).toBe(before.bypass);
      expect(after.managedSnapshot).toBe(false);
    }
  });
});
