import type {
  ActivationStartInput,
  ControllerHealthCheckInput,
  ControllerLogStartInput,
  CoreProcessStartInput,
  PipelineRunInput,
  ProfileSettings,
  SystemProxyEnableInput
} from "../../shared/pipelineTypes";

export interface PipelineFormState {
  profileId: string;
  subscriptionUrl: string;
  mihomoBinaryPath: string;
  mihomoDataDir: string;
  controllerBaseUrl: string;
  controllerSecret: string;
  clashPartySourceDir: string;
  systemProxyHost: string;
  systemProxyPort: string;
  systemProxyBypass: string;
}

export const defaultPipelineFormState: PipelineFormState = {
  profileId: "default",
  subscriptionUrl: "",
  mihomoBinaryPath: "mihomo.exe",
  mihomoDataDir: "work",
  controllerBaseUrl: "http://127.0.0.1:9090",
  controllerSecret: "",
  clashPartySourceDir: "",
  systemProxyHost: "127.0.0.1",
  systemProxyPort: "7890",
  systemProxyBypass: "localhost;127.*;<local>"
};

export function buildPipelineInput(state: PipelineFormState): PipelineRunInput {
  const profileId = state.profileId.trim();
  const subscriptionUrl = state.subscriptionUrl.trim();
  const mihomoBinaryPath = state.mihomoBinaryPath.trim();
  const mihomoDataDir = state.mihomoDataDir.trim();
  const controllerBaseUrl = state.controllerBaseUrl.trim();
  const controllerSecret = state.controllerSecret.trim();

  if (!profileId) {
    throw new Error("Profile id is required");
  }
  if (!mihomoBinaryPath) {
    throw new Error("Mihomo binary path is required");
  }
  if (!mihomoDataDir) {
    throw new Error("Mihomo data directory is required");
  }
  if (!controllerBaseUrl) {
    throw new Error("Controller URL is required");
  }
  if (!controllerSecret) {
    throw new Error("Controller secret is required");
  }

  return {
    profileId,
    subscription: {
      url: subscriptionUrl || "https://example.invalid/mioproxy-cache-only.yaml",
      retries: 3,
      timeoutMs: 30_000
    },
    checker: {
      binaryPath: mihomoBinaryPath,
      dataDir: mihomoDataDir,
      timeoutMs: 10_000
    },
    controller: {
      baseUrl: controllerBaseUrl,
      secret: controllerSecret,
      timeoutMs: 10_000
    }
  };
}

export function buildCoreStartInput(state: PipelineFormState): CoreProcessStartInput {
  const profileId = state.profileId.trim();
  const mihomoBinaryPath = state.mihomoBinaryPath.trim();
  const mihomoDataDir = state.mihomoDataDir.trim();

  if (!profileId) {
    throw new Error("Profile id is required");
  }
  if (!mihomoBinaryPath) {
    throw new Error("Mihomo binary path is required");
  }
  if (!mihomoDataDir) {
    throw new Error("Mihomo data directory is required");
  }

  return {
    profileId,
    binaryPath: mihomoBinaryPath,
    dataDir: mihomoDataDir
  };
}

export function buildControllerLogStartInput(state: PipelineFormState): ControllerLogStartInput {
  const profileId = state.profileId.trim();
  const controllerBaseUrl = state.controllerBaseUrl.trim();
  const controllerSecret = state.controllerSecret.trim();

  if (!profileId) {
    throw new Error("Profile id is required");
  }
  if (!controllerBaseUrl) {
    throw new Error("Controller URL is required");
  }
  if (!controllerSecret) {
    throw new Error("Controller secret is required");
  }

  return {
    profileId,
    baseUrl: controllerBaseUrl,
    secret: controllerSecret,
    level: "info"
  };
}

export function buildControllerHealthInput(state: PipelineFormState): ControllerHealthCheckInput {
  const controllerBaseUrl = state.controllerBaseUrl.trim();
  const controllerSecret = state.controllerSecret.trim();

  if (!controllerBaseUrl) {
    throw new Error("Controller URL is required");
  }
  if (!controllerSecret) {
    throw new Error("Controller secret is required");
  }

  return {
    baseUrl: controllerBaseUrl,
    secret: controllerSecret,
    timeoutMs: 5_000
  };
}

export function buildSystemProxyEnableInput(state: PipelineFormState): SystemProxyEnableInput {
  const host = state.systemProxyHost.trim();
  const port = Number.parseInt(state.systemProxyPort.trim(), 10);
  const bypass = state.systemProxyBypass.trim();

  if (!host) {
    throw new Error("System proxy host is required");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("System proxy port must be between 1 and 65535");
  }

  return {
    host,
    port,
    bypass: bypass || undefined
  };
}

export function buildActivationStartInput(state: PipelineFormState): ActivationStartInput {
  const profileId = state.profileId.trim();
  const mihomoBinaryPath = state.mihomoBinaryPath.trim();
  const mihomoDataDir = state.mihomoDataDir.trim();
  const controllerBaseUrl = state.controllerBaseUrl.trim();
  const controllerSecret = state.controllerSecret.trim();

  if (!profileId) {
    throw new Error("Profile id is required");
  }
  if (!mihomoBinaryPath) {
    throw new Error("Mihomo binary path is required");
  }
  if (!mihomoDataDir) {
    throw new Error("Mihomo data directory is required");
  }
  if (!controllerBaseUrl) {
    throw new Error("Controller URL is required");
  }
  if (!controllerSecret) {
    throw new Error("Controller secret is required");
  }

  return {
    profileId,
    binaryPath: mihomoBinaryPath,
    dataDir: mihomoDataDir,
    controller: {
      baseUrl: controllerBaseUrl,
      secret: controllerSecret,
      timeoutMs: 5_000
    },
    systemProxy: buildSystemProxyEnableInput(state),
    startControllerLogs: true,
    enableSystemProxy: true,
    health: {
      attempts: 5,
      delayMs: 500
    }
  };
}

export function buildProfileSettings(state: PipelineFormState): ProfileSettings {
  const profileId = state.profileId.trim();
  if (!profileId) {
    throw new Error("Profile id is required");
  }

  return {
    profileId,
    subscriptionUrl: state.subscriptionUrl.trim(),
    mihomoBinaryPath: state.mihomoBinaryPath.trim(),
    mihomoDataDir: state.mihomoDataDir.trim(),
    controllerBaseUrl: state.controllerBaseUrl.trim(),
    systemProxyHost: state.systemProxyHost.trim(),
    systemProxyPort: state.systemProxyPort.trim(),
    systemProxyBypass: state.systemProxyBypass.trim(),
    updatedAt: new Date(0).toISOString()
  };
}

export function applyProfileSettings(
  current: PipelineFormState,
  settings: ProfileSettings
): PipelineFormState {
  return {
    ...current,
    profileId: settings.profileId,
    subscriptionUrl: settings.subscriptionUrl,
    mihomoBinaryPath: settings.mihomoBinaryPath,
    mihomoDataDir: settings.mihomoDataDir,
    controllerBaseUrl: settings.controllerBaseUrl,
    clashPartySourceDir: current.clashPartySourceDir,
    systemProxyHost: settings.systemProxyHost,
    systemProxyPort: settings.systemProxyPort,
    systemProxyBypass: settings.systemProxyBypass
  };
}
