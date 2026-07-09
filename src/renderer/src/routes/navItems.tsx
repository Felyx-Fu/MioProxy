import type { ReactElement, SVGProps } from "react";

export type NavIcon = (props: SVGProps<SVGSVGElement>) => ReactElement;

export interface NavItem {
  label: string;
  path: string;
  icon: NavIcon;
  status?: "neutral" | "success" | "warning" | "danger";
}

export const navItems: NavItem[] = [
  { label: "Dashboard", path: "/dashboard", icon: HomeIcon },
  { label: "Profiles", path: "/profiles", icon: ProfileIcon },
  { label: "Nodes", path: "/nodes", icon: NodesIcon, status: "neutral" },
  { label: "Rules", path: "/rules", icon: RulesIcon },
  { label: "Overrides", path: "/overrides", icon: CodeIcon },
  { label: "Logs", path: "/logs", icon: LogsIcon, status: "neutral" },
  { label: "Settings", path: "/settings", icon: SettingsIcon }
];

function HomeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M4.75 10.4 12 4.75l7.25 5.65v8.85a1 1 0 0 1-1 1h-4.1v-5.9h-4.3v5.9h-4.1a1 1 0 0 1-1-1V10.4Z" />
    </svg>
  );
}

function ProfileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M7 4.75h10A2.25 2.25 0 0 1 19.25 7v10A2.25 2.25 0 0 1 17 19.25H7A2.25 2.25 0 0 1 4.75 17V7A2.25 2.25 0 0 1 7 4.75Zm1.75 4.2h6.5v-1.7h-6.5v1.7Zm0 3.9h6.5v-1.7h-6.5v1.7Zm0 3.9h4.4v-1.7h-4.4v1.7Z" />
    </svg>
  );
}

function NodesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M7.25 8.75a3 3 0 1 1 2.84-3.95h3.82a3 3 0 1 1 0 1.9h-3.82a3.02 3.02 0 0 1-2.84 2.05Zm9.5 10.5a3 3 0 0 1-2.84-2.05h-3.82a3 3 0 1 1 0-1.9h3.82a3 3 0 1 1 2.84 3.95Zm0-1.8a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Zm-9.5 0a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Zm9.5-10.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Zm-9.5 0a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z" />
    </svg>
  );
}

function RulesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M5.25 5.75A1.75 1.75 0 0 1 7 4h10a1.75 1.75 0 0 1 1.75 1.75v12.5A1.75 1.75 0 0 1 17 20H7a1.75 1.75 0 0 1-1.75-1.75V5.75Zm4 2.15h6.5V6.25h-6.5V7.9Zm0 4.05h6.5V10.3h-6.5v1.65Zm0 4.05h4.8v-1.65h-4.8V16ZM7 8.05h1.25V6.8H7v1.25Zm0 4.05h1.25v-1.25H7v1.25Zm0 4.05h1.25V14.9H7v1.25Z" />
    </svg>
  );
}

function CodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="m8.5 16.3-4-4.3 4-4.3 1.35 1.25L7 12l2.85 3.05L8.5 16.3Zm7 0-1.35-1.25L17 12l-2.85-3.05L15.5 7.7l4 4.3-4 4.3Zm-3.9 2.05-1.8-.55 2.6-12.15 1.8.55-2.6 12.15Z" />
    </svg>
  );
}

function LogsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M5.25 5.75A1.75 1.75 0 0 1 7 4h10a1.75 1.75 0 0 1 1.75 1.75v12.5A1.75 1.75 0 0 1 17 20H7a1.75 1.75 0 0 1-1.75-1.75V5.75ZM8 8.15h8V6.5H8v1.65Zm0 4.05h8v-1.65H8v1.65Zm0 4.05h5.7V14.6H8v1.65Z" />
    </svg>
  );
}

function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M10.8 3.75h2.4l.45 2.05c.46.15.9.34 1.32.58l1.77-1.12 1.7 1.7-1.12 1.77c.24.42.43.86.58 1.32l2.05.45v2.4l-2.05.45c-.15.46-.34.9-.58 1.32l1.12 1.77-1.7 1.7-1.77-1.12c-.42.24-.86.43-1.32.58l-.45 2.05h-2.4l-.45-2.05c-.46-.15-.9-.34-1.32-.58l-1.77 1.12-1.7-1.7 1.12-1.77c-.24-.42-.43-.86-.58-1.32l-2.05-.45v-2.4l2.05-.45c.15-.46.34-.9.58-1.32L5.56 6.96l1.7-1.7 1.77 1.12c.42-.24.86-.43 1.32-.58l.45-2.05ZM12 14.95a2.95 2.95 0 1 0 0-5.9 2.95 2.95 0 0 0 0 5.9Z" />
    </svg>
  );
}
