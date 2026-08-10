param(
    [ValidateRange(1, 65535)]
    [int]$Port = 7890
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifactDir = Join-Path $root 'artifacts\v09-port-isolation'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$helper = Join-Path $root 'src-tauri\target\debug\mioproxy-service.exe'
if (-not (Test-Path -LiteralPath $helper)) {
    throw "Missing development helper: $helper. Run cargo build first."
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskName = "MioProxy-PortDiagnostics-$stamp"
$systemOutput = Join-Path $artifactDir "port-diagnostics-system-$stamp.json"
$summaryPath = Join-Path $artifactDir "port-diagnostics-context-$stamp.json"
function Get-NetworkSnapshot {
    $proxy = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable, ProxyServer, ProxyOverride -ErrorAction SilentlyContinue
    [pscustomobject]@{
        Proxy = [pscustomobject]@{ ProxyEnable = $proxy.ProxyEnable; ProxyServer = $proxy.ProxyServer; ProxyOverride = $proxy.ProxyOverride }
        Routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object InterfaceIndex,NextHop,RouteMetric)
        Dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ InterfaceIndex = $_.InterfaceIndex; ServerAddresses = @($_.ServerAddresses) } })
    }
}

$before = Get-NetworkSnapshot

$interactiveText = & $helper port-diagnostics $Port
if ($LASTEXITCODE -ne 0) { throw "Interactive port-diagnostics failed with exit code $LASTEXITCODE" }
$interactive = $interactiveText | ConvertFrom-Json
$taskCreated = $false

try {
    $taskCommand = "cmd.exe /d /c `"`"$helper`" --port-diagnostics $Port > `"$systemOutput`" 2>&1`""
    & schtasks.exe /Create /TN $taskName /TR $taskCommand /SC ONCE /ST 23:59 /RU SYSTEM /RL HIGHEST /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to create LocalSystem diagnostics task ($LASTEXITCODE)" }
    $taskCreated = $true
    & schtasks.exe /Run /TN $taskName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to run LocalSystem diagnostics task ($LASTEXITCODE)" }

    $completed = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-Path -LiteralPath $systemOutput) {
            $completed = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $completed) { throw 'LocalSystem diagnostics task did not produce output within 7.5 seconds' }
    $system = Get-Content -LiteralPath $systemOutput -Raw | ConvertFrom-Json
    $normalize = { param($items) @($items | ForEach-Object { "$($_.addressFamily)|$($_.localAddress)|$($_.localPort)|$($_.owningPid)" } | Sort-Object) }
    $interactiveRows = & $normalize $interactive
    $systemRows = & $normalize $system
    if (Compare-Object $interactiveRows $systemRows) {
        throw 'Interactive and LocalSystem native listener results differ'
    }

    $after = Get-NetworkSnapshot
    $result = [pscustomobject]@{
        Port = $Port
        TaskName = $taskName
        Interactive = $interactive
        LocalSystem = $system
        ResultsMatch = $true
        Before = $before
        After = $after
        CapturedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding utf8
    [pscustomobject]@{ LogPath = $summaryPath; Port = $Port; ResultsMatch = $true } | ConvertTo-Json -Compress
}
catch {
    $after = Get-NetworkSnapshot
    [pscustomobject]@{
        Port = $Port
        TaskName = $taskName
        ResultsMatch = $false
        Error = $_.Exception.Message
        Before = $before
        After = $after
        CapturedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding utf8
    throw
}
finally {
    if ($taskName -notmatch '^MioProxy-PortDiagnostics-\d{8}-\d{6}$') {
        throw "Refusing to delete unexpected scheduled task name: $taskName"
    }
    if ($taskCreated) {
        & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
    }
}
