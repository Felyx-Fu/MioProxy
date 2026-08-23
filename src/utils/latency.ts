import type { ProxiesResponse, ProxyDelayContext, ProxyEntryKind, ProxyGroup } from "../api/mihomo";

export const DEFAULT_DELAY_TEST_URL = "https://www.gstatic.com/generate_204";

const PROXY_GROUP_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
]);

const BUILTIN_PROXY_TYPES = new Set([
  "Direct",
  "Reject",
  "RejectDrop",
  "Pass",
  "PassRule",
  "Compatible",
]);

export function effectiveDelayTestUrl(testUrl?: string): string {
  const trimmed = testUrl?.trim();
  return trimmed || DEFAULT_DELAY_TEST_URL;
}

export function providerNameForEntry(entry: ProxyGroup | undefined): string | undefined {
  const rawProvider = entry?.["provider-name"]?.trim() || entry?.providerName?.trim();
  return rawProvider || undefined;
}

export function proxyEntryKind(entry: ProxyGroup | undefined): ProxyEntryKind {
  const type = entry?.type;
  if (type && PROXY_GROUP_TYPES.has(type)) return "group";
  if (type && BUILTIN_PROXY_TYPES.has(type)) return "builtin";
  if (providerNameForEntry(entry)) return "provider";
  return "ordinary";
}

export function createProxyDelayContext(
  group: string,
  groupEntry: ProxyGroup | undefined,
  proxy: string,
  proxyEntry: ProxyGroup | undefined,
): ProxyDelayContext {
  const memberContext = groupEntry?.memberContexts?.[proxy];
  const kind = memberContext?.kind ?? proxyEntryKind(proxyEntry);
  const provider = memberContext
    ? memberContext.provider
    : kind === "provider"
      ? providerNameForEntry(proxyEntry)
      : undefined;
  return {
    group,
    proxy,
    ...(provider ? { provider } : {}),
    ...(groupEntry?.testUrl ? { testUrl: groupEntry.testUrl } : {}),
    ...(groupEntry?.expectedStatus ? { expectedStatus: groupEntry.expectedStatus } : {}),
    kind,
  };
}

export function currentNodeDelayContext(
  proxies: ProxiesResponse | null,
  group: string | null,
  proxy: string | null,
): ProxyDelayContext | null {
  if (!proxies || !group || !proxy) return null;
  return createProxyDelayContext(group, proxies.proxies[group], proxy, proxies.proxies[proxy]);
}

export function proxyDelayKey(context: ProxyDelayContext): string {
  return [
    context.group,
    context.proxy,
    context.provider ?? "",
    context.kind,
    effectiveDelayTestUrl(context.testUrl),
    context.expectedStatus ?? "",
  ].map((part) => encodeURIComponent(part)).join("|");
}

export function proxyDelayBusyKey(context: ProxyDelayContext): string {
  return `delay:${proxyDelayKey(context)}`;
}
