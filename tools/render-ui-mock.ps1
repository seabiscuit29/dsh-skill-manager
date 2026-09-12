# render-ui-mock.ps1 — regenerate docs/images/skills-page.png from the real stylesheet
#
# The README's design image is generated, never hand-drawn: this script extracts the
# shipped stylesheet out of lib/client.js and renders tools/ui-mock/mock.html with
# headless Chrome. Whenever the page's CSS or markup changes, re-run it so the image
# cannot drift from the product.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\render-ui-mock.ps1
#   powershell -ExecutionPolicy Bypass -File tools\render-ui-mock.ps1 -Width 1180 -Height 2600 -Scale 2
param(
  [string]$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe",
  [string]$Edge   = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  [int]$Width = 1180,
  [int]$Height = 2200,
  [int]$Scale = 2
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path $PSScriptRoot -Parent
$Mock = Join-Path $Repo "tools\ui-mock\mock.html"
$Css  = Join-Path $Repo "tools\ui-mock\app.css"
$Out  = Join-Path $Repo "docs\images\skills-page.png"

if (-not (Test-Path $Mock)) { throw "mock markup not found: $Mock" }
$browser = if (Test-Path $Chrome) { $Chrome } elseif (Test-Path $Edge) { $Edge } else { $null }
if (-not $browser) { throw "no Chromium browser found; pass -Chrome <path>" }

Write-Host "[1/3] Extracting the shipped stylesheet from lib/client.js ..." -ForegroundColor Cyan
node (Join-Path $Repo "tools\ui-mock\extract-css.mjs")
if ($LASTEXITCODE -ne 0) { throw "stylesheet extraction failed" }

Write-Host "[2/3] Rendering the mockup with headless Chromium ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path (Split-Path $Out -Parent) -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Repo "tools\ui-mock\.chrome-profile") -Force | Out-Null
$profile = Join-Path $Repo "tools\ui-mock\.chrome-profile"

# A dedicated profile keeps the render out of the user's own browser session.
$mockUrl = "file:///" + ($Mock -replace "\\", "/")
& $browser --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=$Scale `
  --user-data-dir="$profile" --virtual-time-budget=6000 `
  --window-size="$Width,$Height" --screenshot="$Out" "$mockUrl" | Out-Null
Start-Sleep -Seconds 2

Write-Host "[3/3] Result" -ForegroundColor Cyan
if (Test-Path $Out) {
  $info = Get-Item $Out
  Write-Host ("  {0}  ({1} KB)" -f $info.FullName, [math]::Round($info.Length / 1KB)) -ForegroundColor Green
  Write-Host "  Commit the regenerated image together with the UI change."
} else {
  throw "rendering produced no file; is the browser able to create its IPC pipes? (a DSH sandbox blocks them)"
}
