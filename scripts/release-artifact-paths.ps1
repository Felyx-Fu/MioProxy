function Get-ReleaseExecutableRelativePaths {
    [ordered]@{
        app = 'src-tauri/target/release/mioproxy.exe'
        service = 'src-tauri/binaries/mioproxy-service-x86_64-pc-windows-msvc.exe'
        mihomo = 'src-tauri/binaries/mihomo-x86_64-pc-windows-msvc.exe'
    }
}

function Get-ReleaseExecutablePaths {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $paths = [ordered]@{}
    foreach ($entry in (Get-ReleaseExecutableRelativePaths).GetEnumerator()) {
        $paths[$entry.Key] = Join-Path $RepoRoot ($entry.Value -replace '/', '\')
    }
    return $paths
}
