import { invoke } from "@tauri-apps/api/core";

export type CoreStatus = {
  running: boolean;
  controller: string;
  configPath: string;
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

export type Profile = {
  id: string;
  name: string;
  url: string;
  filePath: string | null;
  updatedAt: number | null;
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
  profileList: () => invoke<Profile[]>("profile_list"),
  profileAdd: (name: string, url: string) => invoke<Profile>("profile_add", { name, url }),
  profileDownload: (id: string) => invoke<Profile>("profile_download", { id }),
  profileApply: (id: string) => invoke<string>("profile_apply", { id }),
  profileRemove: (id: string) => invoke<void>("profile_remove", { id }),
};
