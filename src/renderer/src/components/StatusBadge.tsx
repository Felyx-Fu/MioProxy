export function StatusBadge({
  children,
  tone = "neutral"
}: {
  children: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return <span className={`status-badge ${tone}`}>{children}</span>;
}
