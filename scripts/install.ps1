# YAOE-FLOW one-line installer — Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/nixartz/yaoe-flow/main/scripts/install.ps1 | iex
#
# Env vars:
#   YAOE_RELEASE_REPO   release owner/repo (default: nixartz/yaoe-flow)
#   YAOE_VERSION        pin a version (e.g. v0.1.0) — default: latest
#   YAOE_INSTALL_DIR    custom destination (default: %LOCALAPPDATA%\Programs\yaoe-flow)
#   YAOE_DRY_RUN=1      show what would happen without downloading/installing
#   YAOE_FORCE_BASELINE force the AVX2 auto-detection below (1 = baseline
#                       asset, 0 = standard asset)
$ErrorActionPreference = "Stop"

$Repo = if ($env:YAOE_RELEASE_REPO) { $env:YAOE_RELEASE_REPO } else { "nixartz/yaoe-flow" }
$Tag = $env:YAOE_VERSION

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
if ($arch -eq "arm64") {
  # Bun does not publish a windows-arm64 target today — x64 runs via emulation;
  # revisit when Bun gains the target.
  Write-Host "ℹ️  Windows ARM64: using the x64 binary via emulation"
  $arch = "x64"
}
$asset = "yaoe-flow-windows-$arch.exe"

# The x64 binary needs a CPU with AVX2 (Haswell/2013+ — Bun's compiled
# binaries use it unconditionally and crash on older CPUs); "-baseline"
# targets Nehalem/2008+ instead. Detected via the same Win32 API .NET/Bun use
# internally (works on both Windows PowerShell 5.1 and PowerShell 7+, unlike
# System.Runtime.Intrinsics which needs .NET Core).
function Test-Avx2Supported {
  try {
    $sig = '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);'
    Add-Type -MemberDefinition $sig -Name "Kernel32Probe" -Namespace "YaoeFlow" -ErrorAction Stop
    # PF_AVX2_INSTRUCTIONS_AVAILABLE = 17 (winnt.h)
    return [YaoeFlow.Kernel32Probe]::IsProcessorFeaturePresent(17)
  } catch {
    return $null # inconclusive — caller decides the safe default
  }
}
if ($env:YAOE_FORCE_BASELINE -eq "1") {
  $asset = $asset -replace "\.exe$", "-baseline.exe"
} elseif ($env:YAOE_FORCE_BASELINE -ne "0") {
  $avx2 = Test-Avx2Supported
  if ($avx2 -eq $false) {
    Write-Host "ℹ️  CPU lacks AVX2 — using the baseline build (set YAOE_FORCE_BASELINE=0 to override)"
    $asset = $asset -replace "\.exe$", "-baseline.exe"
  } elseif ($null -eq $avx2) {
    Write-Host "⚠️  could not detect AVX2 support — assuming a modern CPU. If yaoe-flow.exe crashes immediately with an illegal-instruction error, re-run with `$env:YAOE_FORCE_BASELINE='1'"
  }
}

if (-not $Tag) {
  $Tag = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
}
if (-not $Tag) {
  Write-Error "no release found in $Repo — has the release pipeline run yet?"
  exit 1
}
$base = "https://github.com/$Repo/releases/download/$Tag"

$dir = if ($env:YAOE_INSTALL_DIR) { $env:YAOE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\yaoe-flow" }

if ($env:YAOE_DRY_RUN) {
  Write-Host "[dry-run] would download $asset ($Tag) from $base and install into $dir"
  exit 0
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null

$tmp = Join-Path $env:TEMP ("yaoe-flow-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  function Get-WithRetry {
    param([string]$Url, [string]$OutFile)
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        Invoke-WebRequest $Url -OutFile $OutFile
        return
      } catch {
        Write-Host "  attempt $attempt failed, retrying in 2s..."
        Start-Sleep -Seconds 2
      }
    }
    throw "failed to download $Url after 3 attempts"
  }

  Write-Host "Downloading $asset ($Tag)…"
  Get-WithRetry -Url "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Get-WithRetry -Url "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS")

  $expectedLine = Select-String -Path (Join-Path $tmp "SHA256SUMS") -Pattern ([regex]::Escape($asset))
  if (-not $expectedLine) { throw "asset $asset not found in SHA256SUMS" }
  $expected = $expectedLine.Line.Split(" ")[0]
  $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "invalid checksum — aborting (nothing installed)" }

  $updating = Test-Path (Join-Path $dir "yaoe-flow.exe")
  Move-Item -Force (Join-Path $tmp $asset) (Join-Path $dir "yaoe-flow.exe")

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$dir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
    Write-Host "⚠️  PATH updated — open a NEW terminal before continuing"
  }
  if ($updating) {
    Write-Host "✅ updated: $dir\yaoe-flow.exe ($Tag)"
  } else {
    Write-Host "✅ installed: $dir\yaoe-flow.exe ($Tag)"
  }
  Write-Host "📦 Executable location: $dir\yaoe-flow.exe"
  Write-Host ""
  Write-Host "Next steps (new terminal):"
  Write-Host "  yaoe-flow setup     # first-run guided wizard (config lives in ~\.yaoe-flow)"
  Write-Host "  yaoe-flow daemon -d # start the service in the background"
  Write-Host ""
  Write-Host "To update later: re-run this installer (idempotent)."
  Write-Host "To uninstall: yaoe-flow stop; Remove-Item $dir\yaoe-flow.exe; Remove-Item -Recurse ~\.yaoe-flow"
} finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
