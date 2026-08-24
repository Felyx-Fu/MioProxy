import { invoke } from "@tauri-apps/api/core";

export type CoreState = "stopped" | "starting" | "ready" | "error";
export type CoreMode = "rule" | "global" | "direct";

export type CoreStatus = {
  state: CoreState;
  running: boolean;
  controller: string;
  configPath: string;
  mixedPort: number;
  mode: CoreMode;
  recoveryMessage?: string | null;
};
export type ProxyState = "disabled" | "enabling" | "enabled" | "disabling" | "error";
export type ProxyPathState = "unknown" | "healthy" | "degraded" | "unavailable";

export type SystemProxyStatus = {
  /** True only when MioProxy currently owns the Windows System Proxy. */
  enabled: boolean;
  coreRunning: boolean;
  mixedPort: number;
  proxyServer: string | null;
  managed: boolean;
  desiredEnabled: boolean;
  actualState: "disabled" | "mioproxyEndpoint" | "externalEndpoint";
  owner: "mioproxy" | "external" | "none";
  externalDetected: boolean;
  windowsState: "disabled" | "mioproxy" | "external";
  stateConsistent: boolean;
};

export type StartupSettings = {
  enabled: boolean;
  startMinimized: boolean;
};

export type UpdatePreferences = {
  checkOnStartup: boolean;
  autoDownload: boolean;
};

export type MihomoVersion = {
  meta?: boolean;
  version?: string;
};

export type ProxyEntryKind = "ordinary" | "provider" | "group" | "builtin";

export type ProviderResolution = "resolved" | "ambiguous" | "unresolved";

export type ProxyMemberContext = {
  kind: ProxyEntryKind;
  provider?: string;
  providerCandidates?: string[];
  providerResolution?: ProviderResolution;
};

export type ProxyGroup = {
  type?: string;
  now?: string;
  all?: string[];
  testUrl?: string;
  expectedStatus?: string;
  /** Backend-enriched, group-scoped provider/source identity. */
  memberContexts?: Record<string, ProxyMemberContext>;
  /** Mihomo exposes provider identity on provider-backed proxy entries. */
  "provider-name"?: string;
  /** Allows normalized fixtures/compatibility adapters to preserve the same identity. */
  providerName?: string;
  history?: Array<{ time: string; delay: number }>;
};

export type ProxiesResponse = {
  proxies: Record<string, ProxyGroup>;
  /** Explicit strategy-group order from the authoritative runtime config plus runtime-only groups. */
  groupOrder?: string[];
};

export type MihomoRule = {
  type?: string;
  payload?: string;
  proxy?: string;
  subRules?: string[];
  [key: string]: unknown;
};

export type RulesResponse = {
  rules?: MihomoRule[];
  [key: string]: unknown;
};

export type RuleProvider = {
  behavior?: string;
  format?: string;
  type?: string;
  path?: string;
  url?: string;
  size?: number;
  updatedAt?: string;
  updateAt?: string;
  vehicleType?: string;
  [key: string]: unknown;
};

export type RuleProvidersResponse = Record<string, RuleProvider> | { providers?: Record<string, RuleProvider> };

export type DelayResponse = {
  delay: number;
};

export type ProxyDelayContext = {
  group: string;
  proxy: string;
  provider?: string;
  testUrl?: string;
  expectedStatus?: string;
  kind: ProxyEntryKind;
};

export type TrafficPoint = {
  timestamp: number;
  up: number;
  down: number;
};

export type TrafficSnapshot = {
  timestamp: number;
  up: number;
  down: number;
  todayUp: number;
  todayDown: number;
  history: TrafficPoint[];
};

export type ConnectionMetadata = {
  network: string;
  host: string;
  destinationIp: string;
  destinationPort: string;
  sourceIp: string;
  sourcePort: string;
  process: string;
  processPath: string;
  [key: string]: unknown;
};

export type MihomoConnection = {
  id: string;
  metadata: ConnectionMetadata;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  [key: string]: unknown;
};

export type ConnectionsResponse = {
  downloadTotal: number;
  uploadTotal: number;
  connections: MihomoConnection[];
  memory?: number;
};

export type Profile = {
  id: string;
  name: string;
  url: string;
  filePath: string | null;
  updatedAt: number | null;
  nodeCount: number | null;
};

export type OverrideSnapshot = {
  content: string;
  path: string;
  hasContent: boolean;
  updatedAt: number | null;
};

export type ConfigPreview = {
  profileId: string;
  profileName: string;
  yaml: string;
  overrideActive: boolean;
};

export type ConfigApplyResult = {
  profileId: string;
  profileName: string;
  path: string;
  controllerValidated: boolean;
  overrideActive: boolean;
};

export type DnsSettings = {
  enabled: boolean;
  enhancedMode: string;
  defaultNameserver: string[];
  nameserver: string[];
  fallback: string[];
  fakeIpFilterMode: string;
  fakeIpFilter: string[];
};

export type TunStatus = "disabled" | "starting" | "running" | "stopping" | "error";
export type TunProjectionState = "waitingForService" | "enabling" | "on" | "disabling" | "recovering" | "external" | "error" | "off";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type NetworkSnapshot = {
  defaultRoute: JsonValue;
  dnsServers: JsonValue;
  adapters: JsonValue;
  mihomoRunning: boolean;
  capturedAt: number;
};

export type TunStatusSnapshot = {
  status: TunStatus;
  message: string | null;
  admin: boolean;
  profileId: string | null;
  snapshot: NetworkSnapshot | null;
  desiredEnabled: boolean;
  actualState: "disabled" | "mioproxyTun" | "externalTun" | "unknown";
  owner: "mioproxy" | "external" | "none" | "unknown";
  externalDetected: boolean;
  projection: TunProjectionState;
};

export type ServiceConnectivity = "notInstalled" | "serviceStopped" | "scmStarting" | "pipeNotReady" | "transient" | "ambiguous" | "ready" | "protocolFailure" | "authenticationFailure" | "commandFailure";

export type ServiceConnectionStatus = {
  state: "running" | "stopped" | "starting" | "reconnecting" | "error";
  reachable: boolean;
  protocolVersion: number;
  serviceVersion: string | null;
  versionMismatch: boolean;
  error: string | null;
  admin: boolean;
  ownsCore: boolean;
  coreRunning: boolean;
  ownershipConflict: boolean;
  tunStatus: TunStatus | null;
  tunMessage: string | null;
  desiredCoreRunning: boolean;
  coreRecoveryMessage: string | null;
  connectivity: ServiceConnectivity;
};

export type UpdatePhase = "preparing" | "installing" | "restarting" | "completed" | "failed";

export type UpdateCheckpoint = {
  previousVersion: string;
  targetVersion: string;
  systemProxyWasEnabled: boolean;
  tunWasEnabled: boolean;
  updateStartedAt: string;
  phase: UpdatePhase;
};

export type UpdateStatus = {
  currentVersion: string;
  updating: boolean;
  checkpoint: UpdateCheckpoint | null;
  recoveryError: string | null;
};

export type UpdateMetadata = {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
};

export type CoreUpdatePhase = "idle" | "checking" | "available" | "downloading" | "verifying" | "staging" | "installing" | "restarting" | "completed" | "error";

export type CoreUpdateStatus = {
  currentVersion: string | null;
  availableVersion: string | null;
  assetName: string | null;
  phase: CoreUpdatePhase;
  error: string | null;
};
export const mihomoApi = {
  start: () => invoke<CoreStatus>("mihomo_start"),
  stop: () => invoke<CoreStatus>("mihomo_stop"),
  status: () => invoke<CoreStatus>("mihomo_status"),
  setMode: (mode: CoreMode) => invoke<CoreStatus>("mihomo_set_mode", { mode }),
  version: () => invoke<MihomoVersion>("mihomo_version"),
  proxies: () => invoke<ProxiesResponse>("mihomo_proxies"),
  rules: () => invoke<RulesResponse>("mihomo_rules"),
  ruleProviders: () => invoke<RuleProvidersResponse>("mihomo_rule_providers"),
  ruleProviderUpdate: (name: string) => invoke<unknown>("mihomo_rule_provider_update", { name }),
  reload: () => invoke<unknown>("mihomo_reload"),
  selectProxy: (group: string, proxy: string) => invoke<unknown>("mihomo_select_proxy", { group, proxy }),
  proxyDelay: (request: ProxyDelayContext) => invoke<DelayResponse>("mihomo_proxy_delay", { request }),
  connections: () => invoke<ConnectionsResponse>("mihomo_connections"),
  closeConnection: (id: string) => invoke<void>("mihomo_close_connection", { id }),
  closeAllConnections: () => invoke<void>("mihomo_close_all_connections"),
  systemProxyStatus: () => invoke<SystemProxyStatus>("system_proxy_status"),
  systemProxySetEnabled: (enabled: boolean) => invoke<SystemProxyStatus>("system_proxy_set_enabled", { enabled }),
  startupStatus: () => invoke<StartupSettings>("startup_status"),
  startupSet: (enabled: boolean, startMinimized: boolean) => invoke<StartupSettings>("startup_set", { enabled, startMinimized }),
  profileList: () => invoke<Profile[]>("profile_list"),
  profileAdd: (name: string, url: string) => invoke<Profile>("profile_add", { name, url }),
  profileDownload: (id: string) => invoke<Profile>("profile_download", { id }),
  profileApply: (id: string) => invoke<string>("profile_apply", { id }),
  profileRemove: (id: string) => invoke<void>("profile_remove", { id }),
  overrideGet: () => invoke<OverrideSnapshot>("override_get"),
  overrideSet: (content: string) => invoke<OverrideSnapshot>("override_set", { content }),
  configPreview: (profileId: string) => invoke<ConfigPreview>("config_preview", { profileId }),
  configApply: (profileId: string) => invoke<ConfigApplyResult>("config_apply", { profileId }),
  dnsGet: (profileId: string) => invoke<DnsSettings>("dns_get", { profileId }),
  dnsSet: (settings: DnsSettings) => invoke<OverrideSnapshot>("dns_set", { settings }),
  tunStatus: () => invoke<TunStatusSnapshot>("tun_status"),
  tunSetEnabled: (enabled: boolean, profileId?: string | null) => invoke<TunStatusSnapshot>("tun_set_enabled", { enabled, profileId }),
  serviceStatus: () => invoke<ServiceConnectionStatus>("service_status_command"),
  updateStatus: () => invoke<UpdateStatus>("update_status"),
  updateCheck: () => invoke<UpdateMetadata | null>("update_check"),
  updatePrepare: (targetVersion: string) => invoke<UpdateStatus>("update_prepare", { targetVersion }),
  updateMarkFailed: (error: string) => invoke<UpdateStatus>("update_mark_failed", { error }),
  updatePreferencesStatus: () => invoke<UpdatePreferences>("update_preferences_status"),
  updatePreferencesSet: (checkOnStartup: boolean, autoDownload: boolean) => invoke<UpdatePreferences>("update_preferences_set", { checkOnStartup, autoDownload }),
  coreUpdateStatus: () => invoke<CoreUpdateStatus>("mihomo_core_update_status"),
  coreUpdateCheck: () => invoke<CoreUpdateStatus>("mihomo_core_update_check"),
  coreUpdateInstall: () => invoke<CoreUpdateStatus>("mihomo_core_update_install"),
  diagnosticBundleGenerate: () => invoke<string>("diagnostic_bundle_generate"),
};
