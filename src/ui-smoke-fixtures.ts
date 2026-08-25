import type {
  ConfigApplyResult,
  ConfigPreview,
  ConnectionsResponse,
  CoreStatus,
  CoreUpdateStatus,
  DnsSettings,
  MihomoVersion,
  Profile,
  ProxyGroup,
  ProxyMemberContext,
  ProxiesResponse,
  RuleProvidersResponse,
  RulesResponse,
  ServiceConnectionStatus,
  StartupSettings,
  SystemProxyStatus,
  TrafficSnapshot,
  TunStatusSnapshot,
  UpdatePreferences,
  UpdateStatus,
} from "./api/mihomo";
import type { AppInitialState } from "./App";
import type { LogEntry } from "./stores/logStore";

const FIXTURE_EPOCH_MS = Date.parse("2025-05-12T12:00:00.000Z");
const FIXTURE_UPDATED_AT = Math.floor(FIXTURE_EPOCH_MS / 1000);

const nodeNames = [
  "HK-1",
  "SG-1",
  "JP Premium",
  "US-01",
  "US-01 · Enterprise Route With A Deliberately Long Display Name",
  "DE-01",
  "AU-01",
  "Unavailable Node",
];

const memberContexts: Record<string, ProxyMemberContext> = Object.fromEntries(
  nodeNames.map((name) => [name, { kind: "provider", provider: "main-subscription", providerResolution: "resolved" }]),
) as Record<string, ProxyMemberContext>;

const nodeEntries: Record<string, ProxyGroup> = Object.fromEntries(
  nodeNames.map((name, index) => [name, {
    type: index % 2 === 0 ? "Vmess" : "Trojan",
    history: [],
    "provider-name": "main-subscription",
  }]),
);

const profiles: Profile[] = [
  {
    id: "profile-a",
    name: "Everyday Routes",
    url: "https://subscriptions.invalid/everyday-routes",
    filePath: "C:\\MioProxy\\profiles\\everyday-routes.yaml",
    updatedAt: FIXTURE_UPDATED_AT,
    nodeCount: 28,
  },
  {
    id: "profile-b",
    name: "Streaming Lab",
    url: "https://subscriptions.invalid/streaming-lab",
    filePath: "C:\\MioProxy\\profiles\\streaming-lab.yaml",
    updatedAt: FIXTURE_UPDATED_AT - 86400 * 3,
    nodeCount: 12,
  },
  {
    id: "profile-c",
    name: "Office · Hong Kong + Singapore Premium Nodes — Long Name",
    url: "https://subscriptions.invalid/office-premium",
    filePath: null,
    updatedAt: null,
    nodeCount: null,
  },
];

const proxies: ProxiesResponse = {
  groupOrder: ["PROXY", "GLOBAL", "Streaming", "Failover"],
  proxies: {
    PROXY: {
      type: "Selector",
      now: "US-01",
      all: nodeNames,
      memberContexts,
      testUrl: "https://www.gstatic.com/generate_204",
      expectedStatus: "204",
    },
    GLOBAL: {
      type: "Selector",
      now: "PROXY",
      all: ["PROXY", "DIRECT", "HK-1", "SG-1"],
      memberContexts: {
        PROXY: { kind: "group" },
        DIRECT: { kind: "builtin" },
        "HK-1": memberContexts["HK-1"],
        "SG-1": memberContexts["SG-1"],
      },
    },
    Streaming: {
      type: "URLTest",
      now: "SG-1",
      all: ["JP Premium", "SG-1", "HK-1", "US-01"],
      memberContexts: {
        "JP Premium": memberContexts["JP Premium"],
        "SG-1": memberContexts["SG-1"],
        "HK-1": memberContexts["HK-1"],
        "US-01": memberContexts["US-01"],
      },
      testUrl: "https://www.cloudflare.com/cdn-cgi/trace",
    },
    Failover: {
      type: "Fallback",
      now: "DE-01",
      all: ["DE-01", "AU-01", "Unavailable Node"],
      memberContexts: {
        "DE-01": memberContexts["DE-01"],
        "AU-01": memberContexts["AU-01"],
        "Unavailable Node": memberContexts["Unavailable Node"],
      },
      testUrl: "https://www.microsoft.com/generate_204",
    },
    ...nodeEntries,
  },
};

const hosts = [
  "api.github.com",
  "cdn.cloudflare.net",
  "updates.microsoft.com",
  "time.windows.com",
  "client4.google.com",
  "registry.npmjs.org",
  "packages.microsoft.com",
  "fonts.gstatic.com",
];
const processes = ["chrome.exe", "Code.exe", "msedge.exe", "svchost.exe"];

const connections: ConnectionsResponse = {
  downloadTotal: 278_921_114,
  uploadTotal: 43_188_120,
  memory: 118_489_088,
  connections: hosts.map((host, index) => ({
    id: `fixture-connection-${index + 1}`,
    metadata: {
      network: index % 4 === 0 ? "UDP" : "TCP",
      host,
      destinationIp: `142.250.${index + 10}.10`,
      destinationPort: index % 4 === 0 ? "53" : "443",
      sourceIp: "127.0.0.1",
      sourcePort: `${52000 + index}`,
      process: processes[index % processes.length],
      processPath: `C:\\Program Files\\${processes[index % processes.length]}`,
    },
    upload: 1_200 * (index + 1),
    download: 7_300 * (index + 3),
    start: new Date(FIXTURE_EPOCH_MS - index * 73_000).toISOString(),
    chains: index % 4 === 0 ? [] : [nodeNames[index % nodeNames.length]],
    rule: index % 4 === 0 ? "MATCH" : index % 3 === 0 ? "DOMAIN-SUFFIX" : "DOMAIN",
    rulePayload: host,
  })),
};

const traffic: TrafficSnapshot = {
  timestamp: FIXTURE_EPOCH_MS,
  up: 1_650_000,
  down: 8_420_000,
  todayUp: 183_500_000,
  todayDown: 1_928_000_000,
  history: Array.from({ length: 30 }, (_, index) => ({
    timestamp: FIXTURE_EPOCH_MS - (29 - index) * 2_000,
    up: 900_000 + (index % 6) * 120_000,
    down: 4_000_000 + ((index * 7) % 11) * 420_000,
  })),
};

const rules: RulesResponse = {
  rules: [
    { type: "DOMAIN-SUFFIX", payload: "github.com", proxy: "PROXY" },
    { type: "DOMAIN-SUFFIX", payload: "microsoft.com", proxy: "PROXY" },
    { type: "IP-CIDR", payload: "10.0.0.0/8", proxy: "DIRECT" },
    { type: "GEOIP", payload: "CN", proxy: "DIRECT" },
    { type: "PROCESS-NAME", payload: "svchost.exe", proxy: "DIRECT" },
    { type: "RULE-SET", payload: "geosite-cn", proxy: "DIRECT", subRules: ["geosite-cn", "fallback"] },
    { type: "MATCH", payload: "", proxy: "PROXY" },
  ],
};

const ruleProviders: RuleProvidersResponse = {
  providers: {
    "geosite-cn": { behavior: "domain", format: "mrs", size: 1_842_176, updatedAt: String(FIXTURE_UPDATED_AT) },
    "geoip-private": { behavior: "ipcidr", format: "yaml", size: 428_912, updatedAt: String(FIXTURE_UPDATED_AT - 86400) },
  },
};

const systemProxy: SystemProxyStatus = {
  enabled: false,
  coreRunning: true,
  mixedPort: 7890,
  proxyServer: null,
  managed: true,
  desiredEnabled: false,
  actualState: "disabled",
  owner: "none",
  externalDetected: false,
  windowsState: "disabled",
  stateConsistent: true,
};

const tun: TunStatusSnapshot = {
  status: "running",
  message: "An external TUN controller owns the interface.",
  admin: true,
  profileId: "profile-a",
  snapshot: {
    defaultRoute: "192.168.1.1",
    dnsServers: ["192.168.1.1", "1.1.1.1"],
    adapters: ["Wi-Fi", "MioProxy TUN (external)"],
    mihomoRunning: true,
    capturedAt: FIXTURE_EPOCH_MS,
  },
  desiredEnabled: false,
  actualState: "externalTun",
  owner: "external",
  externalDetected: true,
  projection: "external",
};

const logs: LogEntry[] = ([
  ["INFO", "Controller connection established"],
  ["INFO", "Runtime profile validated: Everyday Routes"],
  ["WARN", "External TUN ownership detected"],
  ["INFO", "Selected node: US-01 (46 ms)"],
  ["INFO", "DNS query: api.github.com"],
  ["INFO", "Matched rule: DOMAIN-SUFFIX,github.com → PROXY"],
  ["WARN", "High latency observed for AU-01: 228 ms"],
  ["ERROR", "Failed to connect to Unavailable Node"],
  ["INFO", "Application update check completed"],
] as Array<[LogEntry["level"], string]>).map(([level, message], index) => ({ timestamp: FIXTURE_EPOCH_MS + index * 1_000, level, message }));

export type UiSmokeFixture = {
  id: string;
  initialState: AppInitialState;
  profiles: Profile[];
  status: CoreStatus;
  version: MihomoVersion;
  proxies: ProxiesResponse;
  proxyDelays: Record<string, number | null>;
  connections: ConnectionsResponse;
  traffic: TrafficSnapshot;
  systemProxy: SystemProxyStatus;
  startup: StartupSettings;
  tun: TunStatusSnapshot;
  service: ServiceConnectionStatus;
  updateStatus: UpdateStatus;
  updatePreferences: UpdatePreferences;
  coreUpdate: CoreUpdateStatus;
  rules: RulesResponse;
  ruleProviders: RuleProvidersResponse;
  dns: DnsSettings;
  override: { content: string; path: string; hasContent: boolean; updatedAt: number | null };
  preview: ConfigPreview;
  configApply: ConfigApplyResult;
  logs: LogEntry[];
  proxyPreferences: {
    favorites: string[];
    groupOrder: string[];
    regionOrder: string[];
  };
};

export const uiSmokeFixture: UiSmokeFixture = {
  id: "populated-runtime",
  initialState: {
    selectedProfileId: "profile-b",
    appliedProfileSession: { id: "profile-a", name: "Everyday Routes" },
    diagnosticPath: "C:\\Users\\Public\\Documents\\MioProxy\\diagnostics\\mioproxy-smoke.zip",
  },
  profiles,
  status: {
    state: "ready",
    running: true,
    controller: "127.0.0.1:19090",
    configPath: "C:\\ProgramData\\MioProxy\\runtime\\config.yaml",
    mixedPort: 7890,
    mode: "rule",
    recoveryMessage: null,
  },
  version: { meta: true, version: "1.19.29" },
  proxies,
  proxyDelays: {
    "HK-1": 58,
    "SG-1": 86,
    "JP Premium": 122,
    "US-01": 46,
    "US-01 · Enterprise Route With A Deliberately Long Display Name": 92,
    "DE-01": 168,
    "AU-01": 228,
    "Unavailable Node": null,
  },
  connections,
  traffic,
  systemProxy,
  startup: { enabled: true, startMinimized: true },
  tun,
  service: {
    state: "running",
    reachable: true,
    protocolVersion: 1,
    serviceVersion: "1.0.1",
    versionMismatch: false,
    error: null,
    admin: true,
    ownsCore: true,
    coreRunning: true,
    ownershipConflict: false,
    tunStatus: "running",
    tunMessage: tun.message,
    desiredCoreRunning: true,
    coreRecoveryMessage: null,
    connectivity: "ready",
  },
  updateStatus: { currentVersion: "1.0.1", updating: false, checkpoint: null, recoveryError: null },
  updatePreferences: { checkOnStartup: false, autoDownload: false },
  coreUpdate: { currentVersion: "1.19.29", availableVersion: null, assetName: null, phase: "idle", error: null },
  rules,
  ruleProviders,
  dns: {
    enabled: true,
    enhancedMode: "fake-ip",
    defaultNameserver: ["223.5.5.5", "1.1.1.1"],
    nameserver: ["https://dns.google/dns-query"],
    fallback: ["tls://1.1.1.1"],
    fakeIpFilterMode: "blacklist",
    fakeIpFilter: ["*.lan", "+.local", "localhost"],
  },
  override: {
    content: "rules:\n  - DOMAIN-SUFFIX,example.com,DIRECT\n  - GEOIP,CN,DIRECT",
    path: "C:\\MioProxy\\profiles\\local-override.yaml",
    hasContent: true,
    updatedAt: FIXTURE_UPDATED_AT,
  },
  preview: {
    profileId: "profile-b",
    profileName: "Streaming Lab",
    yaml: "mode: rule\nmixed-port: 7890\nrules:\n  - DOMAIN-SUFFIX,example.com,DIRECT\n  - GEOIP,CN,DIRECT",
    overrideActive: true,
  },
  configApply: {
    profileId: "profile-b",
    profileName: "Streaming Lab",
    path: "C:\\MioProxy\\runtime\\config.yaml",
    controllerValidated: true,
    overrideActive: true,
  },
  logs,
  proxyPreferences: {
    favorites: ["HK-1", "JP Premium"],
    groupOrder: ["PROXY", "GLOBAL", "Streaming", "Failover"],
    regionOrder: ["favorites", "hk", "sg", "jp", "us", "de", "au", "unknown"],
  },
};

export const uiSmokeFixtureEpoch = FIXTURE_EPOCH_MS;
