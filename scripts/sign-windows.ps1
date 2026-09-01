param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$BinaryPath
)

$ErrorActionPreference = "Stop"
$thumbprint = ($env:ZRO_AUTHENTICODE_THUMBPRINT -replace '\s', '')
$required = $env:ZRO_REQUIRE_AUTHENTICODE -eq "1"

if (-not $thumbprint) {
    if ($required) {
        throw "ZRO_AUTHENTICODE_THUMBPRINT is missing; refusing to produce an unsigned release."
    }
    Write-Host "Authenticode: no certificate configured; skipping non-release build."
    exit 0
}

$signTool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signTool) {
    $kitRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $signTool = Get-ChildItem $kitRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -match '\\x64$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signTool) {
    throw "signtool.exe was not found. Install the Windows SDK signing tools."
}

$timestamp = if ($env:ZRO_TIMESTAMP_URL) { $env:ZRO_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
$storeArgs = @()
$certificate = Get-Item ("Cert:\CurrentUser\My\" + $thumbprint) -ErrorAction SilentlyContinue
if (-not $certificate) {
    $certificate = Get-Item ("Cert:\LocalMachine\My\" + $thumbprint) -ErrorAction SilentlyContinue
    if ($certificate) { $storeArgs = @("/sm") }
}
if (-not $certificate -or -not $certificate.HasPrivateKey) {
    throw "The configured code-signing certificate (with private key) was not found in CurrentUser or LocalMachine."
}

& $signTool sign @storeArgs /sha1 $thumbprint /fd SHA256 /tr $timestamp /td SHA256 /d "zro browser" /du "https://thatqne.github.io/zro/" $BinaryPath
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed for $BinaryPath" }

& $signTool verify /pa /all $BinaryPath
if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed for $BinaryPath" }
