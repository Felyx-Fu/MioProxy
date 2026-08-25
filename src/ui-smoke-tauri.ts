import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { UiSmokeFixture } from "./ui-smoke-fixtures";

export type UiSmokeAudit = {
  reads: string[];
  fixtureCommands: string[];
  unsupportedCommands: string[];
};

const READ_COMMANDS = new Set([
  "mihomo_status",
  "mihomo_version",
  "mihomo_proxies",
  "mihomo_connections",
  "system_proxy_status",
  "startup_status",
  "profile_list",
  "tun_status",
  "service_status_command",
  "update_status",
  "update_preferences_status",
  "mihomo_core_update_status",
  "mihomo_rules",
  "mihomo_rule_providers",
  "dns_get",
  "override_get",
  "config_preview",
]);

function commandArgs(args?: InvokeArgs) {
  return args as Record<string, unknown> | undefined;
}

function profileIdFrom(args?: InvokeArgs) {
  return String(commandArgs(args)?.id ?? "");
}

function syncAudit(audit: UiSmokeAudit) {
  document.documentElement.dataset.smokeReadCommands = String(audit.reads.length);
  document.documentElement.dataset.smokeFixtureCommands = String(audit.fixtureCommands.length);
  document.documentElement.dataset.smokeUnsupportedCommands = String(audit.unsupportedCommands.length);
  document.documentElement.dataset.smokeMutationAttempts = String(audit.fixtureCommands.length);
}

function fixtureMutation(command: string, args: InvokeArgs | undefined, fixture: UiSmokeFixture) {
  switch (command) {
    case "mihomo_start":
    case "mihomo_stop":
    case "mihomo_set_mode":
      return fixture.status;
    case "mihomo_reload":
    case "mihomo_select_proxy":
    case "mihomo_close_connection":
    case "mihomo_close_all_connections":
    case "profile_remove":
    case "mihomo_rule_provider_update":
    case "plugin:process|restart":
      return null;
    case "mihomo_proxy_delay": {
      const request = commandArgs(args)?.request as { proxy?: unknown } | undefined;
      const proxy = String(request?.proxy ?? "");
      const delay = fixture.proxyDelays[proxy];
      if (delay === null || delay === undefined) throw new Error(`Fixture latency unavailable for ${proxy}`);
      return { delay };
    }
    case "system_proxy_set_enabled":
      return fixture.systemProxy;
    case "startup_set":
      return fixture.startup;
    case "profile_add":
      return fixture.profiles[0];
    case "profile_download":
      return fixture.profiles.find((profile) => profile.id === profileIdFrom(args)) ?? fixture.profiles[0];
    case "profile_apply":
      return profileIdFrom(args);
    case "override_set":
      return fixture.override;
    case "config_apply":
      return fixture.configApply;
    case "dns_set":
      return fixture.override;
    case "tun_set_enabled":
      return fixture.tun;
    case "update_preferences_set":
      return fixture.updatePreferences;
    case "update_check":
      return null;
    case "update_prepare":
    case "update_mark_failed":
      return fixture.updateStatus;
    case "mihomo_core_update_check":
    case "mihomo_core_update_install":
      return fixture.coreUpdate;
    case "diagnostic_bundle_generate":
      return fixture.initialState.diagnosticPath ?? "C:\\MioProxy\\diagnostics\\mioproxy-smoke.zip";
    case "plugin:updater|download":
      return 0;
    case "plugin:updater|install":
      return null;
    default:
      throw new Error(`UI smoke has no safe fixture command for ${command}`);
  }
}

export function installUiSmokeTauriMock(fixture: UiSmokeFixture, audit: UiSmokeAudit) {
  // These are the two pieces of the Tauri mock contract needed by the real app:
  // invoke responses and event callback registration/dispatch. No native API is
  // reached, and the application code still imports the production Tauri APIs.
  mockWindows("main");
  mockIPC((command: string, args?: InvokeArgs) => {
    if (command === "mihomo_proxy_delay") {
      audit.reads.push(command);
      syncAudit(audit);
      return fixtureMutation(command, args, fixture);
    }

    if (READ_COMMANDS.has(command)) {
      audit.reads.push(command);
      syncAudit(audit);
      switch (command) {
        case "mihomo_status": return fixture.status;
        case "mihomo_version": return fixture.version;
        case "mihomo_proxies": return fixture.proxies;
        case "mihomo_connections": return fixture.connections;
        case "system_proxy_status": return fixture.systemProxy;
        case "startup_status": return fixture.startup;
        case "profile_list": return fixture.profiles;
        case "tun_status": return fixture.tun;
        case "service_status_command": return fixture.service;
        case "update_status": return fixture.updateStatus;
        case "update_preferences_status": return fixture.updatePreferences;
        case "mihomo_core_update_status": return fixture.coreUpdate;
        case "mihomo_rules": return fixture.rules;
        case "mihomo_rule_providers": return fixture.ruleProviders;
        case "dns_get": return fixture.dns;
        case "override_get": return fixture.override;
        case "config_preview": return fixture.preview;
      }
    }

    audit.fixtureCommands.push(command);
    syncAudit(audit);
    try {
      return fixtureMutation(command, args, fixture);
    } catch (error) {
      audit.unsupportedCommands.push(command);
      syncAudit(audit);
      throw error;
    }
  }, { shouldMockEvents: true });
  const internals = window.__TAURI_INTERNALS__ as { invoke?: unknown; transformCallback?: unknown } | undefined;
  const eventInternals = window.__TAURI_EVENT_PLUGIN_INTERNALS__ as { unregisterListener?: unknown } | undefined;
  if (typeof internals?.invoke !== "function" || typeof internals.transformCallback !== "function" || typeof eventInternals?.unregisterListener !== "function") {
    throw new Error("UI smoke Tauri mock did not install invoke and event callback contracts");
  }
  syncAudit(audit);
}

export function emitUiSmokeEvents(fixture: UiSmokeFixture, delayMs = 80) {
  window.setTimeout(() => {
    void (async () => {
      await emit("mihomo-traffic", fixture.traffic);
      for (const entry of fixture.logs) await emit("mihomo-log-entry", entry);
    })();
  }, delayMs);
}
