import { Link } from "react-router-dom";

export function SidebarStatusCard({
  title,
  value,
  detail,
  to,
  tone = "neutral"
}: {
  title: string;
  value: string;
  detail: string;
  to: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <Link to={to} className={`sidebar-status-card tone-${tone}`}>
      <span className="sidebar-status-dot" aria-hidden="true" />
      <div>
        <span>{title}</span>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </Link>
  );
}
