# Third-party software and distribution notices

## Mihomo

MioProxy launches Mihomo as a separate sidecar process.

- Project: MetaCubeX/mihomo
- License: GPL-3.0
- Source repository: https://github.com/MetaCubeX/mihomo
- Upstream releases: https://github.com/MetaCubeX/mihomo/releases
- GPL-3.0 license text: https://www.gnu.org/licenses/gpl-3.0.txt
- Bundled release: Mihomo v1.19.30
- Bundled Windows asset: `mihomo-windows-amd64-compatible-v1.19.30.zip`
- Bundled asset SHA-256: `289fde5e29d37a5b3326480590d8b3551c5bf7f8737290355c19bce74d57a563`
- Release page: https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.30
- Source archive: https://github.com/MetaCubeX/mihomo/archive/refs/tags/v1.19.30.tar.gz

The same notice and source-availability links are shipped in the packaged
`binaries/THIRD_PARTY_NOTICES.txt` resource. The `binaries` resource directory
is included by the Tauri bundle configuration, so release artifacts must retain
that notice beside the Mihomo sidecar. The pinned release and digest are
maintained in `config/mihomo-release.json` and repeated in the packaged notice.

If you distribute MioProxy together with a Mihomo binary, comply with Mihomo's GPL-3.0 redistribution requirements and include the corresponding notices/source availability required by that license.

MioProxy itself is licensed under the GNU General Public License v3.0.
This notice documents the separate third-party components distributed with MioProxy
and does not replace their respective copyright, attribution, source-availability,
or redistribution obligations.
