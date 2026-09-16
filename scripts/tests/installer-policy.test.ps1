$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$templatePath = Join-Path $repoRoot 'src-tauri/windows/installer.nsi'
$hooksPath = Join-Path $repoRoot 'src-tauri/windows/hooks.nsh'
$servicePath = Join-Path $repoRoot 'src-tauri/src/bin/mioproxy-service.rs'
$configPath = Join-Path $repoRoot 'src-tauri/tauri.conf.json'

$templateText = [IO.File]::ReadAllText($templatePath, [Text.Encoding]::UTF8)
$hooksText = Get-Content -Raw -LiteralPath $hooksPath
$serviceText = Get-Content -Raw -LiteralPath $servicePath
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Contains {
    param(
        [string]$Text,
        [string]$Needle,
        [string]$Message
    )

    Assert-True ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -ge 0) $Message
}

function Assert-NotContains {
    param(
        [string]$Text,
        [string]$Needle,
        [string]$Message
    )

    Assert-True ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) $Message
}

function Get-TextRange {
    param(
        [string]$Text,
        [string]$StartMarker,
        [string]$EndMarker
    )

    $start = $Text.IndexOf($StartMarker, [System.StringComparison]::Ordinal)
    Assert-True ($start -ge 0) "Missing range start marker: $StartMarker"
    $end = $Text.IndexOf($EndMarker, $start + $StartMarker.Length, [System.StringComparison]::Ordinal)
    Assert-True ($end -gt $start) "Missing range end marker: $EndMarker"
    return $Text.Substring($start, $end - $start)
}

function Get-InstallerMode {
    param(
        [AllowNull()]
        [Version]$InstalledVersion,
        [Version]$PackageVersion
    )

    if ($null -eq $InstalledVersion) {
        return 'normal'
    }

    $comparison = $InstalledVersion.CompareTo($PackageVersion)
    if ($comparison -lt 0) {
        return 'upgrade'
    }
    if ($comparison -eq 0) {
        return 'repair'
    }
    return 'downgrade'
}

Assert-True ($config.bundle.targets -contains 'nsis') 'The bundle must keep NSIS enabled.'
Assert-True (-not ($config.bundle.targets -contains 'msi')) 'The bundle must not add MSI.'
Assert-True ([string]$config.bundle.windows.nsis.template -eq './windows/installer.nsi') 'The custom NSIS template is not connected in tauri.conf.json.'
Assert-True ([string]$config.bundle.windows.nsis.installerHooks -eq './windows/hooks.nsh') 'The existing NSIS hooks must remain connected.'

# The four installer states are deliberately tested as a pure policy table so
# they remain deterministic and never touch the live Service, TUN, or proxy.
$packageVersion = [Version]'1.0.3'
$modeCases = @(
    [pscustomobject]@{ Name = 'no existing install'; Installed = $null; Expected = 'normal' },
    [pscustomobject]@{ Name = 'older existing version'; Installed = [Version]'1.0.2'; Expected = 'upgrade' },
    [pscustomobject]@{ Name = 'same existing version'; Installed = [Version]'1.0.3'; Expected = 'repair' },
    [pscustomobject]@{ Name = 'newer existing version'; Installed = [Version]'1.0.4'; Expected = 'downgrade' }
)
foreach ($modeCase in $modeCases) {
    $actualMode = Get-InstallerMode -InstalledVersion $modeCase.Installed -PackageVersion $packageVersion
    Assert-True ($actualMode -eq $modeCase.Expected) "Installer mode policy failed for $($modeCase.Name): expected $($modeCase.Expected), got $actualMode."
}

# Existing-install detection is tied to exact MioProxy metadata and a known
# executable/uninstaller path; process names are only used by the later close/retry guard.
$detectionFunction = Get-TextRange -Text $templateText -StartMarker '!macro MioProxyTryRegistryRoot root' -EndMarker 'Function MioProxySetInstallPresentation'
foreach ($requiredDetection in @(
    'ReadRegStr $0 ${root} "${UNINSTKEY}" "DisplayName"',
    'ReadRegStr $1 ${root} "${UNINSTKEY}" "Publisher"',
    'ReadRegStr $2 ${root} "${UNINSTKEY}" "DisplayVersion"',
    'ReadRegStr $4 ${root} "${MANUPRODUCTKEY}" ""',
    'ReadRegStr $4 ${root} "${UNINSTKEY}" "InstallLocation"',
    'IfFileExists "$4\mioproxy.exe"',
    'IfFileExists "$4\uninstall.exe"',
    'nsis_tauri_utils::SemverCompare "${VERSION}" "$2"'
)) {
    Assert-Contains $detectionFunction $requiredDetection "Existing-install detection is missing authoritative check: $requiredDetection"
}
Assert-NotContains $detectionFunction 'FindProcess' 'Existing-install detection must not identify installations by process name.'
Assert-Contains $templateText 'StrCpy $INSTDIR $MioProxyExistingInstallPath' 'Overlay mode must reuse the detected installation path.'
Assert-Contains $templateText 'Function SkipDirectoryIfExisting' 'Overlay mode must not offer a side-by-side directory.'
Assert-Contains $templateText 'Page custom MioProxyInstallModePage MioProxyInstallModePageLeave' 'The installer must present the explicit MioProxy mode page.'
$initFunction = Get-TextRange -Text $templateText -StartMarker 'Function .onInit' -EndMarker 'Section EarlyChecks'
Assert-Contains $initFunction '$MioProxyExistingRegistryRoot == "HKCU"' 'Per-machine legacy per-user detection must branch before choosing the install path.'
Assert-Contains $initFunction 'StrCpy $MioProxyLegacyInstallPath $MioProxyExistingInstallPath' 'Per-machine migration must retain the legacy per-user path for cleanup.'
Assert-Contains $initFunction 'Call MioProxySetDefaultInstallPath' 'Per-machine migration must use the machine-wide default install path.'
$legacyCleanupFunction = Get-TextRange -Text $templateText -StartMarker 'Function MioProxyRemoveLegacyInstall' -EndMarker 'Function .onInit'
Assert-Contains $legacyCleanupFunction 'Delete "$MioProxyLegacyInstallPath\${MAINBINARYNAME}.exe"' 'Legacy cleanup must remove the old application binary.'
Assert-NotContains $legacyCleanupFunction 'RMDir /r' 'Legacy cleanup must not recursively delete unrelated files.'
$installRegistryMigration = Get-TextRange -Text $templateText -StartMarker 'WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR' -EndMarker '; Create start menu shortcut'
Assert-Contains $templateText '${If} $MioProxyExistingRegistryRoot == "HKCU"' 'Per-machine install must detect the validated per-user registry root before migration.'
Assert-Contains $templateText 'DeleteRegKey HKCU "${UNINSTKEY}"' 'Per-machine install must remove the superseded per-user uninstall record.'
Assert-Contains $templateText 'DeleteRegValue HKCU "${MANUPRODUCTKEY}" ""' 'Per-machine install must remove the superseded per-user install location.'

# Verify the user-facing mode strings and the required downgrade confirmation.
$installLabel = -join @([char]0x5B89, [char]0x88C5, [char]0x20, 'MioProxy')
$upgradeTitle = -join @([char]0x68C0, [char]0x6D4B, [char]0x5230, [char]0x5DF2, [char]0x5B89, [char]0x88C5, [char]0x20, 'MioProxy $MioProxyExistingVersion')
$currentPackageLabel = -join @([char]0x5F53, [char]0x524D, [char]0x5B89, [char]0x88C5, [char]0x5305, [char]0xFF1A, 'MioProxy ${VERSION}')
$upgradeAction = -join @([char]0x8986, [char]0x76D6, [char]0x5E76, [char]0x5347, [char]0x7EA7)
$installedTitle = -join @('MioProxy $MioProxyExistingVersion ', [char]0x5DF2, [char]0x5B89, [char]0x88C5)
$repairAction = -join @([char]0x4FEE, [char]0x590D, [char]0x20, '/', [char]0x20, [char]0x8986, [char]0x76D6, [char]0x5B89, [char]0x88C5)
$downgradePrompt = -join @([char]0x8BF7, [char]0x5148, [char]0x5173, [char]0x95ED, [char]0x20, 'MioProxy')
$downgradeWarning = -join @(
    [char]0x5F53, [char]0x524D, [char]0x5B89, [char]0x88C5, [char]0x7684, [char]0x20,
    'MioProxy', [char]0x20, [char]0x7248, [char]0x672C, [char]0x9AD8, [char]0x4E8E,
    [char]0x6B64, [char]0x5B89, [char]0x88C5, [char]0x5305, [char]0x3002
)
foreach ($requiredModeText in @(
    'StrCpy $MioProxyModeTitle "MioProxy ${VERSION}"',
    ('StrCpy $MioProxyModeSubtitle "' + $installLabel + '"'),
    ('StrCpy $MioProxyModePrimary "' + $installLabel.Substring(0, 2) + '"'),
    ('StrCpy $MioProxyModeTitle "' + $upgradeTitle + '"'),
    ('StrCpy $MioProxyModeSubtitle "' + $currentPackageLabel + '"'),
    ('StrCpy $MioProxyModePrimary "' + $upgradeAction + '"'),
    ('StrCpy $MioProxyModeTitle "' + $installedTitle + '"'),
    ('StrCpy $MioProxyModePrimary "' + $repairAction + '"'),
    $downgradeWarning,
    'MB_ICONEXCLAMATION|MB_YESNO'
)) {
    Assert-Contains $templateText $requiredModeText "Required installer wording or confirmation is missing: $requiredModeText"
}

# A normal/overlay installation must never schedule the AppData cleanup that
# belongs exclusively to the explicit uninstall checkbox flow.
$installSection = Get-TextRange -Text $templateText -StartMarker 'Section Install' -EndMarker 'Function .onInstSuccess'
foreach ($forbiddenInstallCleanup in @(
    'RmDir /r',
    'Delete "$APPDATA',
    'Delete "$LOCALAPPDATA',
    'DeleteRegKey SHCTX "${MANUPRODUCTKEY}"',
    'DeleteRegKey /ifempty SHCTX "${MANUKEY}"'
)) {
    Assert-NotContains $installSection $forbiddenInstallCleanup "Overlay/normal install must not delete user data: $forbiddenInstallCleanup"
}
$uninstallSection = Get-TextRange -Text $templateText -StartMarker 'Section Uninstall' -EndMarker 'Function RestorePreviousInstallLocation'
$cleanupGuard = $uninstallSection.IndexOf('${If} $DeleteAppDataCheckboxState = 1', [System.StringComparison]::Ordinal)
$cleanupIndex = $uninstallSection.IndexOf('RmDir /r "$APPDATA\${BUNDLEID}"', [System.StringComparison]::Ordinal)
Assert-True ($cleanupGuard -ge 0 -and $cleanupIndex -gt $cleanupGuard) 'AppData cleanup must remain behind the explicit uninstall checkbox.'
Assert-Contains $uninstallSection '$UpdateMode <> 1' 'AppData cleanup must not run during updater overlay installation.'

# The preinstall hook stops/reconfigures the existing service but does not
# delete it; the postinstall helper can therefore reuse the same SCM identity.
$preinstallHook = Get-TextRange -Text $hooksText -StartMarker '!macro NSIS_HOOK_PREINSTALL' -EndMarker '!macro NSIS_HOOK_POSTINSTALL'
Assert-NotContains $preinstallHook 'sc.exe" delete' 'Preinstall must not delete the existing MioProxy Service.'
Assert-Contains $preinstallHook 'sc.exe" config MioProxyService start= disabled' 'Preinstall must place the existing service into maintenance mode.'
Assert-Contains $preinstallHook 'sc.exe" stop MioProxyService' 'Preinstall must stop an originally running MioProxy Service.'
Assert-Contains $preinstallHook 'Call MioProxyCheckTunRecovered' 'Preinstall must retain the existing TUN recovery checkpoint.'

foreach ($consolelessRequirement in @(
    'nsExec::ExecToStack',
    'MioProxyServiceOutput',
    'MioProxyServiceExitCode',
    'StrCpy $MioProxyServiceOutput $MioProxyServiceOutput 1024'
)) {
    Assert-Contains $hooksText $consolelessRequirement "Consoleless helper diagnostics are incomplete: $consolelessRequirement"
}
Assert-NotContains $hooksText 'ExecWait' 'Installer hooks must not use visible ExecWait helper execution.'
Assert-NotContains $hooksText 'cmd.exe' 'Installer hooks must not invoke cmd.exe.'
Assert-Contains $hooksText 'WindowsPowerShell\v1.0\powershell.exe' 'The remaining TUN check must still be present.'
$powerShellIndex = $hooksText.IndexOf('WindowsPowerShell\v1.0\powershell.exe', [System.StringComparison]::Ordinal)
$nearestNsExecIndex = $hooksText.LastIndexOf('nsExec::ExecToStack', $powerShellIndex, [System.StringComparison]::Ordinal)
Assert-True ($nearestNsExecIndex -ge 0) 'The remaining PowerShell check must be launched through nsExec.'
Assert-Contains $hooksText 'Call un.MioProxyQueryService' 'The uninstall polling path must call an un-prefixed-compatible query function.'
Assert-Contains $hooksText 'Call un.MioProxyCheckTunRecovered' 'The uninstall ownership check must call an un-prefixed-compatible function.'
Assert-Contains $hooksText 'StrReplace "$MioProxyServiceOutput" "STOP_PENDING" "__MIOPROXY_STOP_PENDING__"' 'Service polling must recognize STOP_PENDING as an intermediate state.'
Assert-Contains $hooksText 'StrCpy $MioProxyServiceState "pending"' 'Service polling must return a pending state instead of aborting.'
$pluginPathMarker = $templateText.IndexOf('{{#if additional_plugins_path}}', [System.StringComparison]::Ordinal)
$hookPathMarker = $templateText.IndexOf('{{#if installer_hooks}}', [System.StringComparison]::Ordinal)
Assert-True ($pluginPathMarker -ge 0 -and $pluginPathMarker -lt $hookPathMarker) 'The NSIS utility plugin path must be registered before hooks are included.'

$appCheckFunction = Get-TextRange -Text $templateText -StartMarker 'Function MioProxyCheckAppNotRunning' -EndMarker 'Function SkipDirectoryIfExisting'
Assert-Contains $appCheckFunction 'MB_RETRYCANCEL' 'Running MioProxy must use a retry/cancel prompt.'
Assert-Contains $appCheckFunction $downgradePrompt 'The close/retry prompt must tell the user to close MioProxy.'
Assert-NotContains $appCheckFunction 'KillProcess' 'Installer must not kill MioProxy or unrelated processes.'
Assert-NotContains $appCheckFunction 'taskkill' 'Installer must not invoke taskkill.'
Assert-NotContains $templateText '!insertmacro CheckIfAppIsRunning' 'The stock Tauri kill-capable process macro must not remain on the install path.'
$installAppCheckIndex = $installSection.IndexOf('Call MioProxyCheckAppNotRunning', [System.StringComparison]::Ordinal)
$installHookIndex = $installSection.IndexOf('!insertmacro NSIS_HOOK_PREINSTALL', [System.StringComparison]::Ordinal)
Assert-True ($installAppCheckIndex -ge 0 -and $installAppCheckIndex -lt $installHookIndex) 'Install must check the running MioProxy process before changing Service/TUN state.'
$legacyCleanupIndex = $installSection.IndexOf('Call MioProxyRemoveLegacyInstall', [System.StringComparison]::Ordinal)
$postInstallHookIndex = $installSection.IndexOf('!insertmacro NSIS_HOOK_POSTINSTALL', [System.StringComparison]::Ordinal)
$legacyRegistryIndex = $installSection.IndexOf('DeleteRegKey HKCU "${UNINSTKEY}"', [System.StringComparison]::Ordinal)
Assert-True ($legacyCleanupIndex -gt $postInstallHookIndex -and $legacyRegistryIndex -gt $legacyCleanupIndex) 'Legacy cleanup and HKCU migration must happen only after post-install Service setup succeeds.'
$uninstallAppCheckIndex = $uninstallSection.IndexOf('Call un.MioProxyCheckAppNotRunning', [System.StringComparison]::Ordinal)
$uninstallHookIndex = $uninstallSection.IndexOf('!insertmacro NSIS_HOOK_PREUNINSTALL', [System.StringComparison]::Ordinal)
Assert-True ($uninstallAppCheckIndex -ge 0 -and $uninstallAppCheckIndex -lt $uninstallHookIndex) 'Uninstall must check the running MioProxy process before changing Service/TUN state.'

# The Service installer has explicit branches for an absent Service and an
# overlay Service. Rust unit tests exercise both booleans; these source checks
# ensure the production path actually uses that policy and preserves stopped state.
$serviceInstallFunction = Get-TextRange -Text $serviceText -StartMarker '    fn install(args: &[OsString])' -EndMarker '    fn configured_failure_actions()'
foreach ($requiredServiceText in @(
    'service_registration_plan(existing_service.is_some())',
    'ServiceRegistrationPlan::Create',
    'ServiceRegistrationPlan::ReuseExisting',
    'install_start_policy(false, preserve_stopped, None)',
    'if start_policy == InstallStartPolicy::StartService'
)) {
    Assert-Contains $serviceInstallFunction $requiredServiceText "Service install behavior is missing: $requiredServiceText"
}
Assert-Contains $serviceText 'const PRESERVE_STOPPED_INSTALLER_FLAG' 'Manual overlay preserve-stopped flag is missing.'
Assert-NotContains $serviceInstallFunction 'delete_service' 'Overlay Service installation must not delete and recreate the SCM registration.'
Assert-Contains $serviceText 'creation_flags(CREATE_NO_WINDOW)' 'Service maintenance sc.exe invocation must not create a console window.'
Assert-Contains $serviceText 'manual_overlay_preserves_stopped_service_and_reuses_identity' 'Rust unit coverage for stopped overlay and Service identity reuse is missing.'

Write-Host 'Installer policy tests passed.' -ForegroundColor Green
