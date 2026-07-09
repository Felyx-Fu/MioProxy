import { Card, CardHeader } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { useMioProxyApp } from "../state/MioProxyAppState";

export function OverridesPage() {
  const app = useMioProxyApp();

  return (
    <div className="page overrides-page">
      <PageHeader
        title="Overrides"
        description="Review imported Clash Party override metadata and profile selections."
      />
      <section className="page-grid">
        <Card className="override-section">
          <CardHeader
            title="Overrides"
            description="Global overrides are always active; profile overrides can be selected."
            actions={
              <>
                <button type="button" onClick={() => void app.refreshOverrideSettings()}>
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void app.saveOverrideSelection()}
                  disabled={app.isOverrideBusy || app.overrideState === null}
                >
                  Save
                </button>
              </>
            }
          />
          {app.overrideState?.items.length ? (
            <ol className="override-list">
              {app.overrideState.items.map((item) => (
                <li key={item.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={app.activeOverrideIds().includes(item.id)}
                      disabled={item.global}
                      onChange={() => app.toggleOverrideSelection(item.id)}
                    />
                    <span>{item.name}</span>
                  </label>
                  <small>
                    {item.ext}
                    {item.global ? " global" : ""}
                    {item.path ? "" : " missing"}
                  </small>
                </li>
              ))}
            </ol>
          ) : (
            <p>No imported overrides</p>
          )}
          <pre className="result-box compact">{app.overrideResult}</pre>
        </Card>

        <Card>
          <CardHeader
            title="YAML overrides"
            description="Imported YAML override metadata from Clash Party."
          />
          <div className="status-list">
            <div>
              <span>YAML entries</span>
              <strong>
                {app.overrideState?.items.filter((item) => item.ext === "yaml").length ?? 0}
              </strong>
              <p>YAML override contents are not copied into MioProxy state.</p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="JS overrides"
            description="Imported JavaScript override metadata."
          />
          <div className="status-list">
            <div>
              <span>JS entries</span>
              <strong>
                {app.overrideState?.items.filter((item) => item.ext === "js").length ?? 0}
              </strong>
              <p>Script content stays in the source directory and runs only through the pipeline.</p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Test override"
            description="Validate selected overrides by running the safe prepare path."
          />
          <button
            type="button"
            onClick={() => void app.validateProfile()}
            disabled={app.isRunning}
          >
            {app.isRunning ? "Validating" : "Test selected overrides"}
          </button>
          <pre className="result-box compact">{app.result}</pre>
        </Card>

        <Card>
          <CardHeader
            title="Bind override to profile"
            description="Selection state is stored per profile."
          />
          <div className="status-list">
            <div>
              <span>Profile</span>
              <strong>{app.form.profileId || "default"}</strong>
              <p>Use the override list to bind non-global overrides.</p>
            </div>
          </div>
        </Card>

        <Card className="span-2">
          <CardHeader
            title="Preview generated config diff"
            description="A structured diff view can be added after candidate and active snapshots are exposed safely."
          />
          <pre className="result-box compact">
            {app.result === "Idle" ? "Run Validate & Promote to stage the current override chain." : app.result}
          </pre>
        </Card>
      </section>
    </div>
  );
}
