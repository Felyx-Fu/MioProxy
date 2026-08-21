# Third-party software and distribution notices

## Mihomo

MioProxy launches Mihomo as a separate sidecar process.

- Project: MetaCubeX/mihomo
- License: GPL-3.0
- Source repository: https://github.com/MetaCubeX/mihomo
- Upstream releases: https://github.com/MetaCubeX/mihomo/releases
- GPL-3.0 license text: https://www.gnu.org/licenses/gpl-3.0.txt

The same notice and source-availability links are shipped in the packaged
`binaries/THIRD_PARTY_NOTICES.txt` resource. The `binaries` resource directory
is included by the Tauri bundle configuration, so release artifacts must retain
that notice beside the Mihomo sidecar. The exact upstream release and digest
used for a build must be recorded in the release build evidence.

If you distribute MioProxy together with a Mihomo binary, comply with Mihomo's GPL-3.0 redistribution requirements and include the corresponding notices/source availability required by that license.

The MioProxy source template itself is intentionally marked private/unlicensed until you choose a license for your own project.
