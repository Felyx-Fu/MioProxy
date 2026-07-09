import { Card, CardHeader } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { useMioProxyApp } from "../state/MioProxyAppState";

export function RulesPage() {
  const app = useMioProxyApp();

  return (
    <div className="page rules-page">
      <PageHeader
        title="Rules"
        description="Read Mihomo rules and rule-provider summaries through the authenticated controller."
      />
      <section className="page-grid">
        <Card>
          <CardHeader
            title="Rule providers"
            description="Provider summary from Mihomo controller."
            actions={
              <button
                type="button"
                onClick={() => void app.checkControllerRules()}
                disabled={app.isRuleChecking}
              >
                Update rule providers
              </button>
            }
          />
          <div className="status-list">
            <div>
              <span>Provider status</span>
              <strong>{app.ruleResult.includes("providers:") ? "Loaded" : "Not loaded"}</strong>
              <p>Run a rules read to refresh provider and rule counts.</p>
            </div>
            <div>
              <span>Rule set status</span>
              <strong>{app.ruleResult.includes("rules:") ? "Available" : "Pending read"}</strong>
              <p>Summaries are request scoped and not persisted.</p>
            </div>
          </div>
        </Card>

        <Card className="rules-section">
          <CardHeader
            title="Rule list"
            description="Snapshot the active rule list and provider summary."
            actions={
              <button
                type="button"
                onClick={() => void app.checkControllerRules()}
                disabled={app.isRuleChecking}
              >
                {app.isRuleChecking ? "Reading" : "Read"}
              </button>
            }
          />
          <pre className="result-box">{app.ruleResult}</pre>
        </Card>
      </section>
    </div>
  );
}
