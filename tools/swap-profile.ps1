# swap-profile.ps1 — 把「两个旧插件」换成合并后的 dsh-skill-manager
#
# 顺序是安全的关键：先卸旧、再清 profile patch 里两条旧 insert、最后装新包，
# 结束时自动跑预检（tools/preflight.mjs）。预检不通过就不要重启 dsh web。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\swap-profile.ps1            # 真正执行
#   powershell -ExecutionPolicy Bypass -File tools\swap-profile.ps1 -DryRun    # 只打印计划
#
# 参数：
#   -Profile   web（默认）
#   -Spec      新插件来源，默认 file:D:/DSH/dsh-skill-manager
#              也可传 git+https://github.com/<owner>/dsh-skill-manager.git（需代理）
#   -DryRun    只打印将执行的命令与将要删除的 patch 片段
param(
  [string]$Profile = "web",
  [string]$Spec = "file:D:/DSH/dsh-skill-manager",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$PackageDir = Split-Path $PSScriptRoot -Parent
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$PkgFile    = Join-Path $ProfileDir "package.json"
$PatchFile  = Join-Path $ProfileDir "cordis.patch.yml"
$BackupDir  = "D:\DSH\backups"
$Stamp      = Get-Date -Format "yyyyMMdd-HHmmss"

$Retired = @(
  "@deepseek-ai/dsh-client-ui-settings-skills",
  "@deepseek-ai/dsh-skill-manager"
)

function Write-Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }

# 官方通道：优先 dsh CLI，其次 npx 解析（与 start-dsh-web.ps1 的启动方式一致）
#
# 注意：子进程输出必须走 Out-Host。PowerShell 函数会把成功输出流里的**每一个值**都当作
# 返回值，若把 stdout 留在管道里，调用方拿到的是「一堆文本 + 退出码」数组，`$code -ne 0`
# 就会把成功的安装误判为失败（v1 脚本正是踩了这个坑）。
function Invoke-DshPlugin([string[]]$PluginArgs) {
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if ($dsh) {
    & $dsh.Source plugin --profile $Profile @PluginArgs | Out-Host
  } else {
    & npx.cmd -y "@deepseek-ai/dsh" plugin --profile $Profile @PluginArgs | Out-Host
  }
  return [int]$LASTEXITCODE
}

if (-not (Test-Path $PkgFile))   { throw "找不到 profile package.json：$PkgFile" }
if (-not (Test-Path $PatchFile)) { throw "找不到 profile cordis.patch.yml：$PatchFile" }
if (-not (Test-Path (Join-Path $PackageDir "tools\preflight.mjs"))) { throw "预检脚本缺失：$PackageDir\tools\preflight.mjs" }

Write-Host "profile : $ProfileDir"
Write-Host "package : $PackageDir"
Write-Host "spec    : $Spec"
if ($DryRun) { Write-Host "模式    : DryRun（不会修改任何文件）" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. 备份
Write-Step 1 "备份 profile 的 package.json 与 cordis.patch.yml"
$pkgBackup   = Join-Path $BackupDir "profile-$Profile-package.json.bak-$Stamp"
$patchBackup = Join-Path $BackupDir "profile-$Profile-cordis.patch.yml.bak-$Stamp"
if ($DryRun) {
  Write-Host "  将复制 $PkgFile -> $pkgBackup"
  Write-Host "  将复制 $PatchFile -> $patchBackup"
} else {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  Copy-Item $PkgFile $pkgBackup -Force
  Copy-Item $PatchFile $patchBackup -Force
  Write-Host "  已备份：$pkgBackup" -ForegroundColor Green
  Write-Host "  已备份：$patchBackup" -ForegroundColor Green
}

# ---------------------------------------------------------------- 2. 卸载旧插件
Write-Step 2 "卸载两个旧插件（官方通道）"
foreach ($name in $Retired) {
  if ($DryRun) { Write-Host "  将执行：dsh plugin --profile $Profile remove $name"; continue }
  Write-Host "  remove $name ..."
  $code = [int](Invoke-DshPlugin @("remove", $name))
  if ($code -ne 0) { Write-Host "  remove $name 退出码 $code（可能本来就没装，继续）" -ForegroundColor Yellow }
}

# ---------------------------------------------------------------- 3. 清理旧 insert
Write-Step 3 "删除 cordis.patch.yml 里两条旧 insert（否则与新包的包内 patch 重复 id）"
$patch = Get-Content $PatchFile -Raw
$before = $patch
foreach ($name in $Retired) {
  $escaped = [regex]::Escape($name)
  $pattern = "(?s)\r?\n*- insert:\s*\r?\n\s*- id: [^\r\n]*\r?\n\s*name: '$escaped'[^\r\n]*\r?\n?"
  $patch = [regex]::Replace($patch, $pattern, "`n")
}
foreach ($name in $Retired) {
  if ($patch -match [regex]::Escape($name)) {
    throw "清理后 cordis.patch.yml 仍引用 $name，请手工检查：$PatchFile"
  }
}
if ($DryRun) {
  Write-Host "  将删除包含以下 name 的 insert 块：$($Retired -join ', ')"
} elseif ($patch -eq $before) {
  Write-Host "  没有需要删除的 insert（已清理过）" -ForegroundColor Yellow
} else {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($PatchFile, $patch, $utf8NoBom)
  Write-Host "  已清理；剩余 insert id：" -ForegroundColor Green
  Select-String -Path $PatchFile -Pattern "^\s*- id:" | ForEach-Object { "    " + $_.Line.Trim() }
}

# ---------------------------------------------------------------- 4. 安装新插件
Write-Step 4 "安装新插件（自带 dsh.bundle.patch，会自动进入 dsh.profile.bundles）"
if ($DryRun) {
  Write-Host "  将执行：dsh plugin --profile $Profile add $Spec"
} else {
  $code = [int](Invoke-DshPlugin @("add", $Spec))
  if ($code -ne 0) { throw "安装失败，退出码 $code（profile 尚未重启，可安全修复或回滚）" }
  Write-Host "  安装完成" -ForegroundColor Green
}

# ---------------------------------------------------------------- 5. 预检
Write-Step 5 "重启前预检（重复 id / 入口可解析 / 入口文件存在 / 客户端产物）"
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
  Write-Host "`n预检未通过：**不要重启 dsh web**。修掉上面每个 FAIL 后重跑本脚本或预检。" -ForegroundColor Red
  Write-Host "回滚：Copy-Item '$pkgBackup' '$PkgFile' -Force; Copy-Item '$patchBackup' '$PatchFile' -Force" -ForegroundColor Yellow
  exit 1
}

Write-Host "`n预检通过 ✅  现在可以重启 dsh web：" -ForegroundColor Green
Write-Host "  1) 在启动 dsh web 的窗口按 Ctrl+C"
Write-Host "  2) 运行 D:\DSH\start-dsh-web.ps1"
Write-Host "  3) 刷新页面 → 设置 → 技能（应出现搜索框、启用/禁用开关、删除按钮）"
Write-Host "  4) 对话框输入 /skill doctor 核对"
