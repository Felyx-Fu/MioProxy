# MioProxy MVP Architecture

This document keeps the lower-level MVP contract out of the README while
preserving the details needed by contributors working on the pipeline, runtime,
IPC, and migration paths.

## Configuration Pipeline

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

`active.yaml` must be generated through the render pipeline. User or developer
edits should target subscription input, imported overrides, or pipeline inputs.

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
  Bearer secret. It supports `PUT /configs?force=true` for reload and
  `POST /restart` for controller restart, reads `/traffic` and `/connections`
  snapshots for runtime observation, reads `/proxies` for proxy group status,
  switches proxy groups through `PUT /proxies/{name}`, runs proxy delay checks
  through `/proxies/{name}/delay`, reads `/rules` and `/providers/rules`, and
  rejects `0.0.0.0` controller addresses.
- `renderAndStage` - accepts an injected renderer, writes rendered YAML to
  `candidate.yaml`, and keeps `active.yaml` untouched until validation and
  promotion.
- `validateCandidate` - runs offline validation against `candidate.yaml` via
  the `mihomo -t -f <candidate> -d <workdir>` contract and returns
  stdout/stderr without changing `active.yaml`.
- `promoteValidatedCandidate` - promotes `candidate.yaml` to `active.yaml` only
  when offline validation succeeded. It does not update `last-known-good.yaml`;
  that is reserved for a later successful reload/restart step.
- `applyActiveConfig` - applies `active.yaml` through the controller. It tries
  hot reload first, falls back to controller restart, marks `last-known-good.yaml`
  only after a successful apply, and rolls back to the previous
  `last-known-good.yaml` when both apply paths fail.
- `renderValidatePromoteAndApply` - the full pipeline entrypoint. It receives an
  injected renderer, writes `candidate.yaml`, runs the offline check, promotes
  `active.yaml`, applies through the controller, and returns the first failed
  stage with collected intermediate results.
- `saveFailureBundle` - writes a redacted `failure.json` for failed pipeline
  runs. The bundle records structured stage/error metadata and command or
  controller outputs; it does not write raw subscription or rendered config
  contents.
- `exportFailureReport` - creates a user-shareable diagnostics directory from a
  managed failure bundle, recent core logs, and compact run history. It refuses
  bundle paths outside MioProxy's diagnostics directory.
- `runProfilePipeline` - application-level entrypoint around the full pipeline.
  It returns successful apply results directly and saves a redacted failure
  bundle automatically when the pipeline fails.
- `parseProcessLogLine` / `parseControllerLogMessage` - normalize process
  stdout/stderr and Mihomo controller log messages into `CoreLogEvent`.
- `createCoreLogStore` - append-only JSONL store for normalized core log events
  under `logs/core/<profileId>.jsonl`.
- `createProcessLogCollector` - attaches to Mihomo stdout/stderr streams,
  normalizes lines through `parseProcessLogLine`, and appends them to the core
  log store.

## Electron IPC

The preload bridge exposes these `window.mioproxy` APIs:

- `runProfilePipeline(input)` - renders, validates, promotes, and applies
  through an already reachable Mihomo controller.
- `prepareProfile(input)` - renders, validates, and promotes `active.yaml`
  without calling the controller. Connect uses this path before starting the
  core, avoiding a first-run dependency on an already running controller.
- `listPipelineHistory()` - reads persisted pipeline summaries.
- `listCoreLogs(profileId)` - reads normalized core log events.
- `exportFailureReport({ historyId })` - creates a redacted problem report for a
  failed history record.
- `loadProfileSettings(profileId)` / `saveProfileSettings(input)` - read and
  write non-secret profile settings.
- `loadSubscriptionSchedule(profileId)` / `saveSubscriptionSchedule(input)` -
  persist schedule enabled state, interval, next run time, and last result.
- `tickSubscriptionSchedule(input)` - runs the safe prepare path when due or
  forced by the UI. The renderer must provide current pipeline input so
  controller secrets are not stored.
- `armSubscriptionSchedule(input)` / `disarmSubscriptionSchedule(profileId)` -
  keep current pipeline input in main-process memory for this app session.
- `getSubscriptionScheduleRuntimeStatus(profileId)` - reports whether a schedule
  is armed in the current process.
- `importClashParty(input)` - reads Clash Party `profile.yaml`,
  `override.yaml`, `config.yaml`, and `mihomo.yaml`, then imports MioProxy
  profile settings, old profile cache, and override metadata.
- `getOverrideSettings()` / `setOverrideSelection(input)` - read imported
  override metadata and persist which imported overrides apply to a profile.
- `checkControllerHealth(input)` - reads Mihomo `/version` plus `/configs`
  through authenticated controller requests.
- `getControllerObservations(input)` - reads `/traffic` plus `/connections`
  through authenticated controller requests.
- `getControllerProxies(input)` - reads `/proxies`.
- `switchControllerProxy(input)` - switches a strategy group through
  authenticated `PUT /proxies/{name}`.
- `testControllerProxyDelay(input)` - runs an authenticated
  `/proxies/{name}/delay` check for a single proxy.
- `getControllerRules(input)` - reads `/rules` plus `/providers/rules`.
- `startCore(input)` / `stopCore(profileId)` / `getCoreStatus(profileId)` -
  manage the generated `active.yaml` for a profile.
- `startControllerLogs(input)` / `stopControllerLogs(profileId)` /
  `getControllerLogStatus(profileId)` - stream Mihomo `/logs` into the core log
  store.
- `getSystemProxyStatus()` / `enableSystemProxy(input)` /
  `disableSystemProxy()` / `restoreSystemProxy()` - manage current-user WinINET
  proxy settings with a managed snapshot.
- `connectProfile(input)` - starts the core, waits for controller health, starts
  controller log collection, and enables the Windows system proxy in that order.
- `disconnectProfile(profileId)` - restores system proxy state, stops controller
  logs, and stops the core.
- `getActivationStatus(profileId)` - reports the composed activation state.

The IPC handlers use `src/main/pipeline/profilePipelineService.ts` to inject
`config-pipeline.renderProfile` into `core-runtime.runProfilePipeline`, store raw
subscription cache under `profiles/<profileId>/raw.yaml`, and write failure
bundles under `logs/bundles`.

## State And Secret Handling

Pipeline run summaries are persisted to `state/pipeline-history.json` and
exposed through `window.mioproxy.listPipelineHistory()`. History records store
profile, stage, mode, bundle path, and subscription host only; controller
secrets and full subscription URLs are not persisted.

Profile settings are persisted under `state/profiles/<profileId>.json`. They
store subscription URL without query/hash secrets, Mihomo paths, controller URL,
and system proxy defaults. Controller secrets are never saved by this store.

Subscription update schedules are persisted under
`state/subscription-schedules.json`. They store profile id, enabled state,
interval, next run time, and last update result only. The subscription update
tick still requires the current in-memory pipeline input from the renderer.
After an app restart, the persisted schedule remains, but it will not run in the
background until the renderer arms it again; this avoids persisting controller
secrets.

The Clash Party importer is read-only against the source directory. It does not
copy override file contents or controller secrets. Imported override metadata is
stored under `state/overrides.json`; during a pipeline run, MioProxy materializes
global override files plus the override files selected for the active profile,
preserves their Clash Party order, and passes them into the render pipeline
before writing `candidate.yaml`. Existing Clash Party profile YAML cache is
imported into `profiles/<profileId>/raw.yaml`, so the pipeline can continue from
old cache when the subscription URL cannot be fetched.

Core logs are read on demand from `logs/core/<profileId>.jsonl`. Controller
health, traffic, connection snapshots, proxy group status, proxy switching,
proxy delay checks, rule summaries, and rule-provider summaries are all
request-scoped and use Bearer authentication without persisting the controller
secret.

Windows system proxy management writes only current-user WinINET registry values
and keeps a managed snapshot for restore. Activation connect/disconnect composes
core process, controller health, controller logs, and system proxy steps with
reverse-order rollback on failure.

Failed history records can export a problem report under `logs/exports` with
redacted failure metadata, compact history, and recent core log events. The main
process stops running cores and controller log collectors during app quit before
allowing Electron to exit.

## Optional Integration Tests

Optional local integration tests can validate migration against a real Clash
Party data directory and a real Mihomo binary without writing to the source
directory:

- Run `pnpm build`, then set `MIOPROXY_ELECTRON_SMOKE=1` and run
  `pnpm exec vitest run src/main/electronSmoke.integration.test.ts` to launch a
  hidden production Electron window against a temporary userData directory. The
  smoke check verifies that the Electron Vite production renderer loads, the
  renderer CSS bundle is applied, the subscription schedule UI is present, and
  the preload `window.mioproxy` bridge is available.
- Set `MIOPROXY_CLASH_PARTY_SOURCE` and run `pnpm test:integration:import` to
  run read-only import validation.
- Set both `MIOPROXY_CLASH_PARTY_SOURCE` and `MIOPROXY_MIHOMO_BINARY`, then run
  `pnpm test:integration:cache` to render from imported cache and validate with
  `mihomo -t`.
- With both variables set, run `pnpm test:integration:connection` to promote
  `active.yaml`, start a real core, check controller health on temporary
  loopback ports, and validate controller log streaming. This path skips system
  proxy mutation by default.
- Run `pnpm test:integration:local` with both variables set to execute the
  import, cache validation, and real core health checks together.
- Set `MIOPROXY_TEST_SYSTEM_PROXY=1` only when you intentionally want to mutate
  and restore the current Windows user proxy settings in an integration test.
