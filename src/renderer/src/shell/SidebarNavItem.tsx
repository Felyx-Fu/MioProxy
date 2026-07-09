import { NavLink } from "react-router-dom";
import type { NavItem } from "../routes/navItems";

export function SidebarNavItem({ item }: { item: NavItem }) {
  const Icon = item.icon;

  return (
    <NavLink
      to={item.path}
      className={({ isActive }) => `sidebar-nav-item${isActive ? " active" : ""}`}
    >
      <Icon className="sidebar-nav-icon" />
      <span>{item.label}</span>
      {item.status ? (
        <i className={`sidebar-nav-dot tone-${item.status}`} aria-hidden="true" />
      ) : null}
    </NavLink>
  );
}
