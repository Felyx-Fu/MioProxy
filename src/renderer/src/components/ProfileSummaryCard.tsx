import { Card, CardHeader } from "./Card";

export function ProfileSummaryCard({
  profileId,
  controllerBaseUrl,
  lastUpdated,
  configStatus,
  onUpdate,
  updateDisabled,
  updateLabel,
  onValidate,
  validateDisabled,
  onReload,
  reloadDisabled
}: {
  profileId: string;
  controllerBaseUrl: string;
  lastUpdated: string;
  configStatus: string;
  onUpdate: () => void;
  updateDisabled: boolean;
  updateLabel: string;
  onValidate: () => void;
  validateDisabled: boolean;
  onReload: () => void;
  reloadDisabled: boolean;
}) {
  return (
    <Card className="profile-summary-card">
      <CardHeader
        title="Active Profile"
        description={controllerBaseUrl || "Controller URL not configured"}
        actions={<span className="card-badge">Current</span>}
      />
      <div className="profile-summary-body">
        <div>
          <span>Profile</span>
          <strong>{profileId || "default"}</strong>
        </div>
        <div>
          <span>Last update</span>
          <strong>{lastUpdated}</strong>
        </div>
        <div>
          <span>Configuration check</span>
          <strong>{configStatus}</strong>
        </div>
      </div>
      <div className="profile-actions">
        <button type="button" onClick={onUpdate} disabled={updateDisabled}>
          {updateLabel}
        </button>
        <button type="button" onClick={onValidate} disabled={validateDisabled}>
          Validate & Promote
        </button>
        <button type="button" onClick={onReload} disabled={reloadDisabled}>
          Run Pipeline
        </button>
      </div>
    </Card>
  );
}
