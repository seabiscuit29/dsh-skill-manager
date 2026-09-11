# resync-profile.ps1 — 把当前源码重新快照进 profile
#
# 为什么需要它：pnpm 对 `file:` 依赖只按路径判断「已是最新」，`add --force` 也不会
# 刷新快照。源码改了但没重新快照，重启后跑的还是旧代码（v0.1.0 客户端半区缺
# module/exports 前置声明就是这样带进 profile 的）。可靠做法只有 remove + add。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\resync-profile.ps1
#   powershell -ExecutionPolicy Bypass -File tools\resync-profile.ps1 -DryRun
param(
  [string]$Profile = "web",
  [string]$Spec = "file:D:/DSH/dsh-skill-manager",
  [string]$Package = "dsh-skill-manager",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$PackageDir = Split-Path $PSScriptRoot -Parent
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"

function Write-Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }

# 子进程输出走 Out-Host：函数的返回值只保留退出码，避免把 stdout 当成返回值数组。
function Invoke-DshPlugin([string[]]$PluginArgs) {
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if ($dsh) {
    & $dsh.Source plugin --profile $Profile @PluginArgs | Out-Host
  } else {
    & npx.cmd -y "@deepseek-ai/dsh" plugin --profile $Profile @PluginArgs | Out-Host
  }
  return [int]$LASTEXITCODE
}

$srcVersion = (Get-Content (Join-Path $PackageDir "package.json") -Raw | ConvertFrom-Json).version
Write-Host "profile : $ProfileDir"
Write-Host "package : $PackageDir (v$srcVersion)"
if ($DryRun) { Write-Host "模式    : DryRun（不会修改任何文件）" -ForegroundColor Yellow }

Write-Step 1 "移除旧的依赖快照"
if ($DryRun) {
  Write-Host "  将执行：dsh plugin --profile $Profile remove $Package"
} else {
  $code = [int](Invoke-DshPlugin @("remove", $Package))
  if ($code -ne 0) { Write-Host "  remove 退出码 $code（若本来就没装可忽略）" -ForegroundColor Yellow }
  else { Write-Host "  已移除" -ForegroundColor Green }
}

Write-Step 2 "重新安装（产生新的快照副本）"
if ($DryRun) {
  Write-Host "  将执行：dsh plugin --profile $Profile add $Spec"
} else {
  $code = [int](Invoke-DshPlugin @("add", $Spec))
  if ($code -ne 0) { throw "安装失败，退出码 $code" }
  Write-Host "  已安装" -ForegroundColor Green
}

Write-Step 3 "重启前预检（含「快照是否与源码一致」）"
if ($DryRun) {
  Write-Host "  将执行：node `"$PackageDir\tools\preflight.mjs`" --profile $Profile"
  Write-Host "`nDryRun 结束，未做任何修改。" -ForegroundColor Yellow
  exit 0
}
Push-Location $PackageDir
try {
  node (Join-Path $PackageDir "tools\preflight.mjs") --profile $Profile
  $preflight = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($preflight -ne 0) {
  Write-Host "`n预检未通过：**不要重启 dsh web**，先解决上面的 FAIL。" -ForegroundColor Red
  exit 1
}
Write-Host "`n快照已同步且预检通过 ✅ 现在可以重启 dsh web（Ctrl+C 后运行 D:\DSH\start-dsh-web.ps1）。" -ForegroundColor Green
