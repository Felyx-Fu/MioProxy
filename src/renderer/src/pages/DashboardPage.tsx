import { useNavigate } from "react-router-dom";
import { ActivityList } from "../components/ActivityList";
import { Card, CardHeader } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { PipelineStepper } from "../components/PipelineStepper";
import { StatusBadge } from "../components/StatusBadge";
import { StatusCard } from "../components/StatusCard";
import { pipelineSteps, useMioProxyApp } from "../state/MioProxyAppState";

export function DashboardPage() {
  const app = useMioProxyApp();
  const navigate = useNavigate();

  return (
    <div className="page dashboard-page">
      <PageHeader
        title="Dashboard"
        description="Monitor MioProxy runtime, profile health, and recent activity."
        actions={
          <>
            <StatusBadge>MVP</StatusBadge>
            <StatusBadge tone={app.coreStatus?.running ? "success" : "neutral"}>
              {app.coreStatusLabel}
            </StatusBadge>
          </>
        }
      />

      <section className="status-grid" aria-label="Runtime overview">
        <StatusCard
          title="Core Status"
          value={app.coreStatusLabel}
          detail={app.coreStatus?.pid ? `PID ${app.coreStatus.pid}` : "No core process is active"}
          tone={app.coreStatus?.running ? "success" : "neutral"}
        />
        <StatusCard
          title="Active Profile"
          value={app.form.profileId || "default"}
          detail={app.lastUpdated}
        />
        <StatusCard
          title="Config Health"
          value={app.configHealthLabel}
          detail={app.configStatus}
          tone={app.latestRun?.ok ? "success" : app.latestRun ? "warning" : "neutral"}
        />
        <StatusCard
          title="System Proxy"
          value={app.systemProxyLabel}
          detail={
            app.systemProxyStatus?.managedSnapshot
              ? "Managed snapshot available"
              : "No managed snapshot"
          }
          tone={app.systemProxyStatus?.enabled ? "success" : "neutral"}
        />
      </section>

      <section className="dashboard-grid">
        <ActivityList items={app.activityItems} />
        <Card className="quick-actions-card">
          <CardHeader
            title="Quick Actions"
            description="Run common profile and runtime operations without opening the full form."
          />
          <div className="quick-actions-grid">
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
              Run Pipeline
            </button>
            <button type="button" onClick={() => navigate("/logs")}>
              Open Logs
            </button>
          </div>
        </Card>
        <PipelineStepper steps={pipelineSteps} />
      </section>
    </div>
  );
}
