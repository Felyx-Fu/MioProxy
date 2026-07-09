import { Card, CardHeader } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { useMioProxyApp } from "../state/MioProxyAppState";

export function NodesPage() {
  const app = useMioProxyApp();

  return (
    <div className="page nodes-page">
      <PageHeader
        title="Nodes"
        description="Read proxy groups, switch strategy selections, test node delay, and inspect traffic."
      />

      <section className="page-grid two-column">
        <Card className="observation-section">
          <CardHeader
            title="Controller observations"
            description="Traffic and active connection snapshots."
            actions={
              <button
                type="button"
                onClick={() => void app.checkControllerObservations()}
                disabled={app.isObservationChecking}
              >
                {app.isObservationChecking ? "Reading" : "Read"}
              </button>
            }
          />
          <pre className="result-box compact">{app.observationResult}</pre>
        </Card>

        <Card className="proxy-groups-section">
          <CardHeader
            title="Proxy groups"
            description="Read groups, switch selection, and test delay."
            actions={
              <button
                type="button"
                onClick={() => void app.checkControllerProxies()}
                disabled={app.isProxyChecking}
              >
                {app.isProxyChecking ? "Reading" : "Read"}
              </button>
            }
          />
          <div className="field-row">
            <label>
              Group
              <input
                value={app.proxySwitchGroup}
                onChange={(event) => app.setProxySwitchGroup(event.target.value)}
                placeholder="GLOBAL"
              />
            </label>
            <label>
              Proxy
              <input
                value={app.proxySwitchTarget}
                onChange={(event) => app.setProxySwitchTarget(event.target.value)}
                placeholder="DIRECT"
              />
            </label>
          </div>
          <div className="core-actions">
            <button
              type="button"
              onClick={() => void app.switchControllerProxy()}
              disabled={app.isProxySwitching}
            >
              {app.isProxySwitching ? "Switching" : "Switch proxy"}
            </button>
            <button
              type="button"
              onClick={() => void app.testControllerProxyDelay()}
              disabled={app.isProxyDelayChecking}
            >
              {app.isProxyDelayChecking ? "Testing" : "Test delay"}
            </button>
          </div>
          <pre className="result-box compact">{app.proxyResult}</pre>
        </Card>

        <Card>
          <CardHeader
            title="Current selected node"
            description="Request-scoped selection helper for the active strategy group."
          />
          <div className="status-list">
            <div>
              <span>Group</span>
              <strong>{app.proxySwitchGroup || "Not selected"}</strong>
              <p>Use the proxy groups card to set a group name.</p>
            </div>
            <div>
              <span>Node</span>
              <strong>{app.proxySwitchTarget || "Not selected"}</strong>
              <p>Delay test and switch actions use this node name.</p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Node list"
            description="A full local node browser can be added after richer proxy snapshot state is modeled."
          />
          <EmptyState
            title="No local node table yet"
            description="Read proxy groups to inspect controller output in the snapshot panel. This page keeps node operations isolated from Dashboard."
            action={
              <button
                type="button"
                onClick={() => void app.checkControllerProxies()}
                disabled={app.isProxyChecking}
              >
                {app.isProxyChecking ? "Reading" : "Read proxy groups"}
              </button>
            }
          />
        </Card>
      </section>
    </div>
  );
}
