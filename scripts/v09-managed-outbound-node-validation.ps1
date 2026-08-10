param(
    [ValidateRange(1, 65535)]
    [int]$MixedPort = 7893,
    [string]$Group = 'PROXY',
    [string[]]$Node = @('HK-1', 'SG-1', 'JP-1')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifactDir = Join-Path $root 'artifacts\v09-managed-outbound'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $artifactDir "node-validation-$stamp.json"
$controller = 'http://127.0.0.1:19090'
$dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
$secret = (Get-Content -LiteralPath (Join-Path $dataDir 'controller-secret') -Raw).Trim()
$headers = @{ Authorization = "Bearer $secret" }

function Get-ExternalSnapshot {
    $proxy = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable, ProxyServer, ProxyOverride
    [pscustomobject]@{
        SystemProxy = [pscustomobject]@{ Enable=$proxy.ProxyEnable; Server=$proxy.ProxyServer; Override=$proxy.ProxyOverride }
        MihomoPids = @(Get-CimInstance Win32_Process -Filter "Name='mihomo.exe'" -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
        ForeignTun = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and $_.Name -notmatch 'MioProxy' -and ($_.Name -match 'mimo|meta.*tunnel|clash|mihomo|wintun|\btun\b' -or $_.InterfaceDescription -match 'mimo|meta.*tunnel|clash|mihomo|wintun|\btun\b') } | Select-Object Name, InterfaceDescription, Status, ifIndex)
        Routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object InterfaceIndex, NextHop, RouteMetric)
        Dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses.Count -gt 0 } | ForEach-Object { [pscustomobject]@{ InterfaceIndex=$_.InterfaceIndex; Servers=@($_.ServerAddresses) } })
    }
}

function Sanitize([string]$Text) {
    if ($null -eq $Text) { return $null }
    $value = $Text
    $value = [regex]::Replace($value, '(?i)(authorization|token|secret|password|uuid|private-key)=?\s*[^\s,;"'']+', '$1=***')
    $value = [regex]::Replace($value, '(?i)bearer\s+\S+', 'Bearer ***')
    return $value
}

function Invoke-Delay([string]$Name) {
    $url = "$controller/proxies/$([uri]::EscapeDataString($Name))/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=10000"
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Headers $headers -TimeoutSec 15 -Uri $url
        return [pscustomobject]@{ Status=$response.StatusCode; Body=Sanitize $response.Content }
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
        return [pscustomobject]@{ Status=$status; Body=Sanitize $_.Exception.Message }
    }
}

function Invoke-ProxyCurl([string]$Url, [switch]$Verbose) {
    $args = @('--proxy', "http://127.0.0.1:$MixedPort", '--max-time', '15', '-I')
    if ($Verbose) { $args += '-v' } else { $args += @('-sS', '-o', 'NUL', '-w', '%{http_code}') }
    $args += $Url
    $output = (& curl.exe @args 2>&1 | Out-String).Trim()
    return Sanitize $output
}

$before = Get-ExternalSnapshot
$result = [ordered]@{ Before=$before; OriginalSelection=$null; Tests=@(); After=$null; ExternalPreserved=$false; Error=$null }
try {
    $proxies = Invoke-RestMethod -Headers $headers -TimeoutSec 5 -Uri "$controller/proxies"
    $original = $proxies.proxies.$Group.now
    if (-not $original) { throw "Controller group '$Group' has no selected node." }
    $result.OriginalSelection = $original
    foreach ($name in $Node) {
        Invoke-RestMethod -Method Put -Headers $headers -ContentType 'application/json' -Body (@{ name=$name } | ConvertTo-Json -Compress) -TimeoutSec 5 -Uri "$controller/proxies/$([uri]::EscapeDataString($Group))" | Out-Null
        $selection = (Invoke-RestMethod -Headers $headers -TimeoutSec 5 -Uri "$controller/proxies").proxies.$Group.now
        $delay = Invoke-Delay $name
        $http = Invoke-ProxyCurl 'http://www.baidu.com/'
        $https = Invoke-ProxyCurl 'https://www.baidu.com/' -Verbose
        $result.Tests += [pscustomobject]@{ Node=$name; ControllerSelection=$selection; Delay=$delay; Http=$http; Https=$https }
    }
}
catch {
    $result.Error = Sanitize $_.Exception.Message
}
finally {
    if ($result.OriginalSelection) {
        try {
            Invoke-RestMethod -Method Put -Headers $headers -ContentType 'application/json' -Body (@{ name=$result.OriginalSelection } | ConvertTo-Json -Compress) -TimeoutSec 5 -Uri "$controller/proxies/$([uri]::EscapeDataString($Group))" | Out-Null
        } catch {
            $result.Error = "$(Sanitize $result.Error) Restore selection failed: $(Sanitize $_.Exception.Message)"
        }
    }
    $result.After = Get-ExternalSnapshot
    $result.ExternalPreserved = ($before | ConvertTo-Json -Compress -Depth 6) -eq ($result.After | ConvertTo-Json -Compress -Depth 6)
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $logPath -Encoding utf8
}

if ($result.Error) { throw "$($result.Error) Log: $logPath" }
Write-Host "Managed outbound node validation completed. Log: $logPath"
