import { Card } from "./Card";

export function StatusCard({
  title,
  value,
  detail,
  tone = "neutral"
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <Card className={`status-card tone-${tone}`}>
      <div className="status-card-topline">
        <span>{title}</span>
        <i aria-hidden="true" />
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </Card>
  );
}
