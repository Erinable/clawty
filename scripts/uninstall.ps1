param(
  [switch]$KeepConfig,
  [switch]$SkipNpm
)

$ErrorActionPreference = "Stop"

if (-not $SkipNpm) {
  try {
    npm uninstall -g clawty
  } catch {
    Write-Warning "npm uninstall failed: $($_.Exception.Message)"
  }
}

$clawtyHome = Join-Path $HOME ".clawty"
$binDir = Join-Path $clawtyHome "bin"
if (Test-Path $binDir) {
  Remove-Item -Path $binDir -Recurse -Force
}

if (-not $KeepConfig -and (Test-Path $clawtyHome)) {
  Remove-Item -Path $clawtyHome -Recurse -Force
}

Write-Host "clawty removed"
