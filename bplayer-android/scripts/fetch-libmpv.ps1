# Restores the pinned libmpv AAR that the Android app links against.
#
# The AAR is not committed (about 49 MiB, four ABIs) and app/build.gradle.kts
# references it as app/libs/libmpv-release.aar. Run this once before the first
# build; later runs are a no-op while the pinned SHA256 still matches.
#
#   pwsh -NoProfile -File bplayer-android/scripts/fetch-libmpv.ps1
#   pwsh -NoProfile -File bplayer-android/scripts/fetch-libmpv.ps1 -DryRun
#   pwsh -NoProfile -File bplayer-android/scripts/fetch-libmpv.ps1 -Force
#
# GitHub may be unreachable directly; pass a proxy when needed:
#   $env:HTTPS_PROXY = "http://127.0.0.1:7897"; .\fetch-libmpv.ps1
#   .\fetch-libmpv.ps1 -Proxy http://127.0.0.1:7897
#
# Artifact provenance (upstream versions, ABI trimming, license): research/libmpv-integration.md

[CmdletBinding()]
param(
    # Pinned release asset: libmpv-android v1.1.0 = dev.jdtech.mpv:libmpv:1.1.0.
    [string]$Url = "https://github.com/jarnedemeulemeester/libmpv-android/releases/download/v1.1.0/libmpv-release.aar",
    [string]$Sha256 = "20FD972E70D8E73BF8900D911F3AE0EEAE354606BAEB0FE58CAA1A6380E196AA",
    [long]$Bytes = 51550729,
    [string]$Proxy,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$libs = Join-Path $root "src-tauri\gen\android\app\libs"
$aar = Join-Path $libs "libmpv-release.aar"
$part = Join-Path $libs "libmpv-release.aar.part"
$expectedSha = $Sha256.ToUpperInvariant()

if ($expectedSha -notmatch "^[0-9A-F]{64}$") {
    throw "Pinned SHA256 is not a 64-character hex digest: $Sha256"
}

if ($DryRun) {
    Write-Host "url:     $Url"
    Write-Host "bytes:   $Bytes"
    Write-Host "sha256:  $expectedSha"
    Write-Host "target:  $aar"
    Write-Host "proxy:   $(if ($Proxy) { $Proxy } else { '(system default)' })"
    return
}

New-Item -ItemType Directory -Force -Path $libs | Out-Null

function Test-PinnedAar([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -ne $Bytes) {
        Write-Warning "$Path is $length bytes, expected $Bytes; fetching a clean copy."
        return $false
    }
    $actualSha = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actualSha -ne $expectedSha) {
        Write-Warning "$Path sha256 is $actualSha, expected $expectedSha; fetching a clean copy."
        return $false
    }
    return $true
}

if (-not $Force) {
    if (Test-PinnedAar $aar) {
        Write-Host "libmpv AAR already present and verified: $aar"
        return
    }
} elseif (Test-Path -LiteralPath $aar) {
    Write-Host "Force: replacing $aar"
}

# Drop a stale or wrong-size file first: if the download fails below, the build
# then fails on the missing file instead of silently linking an unverified one.
if (Test-Path -LiteralPath $aar) {
    Remove-Item -LiteralPath $aar -Force
}
if (Test-Path -LiteralPath $part) {
    Remove-Item -LiteralPath $part -Force
}

# Windows PowerShell 5.1 defaults to TLS 1.0 on some hosts; GitHub requires 1.2+.
if ($PSVersionTable.PSEdition -ne "Core") {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$request = @{
    Uri = $Url
    OutFile = $part
    UseBasicParsing = $true
}
if ($Proxy) {
    $request["Proxy"] = $Proxy
}

try {
    Write-Host "Downloading $Url"
    Invoke-WebRequest @request

    $length = (Get-Item -LiteralPath $part).Length
    if ($length -ne $Bytes) {
        throw "downloaded $length bytes, expected $Bytes"
    }
    $actualSha = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash
    if ($actualSha -ne $expectedSha) {
        throw "downloaded sha256 is $actualSha, expected $expectedSha"
    }

    Move-Item -LiteralPath $part -Destination $aar -Force
} catch {
    throw "libmpv AAR fetch failed: $($_.Exception.Message)"
} finally {
    # Never leave a partial or rejected download behind.
    if (Test-Path -LiteralPath $part) {
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Verified libmpv AAR: $aar"
exit 0
