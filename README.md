# MioProxy

> Windows-first Mihomo desktop controller with a deterministic, rollback-safe
> configuration pipeline.

MioProxy is building the boring but critical part of a proxy desktop app first:
turning subscriptions and overrides into a validated `active.yaml`, applying it
to Mihomo safely, and giving the user enough diagnostics to recover when
something goes wrong.

The current milestone is intentionally narrow. It favors predictable config
generation, authenticated controller access, local rollback, and Windows system
proxy restoration before adding heavier UI layers, TUN defaults, updater logic,
or experimental Smart Core behavior.

## Why Watch This Project

- **Safe config promotion** - render to `candidate.yaml`, validate with
  `mihomo -t`, then promote to `active.yaml` only after the offline check passes.
- **Rollback-first activation** - connection setup composes core process,
  controller logs, system proxy enablement, and reverse-order rollback on
  failures.
- **Clash Party migration path** - import profiles, overrides, and cached profile
  YAML without mutating the source directory or copying secrets.
- **Controller operations without secret persistence** - health, traffic,
  connections, proxy groups, rules, and delay checks use request-scoped Bearer
  authentication.
- **Shareable diagnostics** - failed runs can export redacted bundles with stage
  metadata, command/controller output, compact history, and recent core logs.

## Current Status

MioProxy is an early Windows MVP. It is useful for contributors interested in
the pipeline, runtime safety model, and Electron integration. It is not yet a
polished end-user proxy client.

Implemented:

- Subscription download with stale-cache fallback.
- YAML and JavaScript override execution.
- Mihomo compatibility sanitization, including stable-core downgrade behavior
  for Smart and relay groups.
- Candidate validation, promotion, apply, hot reload, restart fallback, and
  rollback.
- Core process management and normalized core/controller log collection.
- Profile settings, subscription schedules, pipeline history, and override
  selection.
- Clash Party profile import.
- Windows user WinINET system proxy enable, disable, and restore.
- Windows unpacked app and release zip packaging through Electron Builder.

Deliberately deferred:

- Default TUN enablement.
- Default experimental Smart Core behavior.
- Signed installers and auto-update.
- Cross-platform desktop support.

## Pipeline

```text
raw subscription
  -> YAML/JS overrides
  -> Mihomo compatibility sanitize
  -> candidate.yaml
  -> mihomo -t
  -> active.yaml
  -> hot reload / restart
  -> rollback to last-known-good on failure
```

`active.yaml` is treated as generated state. Do not edit it directly; change the
source subscription, imported overrides, or pipeline inputs instead.

## Quick Start

Requirements:

- Windows for the desktop/runtime target.
- Node.js compatible with the CI setup.
- pnpm 11.7.0.
- A Mihomo binary for local runtime or integration testing.

Install and validate:

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

Optional local migration validation can be run against a real Clash Party data
directory and a real Mihomo binary:

```powershell
$env:MIOPROXY_CLASH_PARTY_SOURCE = "C:\path\to\mihomo-party"
$env:MIOPROXY_MIHOMO_BINARY = "C:\path\to\mihomo.exe"
pnpm test:integration:local
```

Run the Electron app in development:

```bash
pnpm dev
```

Create a local unpacked Windows app:

```bash
pnpm package:win
```

The unpacked app is written to `dist/win-unpacked`.

Create a local Windows release zip:

```bash
pnpm release:win
```

The release zip is written under `dist/`. Git tags matching `v*` run the release
workflow, create a GitHub Release, and upload the same unsigned portable zip.

## App Surface

The current renderer is a dashboard-first desktop client surface with a sidebar,
status cards, recent activity, and a compact pipeline stepper. A collapsible
profile management panel still exposes the workflows needed to exercise the MVP:

- Run, prepare, validate, promote, and apply a profile pipeline.
- Save and load non-secret profile settings.
- Import Clash Party profile metadata and override selections.
- Manage subscription update schedules for the current app session.
- Start and stop the Mihomo core.
- Read controller health, traffic, connections, proxy groups, rules, and delays.
- Connect and disconnect with Windows system proxy rollback.
- Stream controller logs and export redacted failure reports.

For lower-level package, IPC, state, and integration-test details, see
[`docs/mvp-architecture.md`](docs/mvp-architecture.md).

## Repository Layout

```text
src/main                  Electron main process, IPC, state, runtime services
src/preload               Isolated preload bridge
src/renderer              React renderer
packages/config-pipeline  Subscription, overrides, sanitize, render pipeline
packages/core-runtime     Config store, validation, core process, controller API
assets/icons              Windows app/tray/glyph assets and reserved macOS icons
```

## Package APIs

`@mioproxy/config-pipeline` exports:

- `downloadSubscription` - fetches a subscription with timeout/retry and falls
  back to stale cache when the network fails.
- `parseYamlToObject` / `stringifyStableYaml` - YAML object parsing and stable
  serialization.
- `applyYamlOverride` - Clash Party-style deep merge with `key!`, `+key`, and
  `key+` support.
- `runJsOverride` - executes `main(config)` in a limited VM context with a
  timeout.
- `sanitizeMihomoConfig` - removes deprecated/dangerous fields and downgrades
  Smart/relay groups for stable-core compatibility.
- `renderProfile` - orchestrates subscription download, YAML parsing, ordered
  YAML/JS overrides, compatibility sanitize, and stable YAML rendering. Failures
  include a stage name and override id when applicable.

`@mioproxy/core-runtime` exports:

- `createConfigStore` - writes `candidate.yaml`, promotes `active.yaml`, tracks
  `last-known-good.yaml`, and rolls back from it.
- `checkMihomoConfig` - runs the `mihomo -t -f <config> -d <workdir>` contract
  through an injectable command runner.
- `startMihomoCore` - starts a long-lived Mihomo process with
  `mihomo -d <workdir> -f <active.yaml>`, attaches stdout/stderr to the core log
  collector, and supports graceful stop with SIGTERM/SIGKILL fallback.
- `createControllerClient` - calls Mihomo external-controller with a required
  Bearer secret, supports reload/restart, runtime observation, proxy group
  reads and switches, delay checks, rules reads, and rejects `0.0.0.0`
  controller addresses.
- `renderAndStage` - accepts an injected renderer, writes rendered YAML to
  `candidate.yaml`, and keeps `active.yaml` untouched until validation and
  promotion.
- `validateCandidate` - runs offline validation against `candidate.yaml` and
  returns stdout/stderr without changing `active.yaml`.
- `promoteValidatedCandidate` - promotes `candidate.yaml` to `active.yaml` only
  when offline validation succeeded.
- `applyActiveConfig` - applies `active.yaml` through the controller. It tries
  hot reload first, falls back to restart, marks `last-known-good.yaml` only
  after a successful apply, and rolls back when both apply paths fail.
- `renderValidatePromoteAndApply` - the full pipeline entrypoint. It writes
  `candidate.yaml`, runs the offline check, promotes `active.yaml`, applies
  through the controller, and returns the first failed stage with intermediate
  results.
- `saveFailureBundle` - writes a redacted `failure.json` for failed pipeline
  runs. It records structured stage/error metadata and command/controller
  outputs without writing raw subscription or rendered config contents.
- `exportFailureReport` - creates a user-shareable diagnostics directory from a
  managed failure bundle, recent core logs, and compact run history.
- `runProfilePipeline` - application-level entrypoint around the full pipeline.
- `parseProcessLogLine` / `parseControllerLogMessage` - normalize process and
  controller log messages into `CoreLogEvent`.
- `createCoreLogStore` - append-only JSONL store for normalized core log events
  under `logs/core/<profileId>.jsonl`.
- `createProcessLogCollector` - attaches to Mihomo stdout/stderr streams and
  appends normalized lines to the core log store.

## Electron IPC

The preload bridge exposes `window.mioproxy` APIs for:

- Pipeline: `runProfilePipeline`, `prepareProfile`, `listPipelineHistory`,
  `exportFailureReport`.
- Profile settings: `loadProfileSettings`, `saveProfileSettings`.
- Subscription schedules: `loadSubscriptionSchedule`,
  `saveSubscriptionSchedule`, `tickSubscriptionSchedule`,
  `armSubscriptionSchedule`, `disarmSubscriptionSchedule`,
  `getSubscriptionScheduleRuntimeStatus`.
- Clash Party import and overrides: `importClashParty`, `getOverrideSettings`,
  `setOverrideSelection`.
- Controller reads and actions: `checkControllerHealth`,
  `getControllerObservations`, `getControllerProxies`,
  `switchControllerProxy`, `testControllerProxyDelay`, `getControllerRules`.
- Core runtime: `startCore`, `stopCore`, `getCoreStatus`.
- Controller logs: `startControllerLogs`, `stopControllerLogs`,
  `getControllerLogStatus`, `listCoreLogs`.
- Windows system proxy: `getSystemProxyStatus`, `enableSystemProxy`,
  `disableSystemProxy`, `restoreSystemProxy`.
- Activation: `connectProfile`, `disconnectProfile`, `getActivationStatus`.

The main process injects `config-pipeline.renderProfile` into
`core-runtime.runProfilePipeline`, stores raw subscription cache under
`profiles/<profileId>/raw.yaml`, and writes failure bundles under
`logs/bundles`.

## State And Secret Handling

- Pipeline history is persisted to `state/pipeline-history.json`.
- Profile settings are persisted under `state/profiles/<profileId>.json`.
- Subscription schedules are persisted under `state/subscription-schedules.json`.
- Imported override metadata is persisted under `state/overrides.json`.
- Core logs are stored under `logs/core/<profileId>.jsonl`.
- Failure reports are exported under `logs/exports`.

Controller secrets are never persisted by the profile store or schedule store.
Subscription URLs are stored without query or hash components. Scheduled updates
use the current renderer-supplied pipeline input for the active app session.

## Optional Integration Tests

Optional local integration tests can validate migration against a real Clash
Party data directory and a real Mihomo binary without writing to the source
directory:

- Run `pnpm build`, then set `MIOPROXY_ELECTRON_SMOKE=1` and run
  `pnpm exec vitest run src/main/electronSmoke.integration.test.ts` to launch a
  hidden production Electron window against a temporary userData directory.
- Set `MIOPROXY_CLASH_PARTY_SOURCE` and run `pnpm test:integration:import` to
  run read-only import validation.
- Set both `MIOPROXY_CLASH_PARTY_SOURCE` and `MIOPROXY_MIHOMO_BINARY`, then run
  `pnpm test:integration:cache` to render from imported cache and validate with
  `mihomo -t`.
- With both variables set, run `pnpm test:integration:connection` to promote
  `active.yaml`, start a real core, and check controller health on temporary
  loopback ports without changing the system proxy.
- Set `MIOPROXY_TEST_SYSTEM_PROXY=1` only when you intentionally want to mutate
  and restore the current Windows user proxy settings in an integration test.

## CI

Pushes to `main`, pull requests, and manual runs execute:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm test:integration:local
pnpm build
pnpm pack:win
```

The local integration script skips tests when the required environment variables
are absent. It performs real import/cache/core validation when
`MIOPROXY_CLASH_PARTY_SOURCE` and `MIOPROXY_MIHOMO_BINARY` are set.

Pushes to `main` and manual CI runs upload an unpacked Windows app artifact named
`MioProxy-win-unpacked-<commit>`. Pull request runs validate packaging but do
not upload artifacts.

Version tags matching `v*` run the release workflow. It validates the same MVP
checks, builds a Windows zip with `pnpm release:win`, uploads it as a workflow
artifact, and attaches it to a GitHub Release.

## Security Notes

- `active.yaml` must be generated through the render pipeline, not edited
  directly.
- Controller requests must use `Authorization: Bearer <secret>`.
- The controller must not bind to `0.0.0.0` by default.
- Profile settings must not persist controller secrets.
- Subscription schedules must not persist controller secrets or raw subscription
  tokens.
- Clash Party import must not copy override script contents or controller
  secrets.
- System proxy changes must snapshot the previous user WinINET proxy state and
  provide a restore path.
- Smart-related behavior is treated as compatibility downgrade unless a future
  explicit experimental mode enables it.
- SVG assets must not include scripts, event handlers, external resource
  references, embedded data URIs, or secrets.

## Contributing Focus

The highest-value contributions right now are:

- More pipeline edge-case tests.
- Better diagnostics for failed Mihomo validation or controller apply.
- UI improvements that make the existing safety model easier to understand.
- Windows packaging polish before signed installer/update work.
- Documentation for real-world migration from Clash Party profiles.
