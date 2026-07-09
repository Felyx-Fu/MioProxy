import { Card, CardHeader } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { useMioProxyApp } from "../state/MioProxyAppState";

export function ProfilesPage() {
  const app = useMioProxyApp();

  return (
    <div className="page profiles-page">
      <PageHeader
        title="Profiles"
        description="Manage profile identity, Clash Party imports, subscription schedules, and pipeline actions."
      />

      <section className="page-grid two-column">
        <Card className="profile-settings-section">
          <CardHeader
            title="Profile settings"
            description="Load, save, and import profile metadata."
            actions={
              <>
                <button
                  type="button"
                  onClick={() => void app.loadProfileSettings()}
                  disabled={app.isProfileSettingsBusy}
                >
                  Load
                </button>
                <button
                  type="button"
                  onClick={() => void app.saveProfileSettings()}
                  disabled={app.isProfileSettingsBusy}
                >
                  Save
                </button>
              </>
            }
          />
          <label>
            Profile
            <input
              value={app.form.profileId}
              onChange={(event) => app.updateField("profileId", event.target.value)}
            />
          </label>
          <label>
            Clash Party source
            <input
              value={app.form.clashPartySourceDir}
              onChange={(event) => app.updateField("clashPartySourceDir", event.target.value)}
              placeholder="Clash Party data directory"
            />
          </label>
          <button
            type="button"
            onClick={() => void app.importClashParty()}
            disabled={app.isImportBusy}
          >
            {app.isImportBusy ? "Importing" : "Import Clash Party"}
          </button>
          <pre className="result-box compact">{app.profileSettingsResult}</pre>
        </Card>

        <Card className="subscription-schedule-section">
          <CardHeader
            title="Subscription schedule"
            description="Control scheduled update state for this app session."
            actions={
              <>
                <button
                  type="button"
                  onClick={() => void app.loadSubscriptionSchedule()}
                  disabled={app.isScheduleBusy}
                >
                  Load
                </button>
                <button
                  type="button"
                  onClick={() => void app.saveSubscriptionSchedule()}
                  disabled={app.isScheduleBusy}
                >
                  Save
                </button>
              </>
            }
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={app.scheduleEnabled}
              onChange={(event) => app.setScheduleEnabled(event.target.checked)}
            />
            <span>Enabled</span>
          </label>
          <label>
            Interval minutes
            <input
              value={app.scheduleIntervalMinutes}
              onChange={(event) => app.setScheduleIntervalMinutes(event.target.value)}
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            onClick={() => void app.updateSubscriptionNow()}
            disabled={app.isScheduleBusy}
          >
            {app.isScheduleBusy ? "Updating" : "Update now"}
          </button>
          <p>
            Runtime: <strong>{app.scheduleRuntimeStatus?.armed ? "armed" : "not armed"}</strong>
          </p>
          <pre className="result-box compact">{app.scheduleResult}</pre>
        </Card>

        <Card className="span-2 pipeline-actions-section">
          <CardHeader
            title="Profile pipeline"
            description="Run the existing render, validation, promotion, and apply paths."
          />
          <div className="profile-actions">
            <button
              type="button"
              onClick={() => void app.updateSubscriptionNow()}
              disabled={app.isScheduleBusy}
            >
              {app.isScheduleBusy ? "Updating" : "Update Now"}
            </button>
            <button
              type="button"
              onClick={() => void app.validateProfile()}
              disabled={app.isRunning}
            >
              Validate & Promote
            </button>
            <button type="button" onClick={() => void app.runPipeline()} disabled={app.isRunning}>
              {app.isRunning ? "Running" : "Run Pipeline"}
            </button>
          </div>
          <pre className="result-box">{app.result}</pre>
        </Card>

        <Card className="span-2 config-lifecycle-section">
          <CardHeader
            title="Config lifecycle"
            description="Candidate and active config state, plus rollback behavior for failed applies."
          />
          <div className="status-list">
            <div>
              <span>Candidate config</span>
              <strong>{app.configStatus === "Not checked" ? "Not staged" : "Last run staged"}</strong>
              <p>Generated before offline validation and promotion.</p>
            </div>
            <div>
              <span>Active config</span>
              <strong>{app.latestRun?.ok ? "Promoted" : "No successful promote yet"}</strong>
              <p>{app.latestRun?.ok ? app.lastUpdated : "Waiting for a successful pipeline run."}</p>
            </div>
            <div>
              <span>Rollback on failure</span>
              <strong>Enabled by pipeline</strong>
              <p>Apply failures roll back to last-known-good when available.</p>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
