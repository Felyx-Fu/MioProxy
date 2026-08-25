import { ArrowDownAZ, Check, ChevronDown, ChevronRight, Eye, Gauge, Globe2, LocateFixed, Network, RefreshCw, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { CoreMode, ProxiesResponse, ProxyDelayContext, ProxyGroup } from "../api/mihomo";
import { ContextMenu } from "../components/ContextMenu";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../locales/en-US";
import { latencyTone } from "../utils/format";
import { createProxyDelayContext, proxyDelayBusyKey, proxyDelayKey } from "../utils/latency";
import { classifyNodeRegion, NODE_REGION_IDS, NODE_REGION_INFO, type NodeRegion, type NodeRegionInfo } from "../utils/nodeRegion";
import { loadFavoriteNodes, saveFavoriteNodes } from "../utils/proxyPreferences";

const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance"]);
const CORE_MODES: CoreMode[] = ["rule", "global", "direct"];
type SortMode = "name" | "delay";
type RegionFilter = "all" | "favorites" | NodeRegion;

const GROUP_TYPE_LABELS: Record<string, MessageKey> = {
  Selector: "proxies.groupType.selector",
  URLTest: "proxies.groupType.urlTest",
  Fallback: "proxies.groupType.fallback",
  LoadBalance: "proxies.groupType.loadBalance",
};

const MODE_LABELS: Record<CoreMode, MessageKey> = {
  rule: "proxies.mode.rule",
  global: "proxies.mode.global",
  direct: "proxies.mode.direct",
};

const MODE_DESCRIPTIONS: Record<CoreMode, MessageKey> = {
  rule: "proxies.mode.ruleDescription",
  global: "proxies.mode.globalDescription",
  direct: "proxies.mode.directDescription",
};

type GroupModel = {
  name: string;
  group: ProxyGroup;
  allNodes: string[];
  nodes: string[];
  matchesGroup: boolean;
  filter: RegionFilter;
  favoriteCount: number;
  regionCounts: Record<NodeRegion, number>;
  regionByNode: Map<string, NodeRegionInfo>;
};

type ContextMenuState = {
  x: number;
  y: number;
  group: string;
  node: string;
};

let runtimePreferenceScopeCounter = 0;

function createRuntimePreferenceScope() {
  runtimePreferenceScopeCounter += 1;
  return `runtime:${Date.now().toString(36)}:${runtimePreferenceScopeCounter}`;
}

function emptyRegionCounts(): Record<NodeRegion, number> {
  return Object.fromEntries(NODE_REGION_IDS.map((region) => [region, 0])) as Record<NodeRegion, number>;
}

export function ProxiesPage({ data, mode, modeBusy, loading, busyProxy, delayByKey, delayStatusByKey, profilesLoaded, profileCount, preferenceProfileId, onRefresh, onModeChange, onSelect, onDelay }: {
  data: ProxiesResponse | null;
  mode: CoreMode | null;
  modeBusy: boolean;
  loading: boolean;
  busyProxy: string | null;
  delayByKey: Record<string, number>;
  delayStatusByKey: Record<string, "available" | "unavailable">;
  profilesLoaded: boolean;
  profileCount: number;
  preferenceProfileId?: string | null;
  onRefresh: () => void;
  onModeChange: (mode: CoreMode) => Promise<void>;
  onSelect: (group: string, proxy: string) => Promise<void>;
  onDelay: (context: ProxyDelayContext) => Promise<void>;
}) {
  const { t } = useI18n();
  const normalizedProfileId = preferenceProfileId?.trim() || null;
  const profilePreferenceScope = normalizedProfileId ? `profile:${normalizedProfileId}` : null;
  const runtimePreferenceScopeRef = useRef<string | null>(null);
  if (!runtimePreferenceScopeRef.current) runtimePreferenceScopeRef.current = createRuntimePreferenceScope();
  const preferenceScope = profilePreferenceScope ?? runtimePreferenceScopeRef.current;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("name");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [groupFilters, setGroupFilters] = useState<Record<string, RegionFilter>>({});
  const [inspectedNode, setInspectedNode] = useState<{ group: string; node: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const favoriteNodesRef = useRef<Set<string>>(new Set(profilePreferenceScope ? loadFavoriteNodes(profilePreferenceScope) : []));
  const [favoriteNodes, setFavoriteNodes] = useState<Set<string>>(() => new Set(favoriteNodesRef.current));
  const expansionInitialized = useRef(false);

  useEffect(() => {
    const next = new Set(profilePreferenceScope ? loadFavoriteNodes(profilePreferenceScope) : []);
    favoriteNodesRef.current = next;
    setFavoriteNodes(next);
    setGroupFilters({});
  }, [preferenceScope, profilePreferenceScope]);

  const groups = useMemo(() => {
    const runtimeGroups = Object.entries(data?.proxies ?? {}).filter(([, value]) => GROUP_TYPES.has(value.type ?? ""));
    const groupsByName = new Map(runtimeGroups);
    const fallbackOrder = [...groupsByName.keys()].sort((a, b) => a.localeCompare(b));
    const orderedNames = [...(data?.groupOrder ?? []), ...fallbackOrder];
    const seen = new Set<string>();
    return orderedNames.flatMap((name) => {
      const group = groupsByName.get(name);
      if (!group || seen.has(name)) return [];
      seen.add(name);
      return [[name, group] as const];
    });
  }, [data]);

  useEffect(() => {
    if (!groups.length) {
      expansionInitialized.current = false;
      setExpandedGroups(new Set());
      setInspectedNode(null);
      setContextMenu(null);
      return;
    }
    const validNames = new Set(groups.map(([name]) => name));
    setExpandedGroups((current) => {
      const next = new Set([...current].filter((name) => validNames.has(name)));
      if (!expansionInitialized.current) {
        next.add(groups[0][0]);
        expansionInitialized.current = true;
      }
      return next;
    });
    setInspectedNode((current) => current && validNames.has(current.group) ? current : null);
  }, [groups]);

  useEffect(() => {
    const validNames = new Set(groups.map(([name]) => name));
    setGroupFilters((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([name]) => validNames.has(name))) as Record<string, RegionFilter>;
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [groups]);

  function toggleFavorite(node: string) {
    const next = new Set(favoriteNodesRef.current);
    if (next.has(node)) next.delete(node);
    else next.add(node);
    favoriteNodesRef.current = next;
    setFavoriteNodes(next);
    if (profilePreferenceScope) saveFavoriteNodes(profilePreferenceScope, next);
  }

  function setGroupFilter(group: string, filter: RegionFilter) {
    setGroupFilters((current) => ({ ...current, [group]: filter }));
  }

  const term = query.trim().toLocaleLowerCase();
  const groupModels = useMemo<GroupModel[]>(() => groups
    .map(([name, group]) => {
      const allNodes = [...(group.all ?? [])];
      const matchesGroup = Boolean(term) && name.toLocaleLowerCase().includes(term);
      const filter = groupFilters[name] ?? "all";
      const regionCounts = emptyRegionCounts();
      const regionByNode = new Map<string, NodeRegionInfo>();
      for (const node of allNodes) {
        const region = classifyNodeRegion(node);
        regionCounts[region.id] += 1;
        regionByNode.set(node, region);
      }
      const favoriteCount = allNodes.filter((node) => favoriteNodes.has(node)).length;
      const nodes = allNodes
        .filter((node) => {
          const matchesSearch = !term || matchesGroup || node.toLocaleLowerCase().includes(term);
          const region = regionByNode.get(node)?.id ?? "unknown";
          const matchesFilter = filter === "all" || (filter === "favorites" ? favoriteNodes.has(node) : region === filter);
          return matchesSearch && matchesFilter;
        })
        .sort((a, b) => sort === "delay"
          ? (delayByKey[proxyDelayKey(createProxyDelayContext(name, group, a, data?.proxies[a]))] ?? Number.POSITIVE_INFINITY)
            - (delayByKey[proxyDelayKey(createProxyDelayContext(name, group, b, data?.proxies[b]))] ?? Number.POSITIVE_INFINITY)
            || a.localeCompare(b)
          : a.localeCompare(b));
      return { name, group, allNodes, nodes, matchesGroup, filter, favoriteCount, regionCounts, regionByNode };
    })
    .filter((model) => !term || model.matchesGroup || model.nodes.length > 0),
  [data, delayByKey, favoriteNodes, groupFilters, groups, sort, term]);

  const totalNodes = groups.reduce((total, [, group]) => total + (group.all?.length ?? 0), 0);
  const focusedModel = groupModels.find((model) => model.name === inspectedNode?.group) ?? groupModels[0] ?? null;
  const focusedNode = focusedModel
    ? inspectedNode?.group === focusedModel.name && focusedModel.nodes.includes(inspectedNode.node)
      ? inspectedNode.node
      : focusedModel.group.now && focusedModel.nodes.includes(focusedModel.group.now)
        ? focusedModel.group.now
        : focusedModel.nodes[0] ?? null
    : null;
  const focusedContext = focusedModel && focusedNode
    ? createProxyDelayContext(focusedModel.name, focusedModel.group, focusedNode, data?.proxies[focusedNode])
    : null;

  function toggleGroup(name: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function focusNode(group: string, node: string) {
    setInspectedNode({ group, node });
  }

  function moveSelection(event: ReactKeyboardEvent<HTMLElement>, model: GroupModel, node: string) {
    if (event.target !== event.currentTarget || !model.nodes.length) return;
    const currentIndex = Math.max(0, model.nodes.indexOf(node));
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = Math.min(model.nodes.length - 1, currentIndex + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = model.nodes.length - 1;
    else if (event.key === "Enter" && busyProxy === null) {
      event.preventDefault();
      void onSelect(model.name, node);
      return;
    } else return;
    event.preventDefault();
    const nextNode = model.nodes[nextIndex];
    focusNode(model.name, nextNode);
    document.getElementById(nodeElementId(model.name, nextNode))?.focus();
  }

  function openContextMenu(event: ReactMouseEvent, group: string, node: string) {
    event.preventDefault();
    focusNode(group, node);
    setContextMenu({ x: event.clientX, y: event.clientY, group, node });
  }

  function locateFocused() {
    if (!focusedModel?.group.now) return;
    focusNode(focusedModel.name, focusedModel.group.now);
    setExpandedGroups((current) => new Set(current).add(focusedModel.name));
  }

  const contextEntry = contextMenu
    ? groups.find(([name]) => name === contextMenu.group) ?? null
    : null;
  const contextDelay = contextMenu && contextEntry
    ? createProxyDelayContext(contextEntry[0], contextEntry[1], contextMenu.node, data?.proxies[contextMenu.node])
    : null;

  return (
    <section className="page-stack proxies-page">
      <header className="page-header compact-header">
        <div><h1>{t("proxies.title")}</h1><p>{data ? t("proxies.description.count", { nodes: totalNodes, groups: groups.length }) : t("proxies.description.waiting")}</p></div>
      </header>

      <section className="proxy-mode-panel surface-panel" aria-labelledby="proxy-mode-title">
        <div className="proxy-mode-copy">
          <span className="section-kicker">{t("proxies.mode.label")}</span>
          <strong id="proxy-mode-title">{t("proxies.mode.title")}</strong>
          <p>{t("proxies.mode.description")}</p>
        </div>
        <div className="proxy-mode-options" role="group" aria-label={t("proxies.mode.label")}>
          {CORE_MODES.map((coreMode) => (
            <button
              key={coreMode}
              type="button"
              className={`proxy-mode-option${mode === coreMode ? " active" : ""}`}
              aria-pressed={mode === coreMode}
              disabled={modeBusy || mode === null}
              onClick={() => void onModeChange(coreMode)}
            >
              <span>{t(MODE_LABELS[coreMode])}</span>
              <small>{t(MODE_DESCRIPTIONS[coreMode])}</small>
            </button>
          ))}
        </div>
        {modeBusy && <span className="proxy-mode-pending"><span className="state-dot" />{t("proxies.mode.switching")}</span>}
      </section>

      {groups.length === 0 ? (
        <div className="empty-card surface-panel"><Network size={24} /><strong>{t(!profilesLoaded ? "proxies.empty.loadingTitle" : profileCount === 0 ? "proxies.empty.noProfilesTitle" : "proxies.empty.noGroupsTitle")}</strong><p>{t(!profilesLoaded ? "proxies.empty.loadingDescription" : profileCount === 0 ? "proxies.empty.noProfilesDescription" : "proxies.empty.noGroupsDescription")}</p></div>
      ) : (
        <div className="proxy-center-stack">
          <div className="proxy-center-toolbar surface-panel">
            <label className="search-box"><Search size={15} /><input data-page-search value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("proxies.search.placeholder")} aria-label={t("proxies.search.label")} /></label>
            <label className="select-field"><ArrowDownAZ size={14} /><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label={t("proxies.sort.label")}><option value="name">{t("proxies.sort.name")}</option><option value="delay">{t("proxies.sort.latency")}</option></select></label>
            <button className="toolbar-button" type="button" onClick={() => focusedContext && void onDelay(focusedContext)} disabled={!focusedContext || busyProxy !== null}><Gauge size={15} />{t("proxies.action.testSelected")}</button>
            <button className="icon-button" type="button" onClick={locateFocused} disabled={!focusedModel?.group.now} aria-label={t("proxies.action.locate")} title={t("proxies.action.locate")}><LocateFixed size={15} /></button>
            <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label={t("proxies.action.refresh")} title={t("proxies.action.refresh")}><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
          </div>

          <div className="proxy-strategy-stack">
            {groupModels.map((model, index) => {
              const expanded = expandedGroups.has(model.name) || (Boolean(term) && (model.matchesGroup || model.nodes.length > 0));
              const groupId = `proxy-group-${index}-${encodeURIComponent(model.name)}`;
              const labelId = `${groupId}-label`;
              const activeContext = model.group.now
                ? createProxyDelayContext(model.name, model.group, model.group.now, data?.proxies[model.group.now])
                : null;
              const activeKey = activeContext ? proxyDelayKey(activeContext) : null;
              const activeDelay = activeKey ? delayByKey[activeKey] : undefined;
              const activeDelayStatus = activeKey ? delayStatusByKey[activeKey] : undefined;
              const globalEmphasis = mode === "global" && model.name === "GLOBAL";
              return (
                <section key={model.name} className={`proxy-strategy-card surface-panel${globalEmphasis ? " global-emphasis" : ""}`} data-global-active={globalEmphasis ? "true" : "false"} aria-labelledby={labelId}>
                  <button className="proxy-strategy-header" type="button" aria-expanded={expanded} aria-controls={`${groupId}-content`} onClick={() => toggleGroup(model.name)}>
                    <span className="proxy-strategy-heading">
                      <strong id={labelId}>{model.name}</strong>
                      <span>{model.group.type ?? t("proxies.groups.fallbackType")} · {t(GROUP_TYPE_LABELS[model.group.type ?? ""] ?? "proxies.groups.fallbackType")}</span>
                    </span>
                    <span className="proxy-strategy-summary">
                      <span><small>{t("proxies.group.current")}</small><strong>{model.group.now ?? "—"}</strong></span>
                      <span><small>{t("proxies.group.nodeCount")}</small><strong>{model.allNodes.length}</strong></span>
                      <span><small>{t("proxies.table.latency")}</small><strong className={`latency-${activeDelayStatus === "unavailable" ? "slow" : latencyTone(activeDelay)}`}>{activeDelayStatus === "unavailable" ? t("proxies.state.unavailable") : activeDelay === undefined ? "—" : `${activeDelay} ms`}</strong></span>
                    </span>
                    {expanded ? <ChevronDown size={17} aria-hidden="true" /> : <ChevronRight size={17} aria-hidden="true" />}
                  </button>

                  {expanded && <div id={`${groupId}-content`} className="proxy-strategy-content">
                    <div className="proxy-region-filters" role="group" aria-label={`${model.name} ${t("proxies.filter.label")}`}>
                      <button className={`proxy-filter-chip${model.filter === "all" ? " active" : ""}`} type="button" aria-pressed={model.filter === "all"} onClick={() => setGroupFilter(model.name, "all")}>
                        <span>{t("proxies.filter.all")}</span><strong>{model.allNodes.length}</strong>
                      </button>
                      {(model.favoriteCount > 0 || model.filter === "favorites") && (
                        <button className={`proxy-filter-chip${model.filter === "favorites" ? " active" : ""}`} type="button" aria-pressed={model.filter === "favorites"} onClick={() => setGroupFilter(model.name, "favorites")}>
                          <Star size={12} fill="currentColor" aria-hidden="true" /><span>{t("proxies.filter.favorites")}</span><strong>{model.favoriteCount}</strong>
                        </button>
                      )}
                      {NODE_REGION_IDS.filter((region) => model.regionCounts[region] > 0).map((region) => {
                        const info = NODE_REGION_INFO[region];
                        return (
                          <button key={region} className={`proxy-filter-chip${model.filter === region ? " active" : ""}`} type="button" aria-pressed={model.filter === region} onClick={() => setGroupFilter(model.name, region)}>
                            {info.flag ? <span aria-hidden="true">{info.flag}</span> : <Globe2 size={12} aria-hidden="true" />}<span>{t(info.labelKey)}</span><strong>{model.regionCounts[region]}</strong>
                          </button>
                        );
                      })}
                    </div>
                    {model.nodes.length ? (
                      <div className="proxy-node-grid" role="list" aria-label={`${model.name} ${t("proxies.table.nodesLabel")}`}>
                        {model.nodes.map((node) => {
                          const delayContext = createProxyDelayContext(model.name, model.group, node, data?.proxies[node]);
                          const delayKey = proxyDelayKey(delayContext);
                          const delay = delayByKey[delayKey];
                          const delayStatus = delayStatusByKey[delayKey];
                          const active = node === model.group.now;
                          const inspecting = inspectedNode?.group === model.name && inspectedNode.node === node;
                          const testing = busyProxy === proxyDelayBusyKey(delayContext);
                          const selecting = busyProxy === `${model.name}:${node}`;
                          const type = data?.proxies[node]?.type ?? "—";
                          const region = model.regionByNode.get(node) ?? classifyNodeRegion(node);
                          const favorite = favoriteNodes.has(node);
                          return (
                            <article
                              key={node}
                              id={nodeElementId(model.name, node)}
                              className={`proxy-node-card${active ? " active" : ""}${inspecting ? " inspected" : ""}`}
                              data-active={active ? "true" : "false"}
                              data-inspected={inspecting ? "true" : "false"}
                              role="listitem"
                              tabIndex={0}
                              onClick={() => focusNode(model.name, node)}
                              onDoubleClick={() => busyProxy === null && void onSelect(model.name, node)}
                              onContextMenu={(event) => openContextMenu(event, model.name, node)}
                              onKeyDown={(event) => moveSelection(event, model, node)}
                            >
                              <div className="proxy-node-heading"><strong title={node}>{node}</strong><span className="proxy-node-heading-actions">{active && <span className="row-badge">{t("proxies.state.selected")}</span>}<button className={`proxy-favorite-button${favorite ? " active" : ""}`} type="button" aria-pressed={favorite} aria-label={t(favorite ? "proxies.favorite.remove" : "proxies.favorite.add", { name: node })} title={t(favorite ? "proxies.favorite.remove" : "proxies.favorite.add", { name: node })} onClick={(event) => { event.stopPropagation(); toggleFavorite(node); }} onDoubleClick={(event) => event.stopPropagation()}><Star size={14} fill={favorite ? "currentColor" : "none"} aria-hidden="true" /></button></span></div>
                              <div className="proxy-node-region">{region.flag ? <span aria-hidden="true">{region.flag}</span> : <Globe2 size={12} aria-hidden="true" />}<span>{t(region.labelKey)}</span></div>
                              <div className="proxy-node-meta"><span>{type}</span><StateText tone={selecting || testing ? "warning" : delayStatus === "unavailable" ? "error" : delay === undefined ? "muted" : "success"}>{selecting ? t("proxies.state.switching") : testing ? t("proxies.state.testing") : delayStatus === "unavailable" ? t("proxies.state.unavailable") : delay === undefined ? t("proxies.state.notTested") : t("proxies.state.available")}</StateText></div>
                              <div className="proxy-node-footer">
                                <button className={`table-link latency-${delayStatus === "unavailable" ? "slow" : latencyTone(delay)}`} type="button" onClick={(event) => { event.stopPropagation(); void onDelay(delayContext); }} disabled={busyProxy !== null}>
                                  <Gauge size={12} />{testing ? t("proxies.state.testing") : delayStatus === "unavailable" ? t("proxies.action.retry") : delay === undefined ? t("proxies.action.test") : `${delay} ms`}
                                </button>
                                <button className="compact-action" type="button" onClick={(event) => { event.stopPropagation(); void onSelect(model.name, node); }} disabled={active || busyProxy !== null}>{t("proxies.action.useNode")}</button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : <div className="table-empty"><Search size={18} /><span>{t(model.filter === "favorites" ? "proxies.empty.noFavorites" : model.filter === "all" ? "proxies.empty.noSearchResults" : "proxies.empty.noFilterResults")}</span></div>}
                  </div>}
                </section>
              );
            })}
            {term && !groupModels.length && <div className="empty-card surface-panel"><Search size={20} /><span>{t("proxies.empty.noSearchResults")}</span></div>}
          </div>
        </div>
      )}

      {contextMenu && contextEntry && <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} actions={[
        { label: t("proxies.context.inspect"), icon: <Eye size={14} />, onSelect: () => { focusNode(contextMenu.group, contextMenu.node); setExpandedGroups((current) => new Set(current).add(contextMenu.group)); } },
        { label: t("proxies.action.useNode"), icon: <Check size={14} />, disabled: contextMenu.node === contextEntry[1].now || busyProxy !== null, onSelect: () => void onSelect(contextMenu.group, contextMenu.node) },
        { label: t("proxies.context.testLatency"), icon: <Gauge size={14} />, disabled: busyProxy !== null || !contextDelay, onSelect: () => { if (contextDelay) void onDelay(contextDelay); } },
      ]} />}
    </section>
  );
}

function nodeElementId(group: string, node: string) {
  return `proxy-node-${encodeURIComponent(group)}-${encodeURIComponent(node)}`;
}

function StateText({ tone, children }: { tone: "success" | "warning" | "error" | "muted"; children: ReactNode }) {
  return <span className={`state-text tone-${tone}`}><span className="state-dot" />{children}</span>;
}
