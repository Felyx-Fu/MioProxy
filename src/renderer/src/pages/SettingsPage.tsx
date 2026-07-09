import { Card, CardHeader } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { useMioProxyApp } from "../state/MioProxyAppState";

export function SettingsPage() {
  const app = useMioProxyApp();

  return (
    <div className="page settings-page">
      <PageHeader
        title="Settings"
        description="Configure Mihomo paths, controller access, runtime activation, and Windows proxy behavior."
      />

      <section className="page-grid two-column">
        <Card className="pipeline-inputs-section span-2">
          <CardHeader
            title="Core path"
            description="Mihomo binary and data directory used by the local runtime."
            actions={
              <button
                type="button"
                onClick={() => void app.runPipeline()}
                disabled={app.isRunning}
              >
                {app.isRunning ? "Running" : "Run pipeline"}
              </button>
            }
          />
          <label>
            Mihomo binary
            <input
              value={app.form.mihomoBinaryPath}
              onChange={(event) => app.updateField("mihomoBinaryPath", event.target.value)}
            />
          </label>
          <label>
            Mihomo data dir
            <input
              value={app.form.mihomoDataDir}
              onChange={(event) => app.updateField("mihomoDataDir", event.target.value)}
            />
          </label>
          <pre className="result-box">{app.result}</pre>
        </Card>

        <Card>
          <CardHeader
            title="Controller address"
            description="Authenticated external-controller access."
            actions={
              <button
                type="button"
                onClick={() => void app.checkControllerHealth()}
                disabled={app.isHealthChecking}
              >
                {app.isHealthChecking ? "Checking" : "Check"}
              </button>
            }
          />
          <label>
            Controller URL
            <input
              value={app.form.controllerBaseUrl}
              onChange={(event) => app.updateField("controllerBaseUrl", event.target.value)}
            />
          </label>
          <label>
            Controller secret
            <input
              type="password"
              value={app.form.controllerSecret}
              onChange={(event) => app.updateField("controllerSecret", event.target.value)}
            />
          </label>
          <pre className="result-box compact">{app.healthResult}</pre>
        </Card>

        <Card>
          <CardHeader
            title="Mixed port"
            description="Windows system proxy target used by activation."
          />
          <div className="field-row">
            <label>
              System proxy host
              <input
                value={app.form.systemProxyHost}
                onChange={(event) => app.updateField("systemProxyHost", event.target.value)}
              />
            </label>
            <label>
              System proxy port
              <input
                value={app.form.systemProxyPort}
                onChange={(event) => app.updateField("systemProxyPort", event.target.value)}
              />
            </label>
          </div>
          <label>
            System proxy bypass
            <input
              value={app.form.systemProxyBypass}
              onChange={(event) => app.updateField("systemProxyBypass", event.target.value)}
            />
          </label>
        </Card>

        <Card className="activation-section">
          <CardHeader
            title="Activation"
            description="Prepare config, connect profile, and rollback on failure."
            actions={
              <button type="button" onClick={() => void app.refreshActivationStatus()}>
                Status
              </button>
            }
          />
          <div className="core-actions">
            <button
              type="button"
              onClick={() => void app.connectProfile()}
              disabled={app.isActivationBusy || app.activationStatus?.connected === true}
            >
              Connect
            </button>
            <button
              type="button"
              onClick={() => void app.disconnectProfile()}
              disabled={app.isActivationBusy}
            >
              Disconnect
            </button>
          </div>
          <pre className="result-box compact">{app.activationResult}</pre>
        </Card>

        <Card className="theme-section">
          <CardHeader
            title="Theme"
            description="Visual mode controls are reserved for the desktop settings surface."
          />
          <div className="setting-row">
            <span>Current theme</span>
            <strong>Light</strong>
          </div>
        </Card>

        <Card className="system-proxy-section">
          <CardHeader
            title="System proxy"
            description="Mutate current-user WinINET proxy values with restore support."
            actions={
              <button type="button" onClick={() => void app.refreshSystemProxyStatus()}>
                Status
              </button>
            }
          />
          <div className="proxy-actions">
            <button
              type="button"
              onClick={() => void app.enableSystemProxy()}
              disabled={app.isSystemProxyBusy || app.systemProxyStatus?.supported === false}
            >
              Enable
            </button>
            <button
              type="button"
              onClick={() => void app.disableSystemProxy()}
              disabled={app.isSystemProxyBusy || app.systemProxyStatus?.supported === false}
            >
              Disable
            </button>
            <button
              type="button"
              onClick={() => void app.restoreSystemProxy()}
              disabled={
                app.isSystemProxyBusy ||
                app.systemProxyStatus?.supported === false ||
                app.systemProxyStatus?.managedSnapshot !== true
              }
            >
              Restore
            </button>
          </div>
          <pre className="result-box compact">{app.systemProxyResult}</pre>
        </Card>

        <Card className="core-section">
          <CardHeader
            title="Core process"
            description="Start and stop the generated active.yaml runtime."
            actions={
              <button type="button" onClick={() => void app.refreshCoreStatus()}>
                Status
              </button>
            }
          />
          <div className="core-actions">
            <button
              type="button"
              onClick={() => void app.startCore()}
              disabled={app.isCoreBusy || app.coreStatus?.running === true}
            >
              Start core
            </button>
            <button
              type="button"
              onClick={() => void app.stopCore()}
              disabled={app.isCoreBusy || app.coreStatus?.running !== true}
            >
              Stop core
            </button>
          </div>
          <pre className="result-box compact">{app.coreResult}</pre>
        </Card>

        <Card>
          <CardHeader
            title="Auto update"
            description="Store subscription source and use Profiles for schedule control."
          />
          <label>
            Subscription URL
            <input
              value={app.form.subscriptionUrl}
              onChange={(event) => app.updateField("subscriptionUrl", event.target.value)}
              placeholder="https://example.test/sub.yaml"
            />
          </label>
          <div className="setting-row">
            <span>Schedule</span>
            <strong>{app.scheduleEnabled ? "Enabled" : "Disabled"}</strong>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Advanced settings"
            description="Security-sensitive defaults remain conservative."
          />
          <div className="status-list">
            <div>
              <span>Controller bind</span>
              <strong>Loopback preferred</strong>
              <p>Default behavior avoids binding to 0.0.0.0.</p>
            </div>
            <div>
              <span>Smart core</span>
              <strong>Compatibility downgrade</strong>
              <p>Experimental behavior is not enabled by default.</p>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
