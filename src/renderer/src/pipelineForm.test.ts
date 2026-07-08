import { describe, expect, it } from "vitest";
import {
  applyProfileSettings,
  buildActivationStartInput,
  buildControllerHealthInput,
  buildControllerLogStartInput,
  buildCoreStartInput,
  buildPipelineInput,
  buildProfileSettings,
  buildSystemProxyEnableInput,
  defaultPipelineFormState
} from "./pipelineForm";

describe("buildPipelineInput", () => {
  it("builds the IPC input from form state", () => {
    expect(
      buildPipelineInput({
        ...defaultPipelineFormState,
        subscriptionUrl: " https://example.test/sub.yaml ",
        controllerSecret: " secret "
      })
    ).toEqual({
      profileId: "default",
      subscription: {
        url: "https://example.test/sub.yaml",
        retries: 3,
        timeoutMs: 30_000
      },
      checker: {
        binaryPath: "mihomo.exe",
        dataDir: "work",
        timeoutMs: 10_000
      },
      controller: {
        baseUrl: "http://127.0.0.1:9090",
        secret: "secret",
        timeoutMs: 10_000
      }
    });
  });

  it("uses a cache-only placeholder when subscription URL is empty", () => {
    expect(
      buildPipelineInput({
        ...defaultPipelineFormState,
        controllerSecret: "secret"
      }).subscription.url
    ).toBe("https://example.invalid/mioproxy-cache-only.yaml");
  });

  it("requires controller secret", () => {
    expect(() =>
      buildPipelineInput({
        ...defaultPipelineFormState,
        subscriptionUrl: "https://example.test/sub.yaml"
      })
    ).toThrow("Controller secret is required");
  });

  it("builds core start input without subscription or controller fields", () => {
    expect(
      buildCoreStartInput({
        ...defaultPipelineFormState,
        profileId: " default ",
        subscriptionUrl: "",
        controllerSecret: "",
        mihomoBinaryPath: " mihomo.exe ",
        mihomoDataDir: " work "
      })
    ).toEqual({
      profileId: "default",
      binaryPath: "mihomo.exe",
      dataDir: "work"
    });
  });

  it("builds controller log start input from controller fields", () => {
    expect(
      buildControllerLogStartInput({
        ...defaultPipelineFormState,
        profileId: " default ",
        controllerBaseUrl: " http://127.0.0.1:9090 ",
        controllerSecret: " secret "
      })
    ).toEqual({
      profileId: "default",
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      level: "info"
    });
  });

  it("builds controller health input from controller fields", () => {
    expect(
      buildControllerHealthInput({
        ...defaultPipelineFormState,
        controllerBaseUrl: " http://127.0.0.1:9090 ",
        controllerSecret: " secret "
      })
    ).toEqual({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      timeoutMs: 5_000
    });
  });

  it("builds system proxy enable input", () => {
    expect(
      buildSystemProxyEnableInput({
        ...defaultPipelineFormState,
        systemProxyHost: " 127.0.0.1 ",
        systemProxyPort: " 7890 ",
        systemProxyBypass: " localhost "
      })
    ).toEqual({
      host: "127.0.0.1",
      port: 7890,
      bypass: "localhost"
    });
  });

  it("validates system proxy port", () => {
    expect(() =>
      buildSystemProxyEnableInput({
        ...defaultPipelineFormState,
        systemProxyPort: "70000"
      })
    ).toThrow("System proxy port must be between 1 and 65535");
  });

  it("builds activation input from runtime and proxy fields", () => {
    expect(
      buildActivationStartInput({
        ...defaultPipelineFormState,
        profileId: " default ",
        controllerSecret: " secret "
      })
    ).toEqual({
      profileId: "default",
      binaryPath: "mihomo.exe",
      dataDir: "work",
      controller: {
        baseUrl: "http://127.0.0.1:9090",
        secret: "secret",
        timeoutMs: 5_000
      },
      systemProxy: {
        host: "127.0.0.1",
        port: 7890,
        bypass: "localhost;127.*;<local>"
      },
      startControllerLogs: true,
      enableSystemProxy: true,
      health: {
        attempts: 5,
        delayMs: 500
      }
    });
  });

  it("builds profile settings without controller secret", () => {
    expect(
      buildProfileSettings({
        ...defaultPipelineFormState,
        subscriptionUrl: " https://example.test/sub.yaml ",
        controllerSecret: "secret"
      })
    ).toEqual({
      profileId: "default",
      subscriptionUrl: "https://example.test/sub.yaml",
      mihomoBinaryPath: "mihomo.exe",
      mihomoDataDir: "work",
      controllerBaseUrl: "http://127.0.0.1:9090",
      systemProxyHost: "127.0.0.1",
      systemProxyPort: "7890",
      systemProxyBypass: "localhost;127.*;<local>",
      updatedAt: "1970-01-01T00:00:00.000Z"
    });
  });

  it("applies profile settings without changing controller secret", () => {
    expect(
      applyProfileSettings(
        { ...defaultPipelineFormState, controllerSecret: "secret" },
        {
          profileId: "saved",
          subscriptionUrl: "https://example.test/sub.yaml",
          mihomoBinaryPath: "mihomo.exe",
          mihomoDataDir: "work",
          controllerBaseUrl: "http://127.0.0.1:9090",
          systemProxyHost: "127.0.0.1",
          systemProxyPort: "7890",
          systemProxyBypass: "localhost",
          updatedAt: "2026-07-07T10:00:00.000Z"
        }
      ).controllerSecret
    ).toBe("secret");
  });
});
