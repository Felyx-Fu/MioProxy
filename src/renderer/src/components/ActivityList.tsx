import { Card, CardHeader } from "./Card";
import type { ActivityTone } from "../state/MioProxyAppState";

export function ActivityList({
  items
}: {
  items: Array<{
    title: string;
    detail: string;
    tone: ActivityTone;
  }>;
}) {
  return (
    <Card className="activity-card">
      <CardHeader
        title="Recent Activity"
        description="Latest configuration pipeline events."
      />
      <ol className="activity-list">
        {items.map((item) => (
          <li key={`${item.title}-${item.detail}`} className={`tone-${item.tone}`}>
            <span aria-hidden="true" />
            <div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
