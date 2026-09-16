import { useEffect, useState } from "react";
import type { ProxiesResponse } from "../api/mihomo";
import { useI18n } from "../i18n/I18nProvider";

export function NodePicker({ data, busy, onSelect, activeGroup = null }: { data: ProxiesResponse | null; busy: boolean; onSelect: (group: string, node: string) => Promise<void>; activeGroup?: string | null }) {
  const { t } = useI18n();
  const groups = Object.entries(data?.proxies ?? {}).filter(([, group]) => group.type === "Selector" && group.all?.length);
  const [chosenGroup, setChosenGroup] = useState("");
  const groupName = groups.some(([name]) => name === chosenGroup)
    ? chosenGroup
    : activeGroup && groups.some(([name]) => name === activeGroup)
      ? activeGroup
      : groups.find(([name]) => name !== "GLOBAL")?.[0] ?? groups[0]?.[0] ?? "";
  const group = data?.proxies[groupName];
  useEffect(() => { if (!groups.length) setChosenGroup(""); }, [groups.length]);
  return <div className="node-picker">
    <label>{t("home.group")}<select value={groupName} disabled={!groups.length || busy} onChange={event => setChosenGroup(event.target.value)}>{!groups.length && <option value="">—</option>}{groups.map(([name]) => <option key={name}>{name}</option>)}</select></label>
    <label>{t("dashboard.selectedNode")}<select value={group?.now ?? ""} disabled={!group || busy} onChange={event => void onSelect(groupName, event.target.value)}>{!group?.now && <option value="">—</option>}{group?.all?.map(name => <option key={name}>{name}</option>)}</select></label>
  </div>;
}
