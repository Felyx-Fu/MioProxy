# Contributing to MioProxy

Thanks for your interest in contributing to MioProxy.

MioProxy is an early Windows-first Mihomo desktop controller. The current focus is stability, safe configuration promotion, rollback behavior, diagnostics, and a clean desktop UI.

## Current Priorities

High-value contributions include:

- Pipeline edge-case tests.
- Better diagnostics for failed Mihomo validation.
- UI improvements that make runtime state easier to understand.
- Windows packaging polish.
- Documentation for migration from Clash Party profiles.

## Development Setup

Requirements:

- Windows is recommended for runtime testing.
- Node.js compatible with the project setup.
- pnpm 11.7.0.
- A Mihomo binary for integration testing.

Install dependencies:

```bash
pnpm installRun checks:

pnpm lint
pnpm test
pnpm build

Run the app in development:

pnpm dev
```
Pull Request Guidelines

Before opening a pull request, please make sure:

The change has a clear purpose.
Existing business logic is not removed accidentally.
Secrets, subscription URLs, tokens, and raw user configs are not committed.
pnpm lint, pnpm test, and pnpm build pass.
UI changes include screenshots when possible.
Runtime changes include tests when possible.
Code Style
Prefer TypeScript.
Keep business logic separated from UI components.
Do not persist controller secrets.
Do not bind the controller to 0.0.0.0 by default.
Generated files such as active.yaml should not be edited directly.
License Notes

MioProxy is licensed under the Apache License 2.0.

Do not copy source code, icons, logos, CSS, or other copyrighted resources from GPL projects such as Clash Party or Clash Verge Rev unless the licensing impact is explicitly reviewed.

