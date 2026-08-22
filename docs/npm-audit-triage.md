# npm audit high/critical triage

This record is for MioProxy 0.9.2. It is based on the locked install and
`npm audit --json` from the closeout worktree. No `npm audit fix` was run.

The production gate is:

```text
npm audit --omit=dev --audit-level=high
```

It reports zero production vulnerabilities. The high and critical findings in
the full audit are development-tool findings and do not enter the shipped
Tauri runtime:

| package and dependency path | severity | affected version | fixed version | production/dev scope | runtime reachability | release impact |
| --- | --- | --- | --- | --- | --- | --- |
| `vite@5.4.21`, nested through `vitest@2.1.9` (`vitest -> vite-node -> vite` and `vitest -> @vitest/mocker -> vite`) | high | `<=6.4.2` for the `server.fs.deny` alternate-path bypass | `vite@6.4.3` | dev only; the direct build Vite is `6.4.3` | reachable only in the Vitest/Vite development-server dependency surface; the shipped build does not include it | not a production release blocker; retain the high-level production audit gate and review the Vitest major upgrade separately |
| `vitest@2.1.9` direct dev dependency | critical | `<3.2.6` for the Vitest UI server arbitrary-file-read/execute issue (`<=3.2.5` in the audit range) | `vitest@3.2.6` or later; the current npm remediation proposal is `4.1.11` and is a SemVer-major upgrade | dev only | the current `test:ui` script runs `vitest run`, not the UI/Browser Mode server; no Vitest server is shipped or started by MioProxy | not a production release blocker; do not take the major upgrade blindly because it changes the test toolchain |

The direct root `vite@6.4.3` is outside the high advisory range. `npm ls`
confirms the vulnerable Vite copies are nested under Vitest. The current
package scripts build with the fixed direct Vite and run Vitest in non-server
mode. A developer who intentionally exposes Vitest UI/Browser Mode or the
nested Vite server still has to upgrade the development toolchain before
using that mode on an untrusted network.

The full audit also reports three moderate development findings. They are not
high/critical release gates, but they remain visible to developers in the
normal full audit. The CI release and signed-RC workflows deliberately gate
the production dependency graph with `npm audit --omit=dev --audit-level=high`;
they do not suppress production findings and do not run an automatic fix.

Advisories:

- Vite `server.fs.deny` bypass: <https://github.com/advisories/GHSA-fx2h-pf6j-xcff>
- Vitest UI server arbitrary file read/execute: <https://github.com/advisories/GHSA-5xrq-8626-4rwp>
