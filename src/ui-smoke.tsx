import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { ConnectionsResponse, Profile, ProxiesResponse, TrafficSnapshot } from "./api/mihomo";
import "./styles.css";

declare global {
  interface Window {
    __MIOPROXY_SMOKE__?: { reads: string[]; mutationAttempts: string[] };
  }
}

window.__MIOPROXY_VISUAL_PREVIEW__ = true;
const audit = { reads: [] as string[], mutationAttempts: [] as string[] };
window.__MIOPROXY_SMOKE__ = audit;
document.documentElement.dataset.smokeMutationAttempts = "0";

const profiles: Profile[] = [
  { id: "global", name: "Global", url: "https://subscription.example/global?token=hidden", filePath: "C:\\MioProxy\\global.yaml", updatedAt: 1747041022, nodeCount: 24 },
  { id: "streaming", name: "Streaming", url: "https://subscription.example/streaming", filePath: "C:\\MioProxy\\streaming.yaml", updatedAt: 1747037122, nodeCount: 5 },
  { id: "work", name: "Work", url: "https://subscription.example/work", filePath: "C:\\MioProxy\\work.yaml", updatedAt: 1746954622, nodeCount: 8 },
  { id: "gaming", name: "Gaming", url: "https://subscription.example/gaming", filePath: "C:\\MioProxy\\gaming.yaml", updatedAt: 1746871822, nodeCount: 6 },
  { id: "direct", name: "Direct", url: "https://subscription.example/direct", filePath: "C:\\MioProxy\\direct.yaml", updatedAt: 1746785422, nodeCount: 1 },
  { id: "backup", name: "Backup", url: "https://subscription.example/backup", filePath: null, updatedAt: null, nodeCount: null },
];

const proxyNodes = ["US-01", "US-02", "US-03", "DE-01", "DE-02", "JP-01", "SG-01", "HK-01", "UK-01", "AU-01", "CA-01", "FR-01"];
const delayByNode: Record<string, number> = { "US-01": 45, "US-02": 62, "US-03": 78, "DE-01": 112, "DE-02": 138, "JP-01": 166, "SG-01": 184, "HK-01": 198, "UK-01": 141, "AU-01": 227, "CA-01": 87, "FR-01": 126 };
const proxies: ProxiesResponse = {
  proxies: {
    PROXY: { type: "Selector", now: "US-01", all: proxyNodes },
    Default: { type: "Selector", now: "US-01", all: proxyNodes.slice(0, 8) },
    "US Nodes": { type: "URLTest", now: "US-01", all: proxyNodes.filter((node) => node.startsWith("US") || node.startsWith("CA")) },
    "EU Nodes": { type: "Fallback", now: "DE-01", all: ["DE-01", "DE-02", "UK-01", "FR-01"] },
    Streaming: { type: "Selector", now: "SG-01", all: ["US-01", "JP-01", "SG-01", "HK-01"] },
    Backup: { type: "LoadBalance", now: "CA-01", all: ["CA-01", "DE-01", "SG-01"] },
    ...Object.fromEntries(proxyNodes.map((node, index) => [node, { type: index % 3 === 0 ? "Trojan" : "Vmess", history: [] }])),
  },
};

const hosts = ["www.google.com", "api.github.com", "cdn.cloudflare.net", "updates.microsoft.com", "time.windows.com", "client4.google.com", "github.com", "package.microsoft.com", "telemetry.microsoft.com", "www.bing.com", "fonts.gstatic.com", "registry.npmjs.org"];
const processes = ["chrome.exe", "Code.exe", "msedge.exe", "svchost.exe"];
const connections: ConnectionsResponse = {
  downloadTotal: 278_921_114,
  uploadTotal: 43_188_120,
  memory: 118_489_088,
  connections: hosts.map((host, index) => ({
    id: `fixture-${index}`,
    metadata: {
      network: index % 4 === 0 ? "UDP" : "TCP",
      host,
      destinationIp: `142.250.${index}.10`,
      destinationPort: index % 4 === 0 ? "53" : "443",
      sourceIp: "127.0.0.1",
      sourcePort: `${52000 + index}`,
      process: processes[index % processes.length],
      processPath: `C:\\Program Files\\${processes[index % processes.length]}`,
    },
    upload: 1_200 * (index + 1),
    download: 7_300 * (index + 3),
    start: new Date(Date.now() - index * 73000).toISOString(),
    chains: index % 4 === 0 ? [] : [proxyNodes[index % proxyNodes.length]],
    rule: index % 4 === 0 ? "MATCH" : index % 3 === 0 ? "DOMAIN-SUFFIX" : "DOMAIN",
    rulePayload: host,
  })),
};

const readCommands = new Set([
  "mihomo_status", "mihomo_version", "mihomo_proxies", "mihomo_connections", "system_proxy_status", "startup_status",
  "profile_list", "tun_status", "service_status_command", "update_status", "update_preferences_status", "mihomo_core_update_status",
  "mihomo_rules", "mihomo_rule_providers", "dns_get", "override_get", "config_preview",
]);

mockIPC((cmd: string, args?: InvokeArgs) => {
  if (!readCommands.has(cmd) && cmd !== "mihomo_proxy_delay") {
    audit.mutationAttempts.push(cmd);
    document.documentElement.dataset.smokeMutationAttempts = String(audit.mutationAttempts.length);
    throw new Error(`UI smoke blocked non-read command: ${cmd}`);
  }
  audit.reads.push(cmd);
  switch (cmd) {
    case "mihomo_status": return { state: "ready", running: true, controller: "127.0.0.1:19090", configPath: "C:\\ProgramData\\MioProxy\\runtime\\config.yaml", mixedPort: 7890, mode: "rule", recoveryMessage: null };
    case "mihomo_version": return { meta: true, version: "1.19.29" };
    case "mihomo_proxies": return proxies;
    case "mihomo_proxy_delay": return { delay: delayByNode[String((args as Record<string, unknown> | undefined)?.proxy)] ?? 120 };
    case "mihomo_connections": return connections;
    case "system_proxy_status": return { enabled: true, coreRunning: true, mixedPort: 7890, proxyServer: "127.0.0.1:7890", managed: true, desiredEnabled: true, actualState: "mioproxyEndpoint", owner: "mioproxy", externalDetected: false, windowsState: "mioproxy", stateConsistent: true };
    case "startup_status": return { enabled: true, startMinimized: true };
    case "profile_list": return profiles;
    case "tun_status": return { status: "running", message: null, admin: true, profileId: "global", snapshot: null, desiredEnabled: true, actualState: "mioproxyTun", owner: "mioproxy", externalDetected: false };
    case "service_status_command": return { reachable: true, protocolVersion: 1, serviceVersion: "0.9.2", versionMismatch: false, error: null, admin: true, ownsCore: true, coreRunning: true, ownershipConflict: false, tunStatus: "running", tunMessage: null, desiredCoreRunning: true, coreRecoveryMessage: null };
    case "update_status": return { currentVersion: "0.9.2", updating: false, checkpoint: null, recoveryError: null };
    case "update_preferences_status": return { checkOnStartup: false, autoDownload: false };
    case "mihomo_core_update_status": return { currentVersion: "1.19.29", availableVersion: null, assetName: null, phase: "idle", error: null };
    case "mihomo_rules": return { rules: [
      { type: "DOMAIN-SUFFIX", payload: "example.com", proxy: "PROXY" },
      { type: "IP-CIDR", payload: "10.0.0.0/8", proxy: "DIRECT" },
      { type: "GEOIP", payload: "CN", proxy: "DIRECT" },
      { type: "MATCH", payload: "", proxy: "PROXY" },
    ] };
    case "mihomo_rule_providers": return { providers: {} };
    case "dns_get": return { enabled: true, enhancedMode: "fake-ip", defaultNameserver: ["223.5.5.5"], nameserver: ["https://dns.google/dns-query"], fallback: [], fakeIpFilterMode: "blacklist", fakeIpFilter: ["*.lan"] };
    case "override_get": return { content: "rules:\n  - DOMAIN-SUFFIX,example.com,DIRECT", path: "local-override.yaml", hasContent: true, updatedAt: 1747041022 };
    case "config_preview": return { profileId: "global", profileName: "Global", yaml: "mode: rule\nmixed-port: 7890\nrules:\n  - DOMAIN-SUFFIX,example.com,DIRECT", overrideActive: true };
    default: throw new Error(`UI smoke has no fixture for ${cmd}`);
  }
}, { shouldMockEvents: true });

const [{ default: App }, ReactDOM] = await Promise.all([import("./App"), import("react-dom/client")]);
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

window.setTimeout(() => {
  const surface = document.getElementById("main-content");
  if (!surface) {
    document.documentElement.dataset.smokeGenericContextMenu = "missing-surface";
    document.documentElement.dataset.smokeContextMenuActions = "missing-surface";
    return;
  }
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  surface.dispatchEvent(event);
  document.documentElement.dataset.smokeGenericContextMenu = event.defaultPrevented ? "blocked" : "exposed";
  document.documentElement.dataset.smokeContextMenuActions = event.defaultPrevented
    ? "none"
    : "back-refresh-save-print-more-tools";
}, 0);

const traffic: TrafficSnapshot = {
  timestamp: Date.now(),
  up: 1_650_000,
  down: 8_420_000,
  todayUp: 183_500_000,
  todayDown: 1_928_000_000,
  history: Array.from({ length: 30 }, (_, index) => ({ timestamp: Date.now() - (29 - index) * 2000, up: 900_000 + (index % 6) * 120_000, down: 4_000_000 + ((index * 7) % 11) * 420_000 })),
};

window.setTimeout(() => {
  void emit("mihomo-traffic", traffic);
  const messages = [
    "System proxy enabled", "TUN interface started", "Runtime profile validated", "Selected node: US-01 (45 ms)",
    "Controller connection established", "DNS query: www.google.com", "Matched rule: DOMAIN-SUFFIX,google.com → PROXY",
    "Connection established to api.github.com:443", "Connection closed to www.google.com:443", "Profile update check completed",
    "High latency observed for DE-02: 138 ms", "Route updated", "No updates available", "Failed to connect to jp01.example.com:443",
  ];
  messages.forEach((message, index) => void emit("mihomo-log-entry", { timestamp: Date.now() + index, level: index === 13 ? "ERROR" : index === 10 ? "WARN" : "INFO", message }));
}, 120);
