# MioProxy

Windows-first Mihomo desktop controller.

The first milestone is intentionally narrow: build a deterministic configuration
pipeline before adding complex UI, TUN, Smart Core defaults, or updater logic.

## MVP Pipeline

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

## Repository Layout

- `src/main` - Electron main process.
- `src/preload` - isolated preload bridge.
- `src/renderer` - React renderer.
- `packages/config-pipeline` - subscription download, YAML parsing, override
  execution, Mihomo sanitizer.
- `packages/core-runtime` - config store, offline checker, future core manager.
- `assets/icons/Win` - Windows app, tray, and glyph SVG assets.
- `assets/icons/Mac` - reserved for future macOS support.

## Current Package APIs

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
  `candidate.yaml`, and keeps `active.yaml` untouched until a later validation
  and promote step.
- `validateCandidate` - runs offline validation against `candidate.yaml` via
  the `mihomo -t -f <candidate> -d <workdir>` contract and returns stdout/stderr
  without changing `active.yaml`.
- `promoteValidatedCandidate` - promotes `candidate.yaml` to `active.yaml` only
  when offline validation succeeded. It does not update `last-known-good.yaml`;
  that is reserved for a later successful reload/restart step.
- `applyActiveConfig` - applies `active.yaml` through the controller. It tries
  hot reload first, falls back to controller restart, marks `last-known-good.yaml`
  only after a successful apply, and rolls back to the previous
  `last-known-good.yaml` when both apply paths fail.
- `renderValidatePromoteAndApply` - the current full pipeline entrypoint. It
  receives an injected renderer, writes `candidate.yaml`, runs the offline check,
  promotes `active.yaml`, applies through the controller, and returns the first
  failed stage with collected intermediate results.
- `saveFailureBundle` - writes a redacted `failure.json` for failed pipeline
  runs. The current bundle records structured stage/error metadata and command
  or controller outputs; it does not write raw subscription or rendered config
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

## Electron Integration

The main process registers a minimal IPC command:

- `pipeline:run-profile` - exposed to the renderer as
  `window.mioproxy.runProfilePipeline(input)`.
  It renders, validates, promotes, and applies through an already reachable
  Mihomo controller.
- `pipeline:prepare-profile` - exposed as `window.mioproxy.prepareProfile(input)`.
  It renders, validates, and promotes `active.yaml` without calling the
  controller. Connect uses this path before starting the core, which avoids a
  first-run dependency on an already running controller.
- `pipeline:list-history` - exposed as `window.mioproxy.listPipelineHistory()`.
- `pipeline:list-core-logs` - exposed as `window.mioproxy.listCoreLogs(profileId)`.
- `pipeline:export-failure-report` - exposed as
  `window.mioproxy.exportFailureReport({ historyId })` and creates a redacted
  problem report for a failed history record.
- `profile-settings:load` - exposed as
  `window.mioproxy.loadProfileSettings(profileId)`.
- `profile-settings:save` - exposed as
  `window.mioproxy.saveProfileSettings(input)`. It persists non-secret profile
  settings only.
- `subscription-schedule:load` - exposed as
  `window.mioproxy.loadSubscriptionSchedule(profileId)`.
- `subscription-schedule:save` - exposed as
  `window.mioproxy.saveSubscriptionSchedule(input)`. It persists only schedule
  enabled state, interval, next run time, and the last result.
- `subscription-schedule:tick` - exposed as
  `window.mioproxy.tickSubscriptionSchedule(input)`. It runs the safe prepare
  path when due or forced by the UI; the renderer must provide the current
  pipeline input so controller secrets are not stored.
- `subscription-schedule:arm` / `subscription-schedule:disarm` - exposed as
  `window.mioproxy.armSubscriptionSchedule(input)` and
  `window.mioproxy.disarmSubscriptionSchedule(profileId)`. Arming keeps the
  current pipeline input in main-process memory only, allowing the background
  timer to run due updates during this app session.
- `subscription-schedule:runtime-status` - exposed as
  `window.mioproxy.getSubscriptionScheduleRuntimeStatus(profileId)`.
- `clash-party:import` - exposed as `window.mioproxy.importClashParty(input)`.
  It reads Clash Party `profile.yaml`, `override.yaml`, `config.yaml`, and
  `mihomo.yaml`, then imports MioProxy profile settings, old profile cache, and
  override metadata.
- `overrides:get-state` - exposed as `window.mioproxy.getOverrideSettings()`.
  It returns imported override metadata plus selected override ids per profile.
- `overrides:set-selection` - exposed as
  `window.mioproxy.setOverrideSelection(input)` and persists which imported
  overrides should apply to a profile.
- `controller-health:check` - exposed as
  `window.mioproxy.checkControllerHealth(input)` and reads Mihomo `/version`
  plus `/configs` through authenticated controller requests.
- `controller-observation:snapshot` - exposed as
  `window.mioproxy.getControllerObservations(input)` and reads Mihomo
  `/traffic` plus `/connections` through authenticated controller requests.
- `controller-proxies:snapshot` - exposed as
  `window.mioproxy.getControllerProxies(input)` and reads Mihomo `/proxies`
  through authenticated controller requests.
- `controller-proxies:switch` - exposed as
  `window.mioproxy.switchControllerProxy(input)` and switches a strategy group
  through authenticated `PUT /proxies/{name}`.
- `controller-proxies:delay` - exposed as
  `window.mioproxy.testControllerProxyDelay(input)` and runs an authenticated
  `/proxies/{name}/delay` check for a single proxy.
- `controller-rules:snapshot` - exposed as
  `window.mioproxy.getControllerRules(input)` and reads `/rules` plus
  `/providers/rules` through authenticated controller requests.
- `core:start` - exposed as `window.mioproxy.startCore(input)` and starts the
  generated `active.yaml` for a profile.
- `core:stop` - exposed as `window.mioproxy.stopCore(profileId)`.
- `core:status` - exposed as `window.mioproxy.getCoreStatus(profileId)`.
- `controller-logs:start` - exposed as
  `window.mioproxy.startControllerLogs(input)` and streams Mihomo `/logs` into
  the core log store.
- `controller-logs:stop` - exposed as
  `window.mioproxy.stopControllerLogs(profileId)`.
- `controller-logs:status` - exposed as
  `window.mioproxy.getControllerLogStatus(profileId)`.
- `system-proxy:status` - exposed as `window.mioproxy.getSystemProxyStatus()`.
- `system-proxy:enable` - exposed as `window.mioproxy.enableSystemProxy(input)`.
  It stores the current WinINET proxy snapshot before changing user settings.
- `system-proxy:disable` - exposed as `window.mioproxy.disableSystemProxy()`.
- `system-proxy:restore` - exposed as `window.mioproxy.restoreSystemProxy()`
  and restores the managed snapshot saved before enable.
- `activation:connect` - exposed as `window.mioproxy.connectProfile(input)`.
  It starts the core, waits for controller health, starts controller log
  collection, and enables the Windows system proxy in that order.
- `activation:disconnect` - exposed as
  `window.mioproxy.disconnectProfile(profileId)`. It restores system proxy
  state, stops controller logs, and stops the core.
- `activation:status` - exposed as `window.mioproxy.getActivationStatus(profileId)`.

The IPC handler uses `src/main/pipeline/profilePipelineService.ts` to inject
`config-pipeline.renderProfile` into `core-runtime.runProfilePipeline`, store raw
subscription cache under `profiles/<profileId>/raw.yaml`, and write failure
bundles under `logs/bundles`.

The renderer currently includes a minimal manual run panel for the same command.
Its form state is converted to typed IPC input by
`src/renderer/src/pipelineForm.ts`.

Pipeline run summaries are persisted to `state/pipeline-history.json` and exposed
through `window.mioproxy.listPipelineHistory()`. History records store profile,
stage, mode, bundle path, and subscription host only; controller secrets and full
subscription URLs are not persisted.

Profile settings are persisted under `state/profiles/<profileId>.json`. They
store subscription URL without query/hash secrets, Mihomo paths, controller URL,
and system proxy defaults. Controller secrets are never saved by this store.
Subscription update schedules are persisted under
`state/subscription-schedules.json`. They store profile id, enabled state,
interval, next run time, and last update result only; the subscription update
tick still requires the current in-memory pipeline input from the renderer.
When the renderer saves an enabled schedule, or forces an update while the saved
schedule is enabled, it arms that profile for the current app session with the
current form input. After an app restart, the persisted schedule remains, but it
will not run in the background until the renderer arms it again; this avoids
persisting controller secrets.
The Clash Party importer is read-only against the source directory. It does not
copy override file contents or controller secrets. Imported override metadata is
stored under `state/overrides.json`; during a pipeline run, MioProxy materializes
global override files plus the override files selected for the active profile,
preserves their Clash Party order, and passes them into the render pipeline
before writing `candidate.yaml`. Existing Clash Party profile YAML cache is
imported into `profiles/<profileId>/raw.yaml`, so the pipeline can continue from
old cache when the subscription URL cannot be fetched.

Core logs are currently read on demand from `logs/core/<profileId>.jsonl` and
shown in the renderer log panel. The renderer can also check controller health
through `/version` and `/configs`, and can read traffic plus connection
snapshots through `/traffic` and `/connections`, without persisting the
controller secret. Proxy group status is read on demand through `/proxies`,
summarizing group type, current selection, and available option counts. Strategy
group switching is explicit and request-scoped; the controller secret is not
persisted. Proxy delay checks are also request-scoped and clamp timeout values
before calling Mihomo. Rule and rule-provider summaries are read on demand from
the controller and are not persisted.
Process stdout/stderr collection is wired into the main-process core manager.
Controller `/logs?format=structured&level=info` streaming is wired into the same
event store with Bearer authentication. Windows system proxy management writes
only current-user WinINET registry values and keeps a managed snapshot for
restore. Activation connect/disconnect composes core process, controller health,
controller logs, and system proxy steps with reverse-order rollback on failure.
Failed history records can export a problem report under `logs/exports` with
redacted failure metadata, compact history, and recent core log events.
The main process stops running cores and controller log collectors during app
quit before allowing Electron to exit.

Optional local integration tests can validate migration against a real Clash
Party data directory and a real Mihomo binary without writing to the source
directory:

- Run `pnpm build`, then set `MIOPROXY_ELECTRON_SMOKE=1` and run
  `pnpm exec vitest run src/main/electronSmoke.integration.test.ts` to launch a
  hidden production Electron window against a temporary userData directory. The
  smoke check verifies that the Electron Vite production renderer loads, the
  renderer CSS bundle is applied, the subscription schedule UI is present, and
  the preload `window.mioproxy` bridge is available.
- Set `MIOPROXY_CLASH_PARTY_SOURCE` to run read-only import validation.
- Set both `MIOPROXY_CLASH_PARTY_SOURCE` and `MIOPROXY_MIHOMO_BINARY` to render
  from imported cache, run `mihomo -t`, promote `active.yaml` through the
  prepare path, start a real core, and check controller health on temporary
  loopback ports. These tests skip system proxy mutation by default and also
  validate controller log streaming.
- Set `MIOPROXY_TEST_SYSTEM_PROXY=1` only when you intentionally want to mutate
  and restore the current Windows user proxy settings in an integration test.

## Commands

- `pnpm install`
- `pnpm lint`
- `pnpm test`
- `pnpm build`

## Security Notes

- `active.yaml` must be generated through the render pipeline, not edited directly.
- Controller requests must use `Authorization: Bearer <secret>`.
- The controller must not bind to `0.0.0.0` by default.
- Profile settings must not persist controller secrets. Subscription URLs are
  stored without query or hash components.
- Subscription schedules must not persist controller secrets or raw subscription
  tokens; scheduled updates use the current renderer-supplied pipeline input.
- Clash Party import must not copy override script contents or controller
  secrets; imported override data is metadata for review.
- System proxy changes must snapshot the previous user WinINET proxy state and
  provide a restore path.
- Smart-related behavior is treated as compatibility downgrade unless a future
  explicit experimental mode enables it.
- SVG assets are static vector files and should not include scripts, event
  handlers, external resource references, embedded data URIs, or secrets.
