param(
  [ValidateSet("npm","binary")]
  [string]$Channel = $(if ($env:CLAWTY_INSTALL_CHANNEL) { $env:CLAWTY_INSTALL_CHANNEL } else { "npm" }),
  [string]$Version = "latest",
  [string]$BinaryUrl = $env:CLAWTY_BINARY_URL,
  [string]$BinDir = $(if ($env:CLAWTY_BIN_DIR) { $env:CLAWTY_BIN_DIR } else { Join-Path $HOME ".clawty\\bin" })
)

$ErrorActionPreference = "Stop"

if ($Channel -eq "npm") {
  Write-Host "Installing clawty via npm (version: $Version)..."
  npm install -g "clawty@$Version"
  Write-Host "Install complete. Run: clawty --help"
  exit 0
}

if (-not $BinaryUrl) {
  throw "Binary install requires -BinaryUrl or CLAWTY_BINARY_URL"
}

New-Item -Path $BinDir -ItemType Directory -Force | Out-Null
$target = Join-Path $BinDir "clawty.exe"
Invoke-WebRequest -Uri $BinaryUrl -OutFile $target
Write-Host "Installed clawty to $target"
Write-Host "Add to PATH if needed: $BinDir"
