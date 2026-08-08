import { invoke } from "@tauri-apps/api/core";

export type CoreStatus = {
  running: boolean;
  controller: string;
  configPath: string;
  mixedPort: number;
  mode: string;
};

export type CoreState = "stopped" | "starting" | "running" | "reloading" | "stopping" | "error";
export type ProxyState = "disabled" | "enabling" | "enabled" | "disabling" | "error";

export type SystemProxyStatus = {
  enabled: boolean;
  coreRunning: boolean;
  mixedPort: number;
  proxyServer: string | null;
};

export type StartupSettings = {
  enabled: boolean;
  startMinimized: boolean;
};

export type MihomoVersion = {
  meta?: boolean;
  version?: string;
};

export type ProxyGroup = {
  type?: string;
  now?: string;
  all?: string[];
  history?: Array<{ time: string; delay: number }>;
};

export type ProxiesResponse = {
  proxies: Record<string, ProxyGroup>;
};

export type DelayResponse = {
  delay: number;
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

export const mihomoApi = {
  start: () => invoke<CoreStatus>("mihomo_start"),
  stop: () => invoke<CoreStatus>("mihomo_stop"),
  status: () => invoke<CoreStatus>("mihomo_status"),
  version: () => invoke<MihomoVersion>("mihomo_version"),
  proxies: () => invoke<ProxiesResponse>("mihomo_proxies"),
  reload: () => invoke<unknown>("mihomo_reload"),
  selectProxy: (group: string, proxy: string) => invoke<unknown>("mihomo_select_proxy", { group, proxy }),
  proxyDelay: (proxy: string, url?: string) => invoke<DelayResponse>("mihomo_proxy_delay", { proxy, url }),
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
};
