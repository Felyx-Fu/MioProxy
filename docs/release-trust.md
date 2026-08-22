# Windows release trust and Defender remediation

MioProxy uses two unrelated signing systems:

- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` sign Tauri updater metadata and update artifacts.
- `MIOPROXY_AUTHENTICODE_CERTIFICATE_PATH`, `MIOPROXY_AUTHENTICODE_CERTIFICATE_PASSWORD`, and `MIOPROXY_AUTHENTICODE_TIMESTAMP_URL` sign Windows PE files and the final NSIS installer with Authenticode.

The Authenticode PFX, password, and any certificate material are CI secrets or runner-temporary files. They must never be committed. The release workflow passes `scripts/tauri-windows-release.json` to Tauri; its `signCommand` calls `scripts/sign-windows-artifact.ps1`, which uses SHA-256 Authenticode signing and an RFC 3161 timestamp. `Get-AuthenticodeSignature` is run after the bundle is built, and a release fails if any shipped executable is unsigned, has an invalid signature, lacks a timestamp, or differs from the recorded SHA-256 manifest.

`scripts/write-release-manifest.ps1` records the Git commit, pinned Mihomo source digests, relative path, byte length, and separate hashes for each shipped executable. `preAuthenticodeSha256` is captured before signing; `postAuthenticodeSha256` is the final signed output hash; `distributedSha256` is the same post-sign hash used in `SHA256SUMS.txt`. The Mihomo entry also records the upstream archive hash and the extracted upstream binary hash before Authenticode changes the PE bytes. `Get-AuthenticodeSignature` verifies the final status, signer, and RFC 3161 timestamp.

The GitHub Actions build is deterministic and traceable from the checked-out commit, locked dependency files, pinned Mihomo/geodata inputs, and recorded build configuration. It produces verifiable signed outputs. It is not byte-for-byte reproducible after RFC 3161 timestamping: the timestamp authority response and signing time are part of the final signed bytes. The release manifest deliberately describes that distinction instead of claiming reproducible signed artifacts.

V1 Windows packaging is NSIS EXE only: the official filename is `MioProxy_<version>_x64-setup.exe`. `src-tauri/tauri.conf.json` configures only the `nsis` target, the active WiX fragment is removed, and `scripts/verify-nsis-release.ps1` fails if an MSI appears or if updater metadata references one. The tag release, workflow-dispatch readiness check, and signed workflow-dispatch RC all run this assertion. Tauri updater artifacts remain enabled; `latest.json` and its `.sig` file point to the NSIS installer. The RC uploads these files as Actions evidence only and does not create a release, tag, or public updater endpoint.

The local pre-sign audit for the current 0.9.2 source build recorded:

| executable | bytes | pre-Authenticode SHA-256 | Authenticode |
| --- | ---: | --- | --- |
| `target/release/mioproxy.exe` | 20,119,040 | `42A635571E5CA498CDBC99BEC613EBAEA1BD535C3C6DE3E474E5CF0610868472` | NotSigned |
| `target/release/mioproxy-service.exe` | 6,010,368 | `C0B37E384FDF2F712674005E087B05271B9F6E93ACE5305ACD003B596273DE30` | NotSigned |
| `binaries/mioproxy-service-x86_64-pc-windows-msvc.exe` | 5,992,448 | `39DFBFA689A217711012FE65C3CE956D5418C849C72584EBB7F251702501B6C9` | NotSigned |
| `binaries/mihomo-x86_64-pc-windows-msvc.exe` | 50,132,992 | `6AC25FCB26AFE8E1BEA24B6E6E80805BF884A33232D12E2D78DFA0B6C529AC14` | NotSigned |
| `target/release/bundle/nsis/MioProxy_0.9.2_x64-setup.exe` (local unsigned packaging check) | 22,531,519 | `3BBCBD4571E2F599EFE7A3FC9787BD4B1564F6560CDEC19E277B19A2987FE340` | NotSigned |

The original quarantined `MioProxy_0.9.2_x64-setup.exe` was removed from the download location by Defender before collection, so its SHA-256 and its embedded-file attribution are unavailable from this workstation. The tagged CI build must produce the final NSIS hash in the release manifest before publication.

The current pinned Mihomo source inputs are recorded in `config/mihomo-release.json` and `src-tauri/binaries/THIRD_PARTY_NOTICES.txt`: archive SHA-256 `289fde5e29d37a5b3326480590d8b3551c5bf7f8737290355c19bce74d57a563`, extracted upstream `mihomo.exe` SHA-256 `6ac25fcb26afe8e1bea24b6e6e80805bf884a33232d12e2d78dfa0b6c529ac14`, and separate final distributed/post-Authenticode hashes in the release manifest. GeoSite.dat and GeoIP.dat are data resources, not Authenticode-bearing executables; their upstream content hashes are recorded separately and are never substituted for PE hashes.

The Defender dogfood evidence must be retained with the release incident. Microsoft Defender ThreatID `2147776683`, detection ID `{BE456AE0-C36A-446A-8AEE-CF72A6D11C20}`, event 1116/1117, reported `Behavior:Win32/Impact.A!ml` at `2026-08-22 08:59:53` and quarantined `C:\Users\fukan\AppData\Local\Temp\MicrosoftEdgeDownloads\0cc1bfd5-9351-4a2a-96af-f3c5ca4e3ea7\MioProxy_0.9.2_x64-setup.exe`. That establishes the detected object as the NSIS file, but does not prove which embedded executable or behavior caused the classification. The original object is no longer present at that path, so no installer hash was recovered. The release process therefore records hashes and Authenticode results for every shipped executable and does not label the detection a false positive without additional evidence.

If a signed build is still detected, submit the exact quarantined file, SHA-256, detection name, Defender security-intelligence version, and a reproduction description through Microsoft's official [Security Intelligence file-submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission) after the build audit and signing gate pass. That is a post-build remediation path; it is not a replacement for Authenticode signing, timestamping, deterministic/traceable inputs, or artifact verification. Do not add Defender exclusions as a release workaround.
