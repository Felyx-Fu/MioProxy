# MioProxy UI implementation QA

## Source and implementation evidence

- Reproducible fixture: `ui-smoke.html`, backed by the deny-by-default Tauri IPC mock in `src/ui-smoke.tsx`.
- Exact viewport wrappers: `ui-qa-frame.html` (1180 × 760) and `ui-qa-frame-compact.html` (960 × 650).
- Start the Vite-only preview with `npm run dev`; do not use `tauri dev` for this visual smoke because native startup performs runtime recovery.
- Benchmark boards and captured comparison images are retained as local task artifacts and intentionally are not referenced by machine-specific paths here.

The written contract takes precedence over low-fidelity mock fields. The implementation therefore adds the required Mio Path rail, omits the unavailable Logs Module column, and shows no persisted Active Profile until a backend read contract exists.

## Viewports and runtime boundary

| Check | Measured viewport | Result |
| --- | ---: | --- |
| Primary desktop | 1180 × 760 CSS px | Overview, Proxies, Profiles, Connections, Rules, Logs and Settings rendered with the invariant seven-part Status Bar and no document/main horizontal overflow. |
| Compact desktop | 960 × 650 CSS px | All seven workspaces rendered with the 52 px rail, all seven Status Bar segments visible in fixed order, and no document/main horizontal overflow. Connections used an explicitly opened overlay inspector. |
| Browser console | Direct clean mock session | Zero warning/error entries. |
| IPC safety | Browser-only Tauri mock | Zero blocked mutation attempts; no Service, Mihomo, System Proxy or TUN process was contacted. |

The inner frame measurements were exactly 1180 × 760 and 960 × 650 CSS px at device pixel ratio 1.5. Final evidence files were captured from those frame bounds and independently verified as 1180 × 760 or 960 × 650 pixels. The current compact Overview was normalized from its 1440 × 975 device-pixel capture to the matching 960 × 650 CSS target before comparison.

The visual fixture uses local, browser-only Tauri IPC mocks. Native Tauri startup was deliberately not used because application setup can recover or change real System Proxy/TUN/Core state. The production window uses a custom HTML caption (`decorations: false`) backed by Win32 hit testing and system-menu integration, so Snap, resize, system menu and hide-to-tray semantics remain native rather than being replaced by an unverified browser caption. The caption visible in browser evidence is explicitly preview-only.

## Full-view comparison

- Shell geometry matches the approved hierarchy: caption, compact left navigation, workspace and 26 px runtime Status Bar.
- Navigation order is Overview, Proxies, Profiles, Connections, Rules and Logs, with Settings pinned to the bottom.
- The visual system uses Segoe UI Variable/System, Cascadia Mono for logs/editors, neutral light surfaces, a single blue accent, 4–8 px radii and border-led grouping without gradients or glass effects.
- Overview replaces the former KPI/card wall with Connection Health, truthful Profile state, Mio Path and one traffic graph.
- Proxies and Profiles use master-detail layouts. Connections and Logs use compact comparable rows. Settings uses a category rail and searchable setting rows.
- Unsupported target data is not fabricated: proxy endpoints/ports, Profile quota, Active Profile and Log Module are omitted or rendered as unavailable.

## Focused region and interaction evidence

The Proxies evidence shows the selected row, group master list, compact node table, detail strip and a keyboard-focused context menu. Context actions mirror visible commands: Inspect, Use node and Test latency. Connections exposes Inspect and Close connection in the same pattern.

Verified interactions:

- `Ctrl+1…6`, `Ctrl+,` and scoped `Ctrl+F`.
- Proxy search reduced the fixture table to the three matching `US-0` rows.
- Proxy/Connections row selection via keyboard; Enter activates a selected proxy row and Delete is wired to a selected connection.
- Logs Pause/Resume freezes the visible snapshot in the root store while the bounded listener continues buffering; navigating away and back retained all 14 frozen fixture rows, and Auto-scroll can be disabled independently.
- Compact Connections starts with no inspector open. Selecting a row opens the overlay, the inspector close control is separate from the labelled destructive connection action, and Escape closes only the inspector without invoking IPC.
- Settings category navigation and cross-category search (`update` returned only the Updates section).
- Confirm dialog initial focus, Escape dismissal, focus containment and restoration.
- Row context menus close on Escape/outside pointer and expose no context-only command.

## Iteration history

1. Replaced the dark cyber/glass shell, 236 px ten-route sidebar, KPI card wall, node chips and terminal chrome with the approved calm desktop structure and tokens.
2. Hoisted Logs and TUN runtime state, added the invariant Status Bar, separated selected versus applied-this-session Profile state, and blocked implicit takeover of externally owned Proxy/TUN state.
3. Compared the first six screenshots against the source board. Reduced Connections table minimum width to remove horizontal drift, constrained its detail pane, and verified the 52 px compact rail at 960 × 650.
4. Added truthful unavailable latency states, right-click menus, dialog keyboard behavior, log-clear behavior while paused, and session-persistent appearance selection.
5. Rebuilt and repeated clean-browser six-page capture with zero console issues and zero mock mutation attempts.
6. Closed the final review findings: external System Proxy projection now prioritizes external ownership, the backend refuses takeover atomically while holding the transition lock, Logs pause state survives page unmounts, proxy commands have an in-flight guard, compact Status Bar keeps all seven segments, and the Connections inspector has safe close semantics.
7. Re-captured every primary workspace plus Settings at exact 1180 × 760 and 960 × 650 bounds, including Profiles, Rules and Logs in compact mode.
8. Closed the contract audit: daily totals use Today semantics, TUN recovery presents a disable/restore action without enable-only prerequisites, external routes stop at the ownership boundary, Profile deletion preserves concurrent additions, filtered Rules retain configured precedence, and proxy details mirror unavailable/not-tested state. Added select focus treatment, a scroll fallback for zoomed viewports, and guarded recovery for partial System Proxy registry writes; re-captured Overview at both target sizes.

## Findings

| Severity | Surface | Finding and disposition |
| --- | --- | --- |
| Passed | Layout/density | All selected screens follow the source hierarchy at 1180 × 760; data pages remain compact and Settings avoids per-item cards. |
| Passed | Runtime truth | Active Profile and Log Module are not inferred; unknown values use an em dash and System Proxy/TUN use ownership projections. |
| Passed | Responsiveness | 960 × 650 uses the 52 px rail, retains all seven Status Bar segments and keeps every tested workspace free of document/main horizontal overflow. |
| Passed | Destructive-action safety | External System Proxy ownership cannot be overwritten by the UI or the locked backend transition; partial write failures roll back only while the exact write prefix and managed listener remain owned, otherwise retaining the recovery snapshot. Compact inspector dismissal is distinct from closing a connection. |
| Passed | Accessibility | Semantic headings, labelled searches, `aria-current`, visible input/select focus treatment, keyboard navigation, reduced-motion, forced-colors and zoom-scroll fallbacks are present. |
| Passed | Icons/assets | Visible controls use one Lucide icon family. There are no emoji, ASCII glyph assets, gradients, decorative blobs or competitor assets. The traffic SVG is live data visualization, not a substitute image asset. |
| Intentional boundary | Native shell | The custom caption and Win32 hit-testing are source-verified; installed-window Snap, DPI, taskbar and lifecycle behavior remain manual acceptance checks. |

final result: passed
