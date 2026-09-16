$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$shellPath = (Get-Process -Id $PID).Path

foreach ($workflow in @('release.yml', 'release-candidate.yml', 'release-readiness.yml')) {
    $source = Get-Content -Raw -LiteralPath (Join-Path $repoRoot ".github/workflows/$workflow")
    $match = [regex]::Match($source, '(?m)^      - name: (?:Validate source|Run locked source gates)\r?\n(?:        shell: pwsh\r?\n)?        run: \|\r?\n((?:          [^\r\n]*\r?\n)+)')
    if (-not $match.Success) { throw "Cannot locate source gates in $workflow" }
    $body = $match.Groups[1].Value
    $commandCount = [regex]::Matches($body, '(?m)^          (?:npm|cargo|git) ').Count
    if ($commandCount -lt 9) { throw "Missing source gates in $workflow" }
    # Execute the actual workflow body with harmless command doubles. Each
    # position fails once; no build, install, network or Git mutation is run.
    foreach ($failAt in (@(1..$commandCount) + @(0))) {
        $script = @'
$global:callCount = 0
$ProgressPreference = 'SilentlyContinue'
function Invoke-GateDouble {
    $global:callCount++
    Write-Output "GATE:$global:callCount"
    $global:LASTEXITCODE = if ($global:callCount -eq FAIL_AT) { 17 } else { 0 }
}
function npm { Invoke-GateDouble }
function cargo { Invoke-GateDouble }
function git { Invoke-GateDouble }
'@
        $script = $script.Replace('FAIL_AT', [string]$failAt) + "`n" + $body + "`nexit 0"
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
        $output = @(& $shellPath -NoProfile -NonInteractive -EncodedCommand $encoded)
        $exitCode = $LASTEXITCODE
        $expectedExit = if ($failAt -eq 0) { 0 } else { 17 }
        $expectedCount = if ($failAt -eq 0) { $commandCount } else { $failAt }
        $observedCount = @($output | Where-Object { $_ -match '^GATE:' }).Count
        if ($exitCode -ne $expectedExit -or $observedCount -ne $expectedCount) {
            throw "$workflow failure position ${failAt}: exit=$exitCode calls=$observedCount; expected exit=$expectedExit calls=$expectedCount"
        }
    }
    Write-Host "$workflow : all $commandCount failure positions stop immediately; success path passes."
}
