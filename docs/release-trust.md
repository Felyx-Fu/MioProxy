# Windows release trust and Defender remediation

V1 uses one release-signing system: Tauri updater cryptographic signing.

- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are
  injected only into the Tauri build step that creates updater artifacts.
- The updater public key in `src-tauri/tauri.conf.json` is unchanged, and
  `bundle.createUpdaterArtifacts` remains enabled.
- Windows Authenticode is not required for V1 and is not represented as a
  release-trust claim. No PFX, certificate password, thumbprint, timestamp
  URL, or `signCommand` is part of the active release pipeline.

The release-candidate workflow is restricted to protected `main`, checks out
the exact workflow SHA, and resolves the product version through
`scripts/check-version-consistency.ps1`. Its optional `expected_version` input
must match that canonical repository version. Signing credentials are absent
from dependency installation, npm audit, Mihomo setup, source validation,
tests, manifest generation, and manifest verification. The retained
`scripts/sign-windows-artifact.ps1` is an unused legacy helper; no active
workflow or Tauri configuration references it.

`scripts/write-release-manifest.ps1` records the exact distributed SHA-256,
role, repository-relative path, and byte length for every shipped executable.
The application path is `src-tauri/target/release/mioproxy.exe`; the producer
and verifier share that path definition and the fixture-backed
`npm run test:release-manifest` gate. The manifest also records the checked-out
Git commit, pinned Mihomo project/version/tag/asset/source URLs, archive hash,
and raw extracted-binary hash. For Mihomo, the distributed hash must equal the
pinned raw upstream binary hash from `config/mihomo-release.json`. The
`distributedSha256` values in the manifest and `SHA256SUMS.txt` identify the
exact files shipped to users; they are distinct from upstream source/archive
hashes. The manifest describes deterministic and traceable inputs plus
verifiable Tauri updater signatures, without claiming Authenticode signing or
RFC 3161 timestamps.

The Tauri updater-signature gate uses the repository binary
`src-tauri/src/bin/verify-updater-signature.rs`. It is pinned to
`minisign-verify = 0.2.5`, the exact locked dependency used by
`tauri-plugin-updater 2.10.1`. The verifier reads the updater public key from
`src-tauri/tauri.conf.json`, decodes the outer standard Base64 layers, parses
the Minisign public key and signature, and calls
`PublicKey::verify(data, &signature, true)`, matching the updater plugin's
verification path. `verify-nsis-release.ps1 -RequireUpdaterMetadata` also
requires every `latest.json` signature field to equal the corresponding NSIS
`.sig` payload before invoking the cryptographic verifier. The CI tamper test
then verifies the real generated artifact, a one-byte-modified copy, and a
copy of the configuration containing a deliberately different public key.

V1 Windows packaging is NSIS EXE only: the official filename is
`MioProxy_<version>_x64-setup.exe`. `src-tauri/tauri.conf.json` configures only
the `nsis` target, the active WiX fragment is removed, and
`scripts/verify-nsis-release.ps1` fails if an MSI appears or if updater
metadata references one. The tag release, workflow-dispatch readiness check,
and updater-signed workflow-dispatch RC all run this assertion. Tauri updater
artifacts remain enabled; `latest.json` and its `.sig` file point to the NSIS
installer. The RC uploads these files as Actions evidence only and does not
create a release, tag, or public updater endpoint.

The following local unsigned-artifact audit for the current 0.9.2 source build
records distributed hashes for the exact local files. These are diagnostic
values, not release evidence; the tag workflow writes the authoritative
manifest for its own checked-out commit:

| executable | bytes | distributed SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/mioproxy.exe` | 19,985,920 | `16b9aefdc2beb1cd603d04e8bc3f47328bd56b207ffad1d7e1e0f929baa59e2b` |
| `src-tauri/binaries/mioproxy-service-x86_64-pc-windows-msvc.exe` | 5,995,008 | `73f801e5180d2b08fddc83646fb2d04163b81c20949a70bab1543e5cc2eafa57` |
| `src-tauri/binaries/mihomo-x86_64-pc-windows-msvc.exe` | 50,132,992 | `6ac25fcb26afe8e1bea24b6e6e80805bf884a33232d12e2d78dfa0b6c529ac14` |
| `src-tauri/target/release/bundle/nsis/MioProxy_0.9.2_x64-setup.exe` | 22,541,350 | `dc3e19b51ea12432d82a64077a6aca6296bf8e961958931f5636a1ab8cb3b92c` |

The original quarantined `MioProxy_0.9.2_x64-setup.exe` was removed from the download location by Defender before collection, so its SHA-256 and its embedded-file attribution are unavailable from this workstation. The tagged CI build must produce the final NSIS hash in the release manifest before publication.

The current pinned Mihomo source inputs are recorded in `config/mihomo-release.json` and `src-tauri/binaries/THIRD_PARTY_NOTICES.txt`: archive SHA-256 `289fde5e29d37a5b3326480590d8b3551c5bf7f8737290355c19bce74d57a563`, extracted upstream `mihomo.exe` SHA-256 `6ac25fcb26afe8e1bea24b6e6e80805bf884a33232d12e2d78dfa0b6c529ac14`, and distributed executable hashes in the release manifest. GeoSite.dat and GeoIP.dat are data resources; their upstream content hashes are recorded separately from the executable hashes.

At runtime, the built-in MetaCubeX `latest` fallback URLs are treated as pinned sources: a downloaded `GeoSite.dat` must match `8c9e9ec13807174ffb3582d95655e00559af3fb30253b5e30c0385e46366d9dc`, and a downloaded `GeoIP.dat` must match `8ebcb11333f7deed4bf2740f2ce3249aa8997ef03d437150c7ae373c011cd72a`. A mismatched moving `latest` payload is rejected. An explicitly configured `geox-url` remains the user's source and is validated for usable content without being incorrectly forced to match MioProxy's built-in digest. Replacement continues to use staging, validation, atomic writes, and active-runtime restoration on failure.

The Defender dogfood evidence must be retained with the release incident. Microsoft Defender ThreatID `2147776683`, detection ID `{BE456AE0-C36A-446A-8AEE-CF72A6D11C20}`, event 1116/1117, reported `Behavior:Win32/Impact.A!ml` at `2026-08-22 08:59:53` and quarantined `C:\Users\fukan\AppData\Local\Temp\MicrosoftEdgeDownloads\0cc1bfd5-9351-4a2a-96af-f3c5ca4e3ea7\MioProxy_0.9.2_x64-setup.exe`. That establishes the detected object as the NSIS file, but does not prove which embedded executable or behavior caused the classification. The original object is no longer present at that path, so no installer hash was recovered. The release process therefore records distributed hashes for every shipped executable and does not label the detection a false positive without additional evidence.

If an updater-signed build is still detected, submit the exact quarantined file, SHA-256, detection name, Defender security-intelligence version, and a reproduction description through Microsoft's official [Security Intelligence file-submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission) after the build audit and updater-signature gate pass. That is a post-build remediation path; it is not a replacement for pinned provenance, deterministic/traceable inputs, updater signature verification, or artifact verification. Do not add Defender exclusions as a release workaround.
