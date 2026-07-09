import { Card, CardHeader } from "./Card";

export function PipelineStepper({
  steps
}: {
  steps: Array<{
    label: string;
    detail: string;
  }>;
}) {
  return (
    <Card className="pipeline-stepper-card">
      <CardHeader
        title="Pipeline"
        description="Compact render, validate, promote, and apply flow."
      />
      <ol className="pipeline-stepper">
        {steps.map((step, index) => (
          <li key={step.label}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.label}</strong>
            <p>{step.detail}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}
