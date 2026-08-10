param(
    [ValidateRange(1, 65535)]
    [int]$MixedPort = 7893,
    [string]$Group = 'PROXY',
    [string]$Node = 'HK-1'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifactDir = Join-Path $root 'artifacts\v09-managed-outbound'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $artifactDir "proxy-server-dns-validation-$stamp.json"
$dataDir = Join-Path $env:APPDATA 'dev.MioProxy'
$runtimeConfig = Join-Path $dataDir 'config.yaml'
$candidate = Join-Path $dataDir "config.proxy-server-dns-$stamp.yaml"
$mihomo = 'C:\Program Files\MioProxy\mihomo.exe'
$controller = 'http://127.0.0.1:19090'
$secret = (Get-Content -LiteralPath (Join-Path $dataDir 'controller-secret') -Raw).Trim()
$headers = @{ Authorization = "Bearer $secret" }

function Sanitize([string]$Text) {
    if ($null -eq $Text) { return $null }
    $value = $Text
    $value = [regex]::Replace($value, '(?i)(token|secret|password|uuid|private-key)=?\s*[^\s,;"'']+', '$1=***')
    $value = [regex]::Replace($value, '(?i)bearer\s+\S+', 'Bearer ***')
    return $value
}

function Invoke-Proxy([string]$Url, [switch]$Verbose) {
    $args = @('--proxy', "http://127.0.0.1:$MixedPort", '--max-time', '15', '-I')
    if ($Verbose) { $args += '-v' } else { $args += @('-sS', '-o', 'NUL', '-w', '%{http_code}') }
    $args += $Url
    return Sanitize ((& curl.exe @args 2>&1 | Out-String).Trim())
}

function Get-HttpErrorBody($Exception) {
    try {
        if ($Exception.Response -and $Exception.Response.Content) {
            return Sanitize ($Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult())
        }
    } catch {}
    return Sanitize $Exception.Message
}

$result = [ordered]@{ OriginalSelection=$null; Candidate=$candidate; CandidateValidation=$null; Delay=$null; Http=$null; Https=$null; Restored=$false; Error=$null }
try {
    $original = Get-Content -LiteralPath $runtimeConfig -Raw
    if ($original -notmatch '(?m)^dns:\s*$') { throw 'Runtime config has no dns block.' }
    $candidateText = $original -replace '(?m)^dns:\s*$', "dns:`n  proxy-server-nameserver:`n    - 'https://1.1.1.1/dns-query#skip-cert-verify=true'"
    Set-Content -LiteralPath $candidate -Value $candidateText -Encoding utf8
    $validation = (& $mihomo -t -f $candidate 2>&1 | Out-String).Trim()
    $result.CandidateValidation = Sanitize $validation
    if ($LASTEXITCODE -ne 0) { throw "Temporary runtime config validation failed: $validation" }
    $proxies = Invoke-RestMethod -Headers $headers -TimeoutSec 5 -Uri "$controller/proxies"
    $result.OriginalSelection = $proxies.proxies.$Group.now
    try {
        Invoke-RestMethod -Method Put -Headers $headers -ContentType 'application/json' -Body (@{ path=$candidate } | ConvertTo-Json -Compress) -TimeoutSec 10 -Uri "$controller/configs?force=true" | Out-Null
    } catch {
        throw "Temporary config reload rejected: $(Get-HttpErrorBody $_.Exception)"
    }
    Invoke-RestMethod -Method Put -Headers $headers -ContentType 'application/json' -Body (@{ name=$Node } | ConvertTo-Json -Compress) -TimeoutSec 5 -Uri "$controller/proxies/$([uri]::EscapeDataString($Group))" | Out-Null
    try {
        $delay = Invoke-WebRequest -UseBasicParsing -Headers $headers -TimeoutSec 15 -Uri "$controller/proxies/$([uri]::EscapeDataString($Node))/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=10000"
        $result.Delay = [pscustomobject]@{ Status=$delay.StatusCode; Body=Sanitize $delay.Content }
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
        $result.Delay = [pscustomobject]@{ Status=$status; Body=Sanitize $_.Exception.Message }
    }
    $result.Http = Invoke-Proxy 'http://www.baidu.com/'
    $result.Https = Invoke-Proxy 'https://www.baidu.com/' -Verbose
}
catch {
    $result.Error = Sanitize $_.Exception.Message
}
finally {
    try {
        Invoke-RestMethod -Method Put -Headers $headers -ContentType 'application/json' -Body (@{ path=$runtimeConfig } | ConvertTo-Json -Compress) -TimeoutSec 10 -Uri "$controller/configs?force=true" | Out-Null
        if ($result.OriginalSelection) {
            Invoke-RestMethod -Method Put -Headers $headers -ContentType 'application/json' -Body (@{ name=$result.OriginalSelection } | ConvertTo-Json -Compress) -TimeoutSec 5 -Uri "$controller/proxies/$([uri]::EscapeDataString($Group))" | Out-Null
        }
        $result.Restored = $true
    } catch {
        $result.Error = "$(Sanitize $result.Error) Restore failed: $(Sanitize $_.Exception.Message)"
    }
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force }
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $logPath -Encoding utf8
}

if ($result.Error) { throw "$($result.Error) Log: $logPath" }
Write-Host "Temporary proxy-server DNS validation completed. Log: $logPath"
