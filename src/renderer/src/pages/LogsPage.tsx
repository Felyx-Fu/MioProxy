import { useMemo, useState } from "react";
import { Card, CardHeader } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { useMioProxyApp } from "../state/MioProxyAppState";

export function LogsPage() {
  const app = useMioProxyApp();
  const [levelFilter, setLevelFilter] = useState<"all" | "error" | "warning" | "info">("all");
  const visibleLogs = useMemo(
    () =>
      app.logs
        .filter((item) => levelFilter === "all" || item.level === levelFilter)
        .slice(-20),
    [app.logs, levelFilter]
  );
  const latestError = [...app.logs].reverse().find((item) => item.level === "error");

  return (
    <div className="page logs-page">
      <PageHeader
        title="Logs"
        description="Inspect controller log collection, recent core events, and failed run reports."
      />

      <section className="page-grid two-column">
        <Card>
          <CardHeader
            title="App logs"
            description="Recent pipeline activity and diagnostic export state."
          />
          <pre className="result-box compact">{app.diagnosticResult}</pre>
        </Card>

        <Card className="logs-section span-2">
          <CardHeader
            title="Core logs"
            description="Start, stop, and refresh controller log collection for the active profile."
            actions={
              <>
                <button type="button" onClick={() => void app.refreshControllerLogStatus()}>
                  Status
                </button>
                <button type="button" onClick={() => void app.refreshLogs()}>
                  Refresh
                </button>
              </>
            }
          />
          <div className="filter-pills" aria-label="Log level filter">
            {(["all", "error", "warning", "info"] as const).map((level) => (
              <button
                key={level}
                type="button"
                className={levelFilter === level ? "active" : ""}
                onClick={() => setLevelFilter(level)}
              >
                {level}
              </button>
            ))}
          </div>
          <div className="core-actions">
            <button
              type="button"
              onClick={() => void app.startControllerLogs()}
              disabled={app.isControllerLogBusy || app.controllerLogStatus?.running === true}
            >
              Start controller logs
            </button>
            <button
              type="button"
              onClick={() => void app.stopControllerLogs()}
              disabled={app.isControllerLogBusy || app.controllerLogStatus?.running !== true}
            >
              Stop controller logs
            </button>
          </div>
          <pre className="result-box compact">{app.controllerLogResult}</pre>
          {visibleLogs.length === 0 ? (
            <p>No logs yet</p>
          ) : (
            <ol>
              {visibleLogs.map((item, index) => (
                <li key={`${item.time}-${index}`} data-level={item.level}>
                  <span>{item.level}</span>
                  <span>{item.source}</span>
                  <time>{new Date(item.time).toLocaleTimeString()}</time>
                  <p>{item.message}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card className="history-section">
          <CardHeader
            title="Recent runs"
            description="Pipeline history and redacted diagnostic export."
          />
          <pre className="result-box compact">{app.diagnosticResult}</pre>
          {app.history.length === 0 ? (
            <p>No runs yet</p>
          ) : (
            <ol>
              {app.history.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <strong>{item.ok ? "Applied" : "Failed"}</strong>
                  <span>{item.profileId}</span>
                  <span>{item.stage}</span>
                  {!item.ok && item.failureBundlePath ? (
                    <button
                      type="button"
                      onClick={() => void app.exportFailureReport(item.id)}
                      disabled={app.exportingHistoryId !== null}
                    >
                      {app.exportingHistoryId === item.id ? "Exporting" : "Export report"}
                    </button>
                  ) : null}
                  <time>{new Date(item.createdAt).toLocaleString()}</time>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Copy latest error"
            description="Copy the most recent core error message when available."
          />
          <button
            type="button"
            disabled={!latestError}
            onClick={() => {
              if (latestError) {
                void navigator.clipboard.writeText(latestError.message);
              }
            }}
          >
            Copy latest error
          </button>
          <pre className="result-box compact">
            {latestError ? latestError.message : "No error log captured yet."}
          </pre>
        </Card>
      </section>
    </div>
  );
}
