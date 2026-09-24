<#
.SYNOPSIS
  dsh-session-rescue —— 在 DSH profile 中安装 / 回滚本插件（幂等；默认只预演）。

.DESCRIPTION
  本脚本只动 **profile 目录**（%APPDATA%\dsh-desktop\harness\profiles\<profile>），
  **不碰 DSH 安装目录**（C:\Program Files\DSH Desktop\...），也不重启/结束任何进程。

  安装做两件事：
    1) 在 profile 的 node_modules 下建立 **junction**，指向本项目目录
       —— 这样 profile 里就能按包名解析到本插件；
    2) 把包名追加进 profile 的 package.json 的 **dsh.profile.bundles**（bundle 层）。

  备份**只写在本项目目录**下的 backup\ 里（不外溢到别处）；package.json 采用
  **文本级插入**而非反序列化重写，以保持文件其余部分逐字节不变。

  用法（三选一）：
    powershell -ExecutionPolicy Bypass -File Install-Plugin.ps1 -WhatIfOnly   # 预演（也是默认行为）
    powershell -ExecutionPolicy Bypass -File Install-Plugin.ps1 -Apply        # 执行安装
    powershell -ExecutionPolicy Bypass -File Install-Plugin.ps1 -Rollback     # 用最近一次快照恢复

  安装/回滚后都需要**重启 DSH Desktop** 才会生效。

.NOTES
  幂等：重复 -Apply 不会重复追加条目、不会重建已存在的 junction。
  安全：-Apply 仅在**没有快照**时创建快照；任何一步校验失败都会立刻停止并提示回滚。
  本机 PowerShell 为 5.1，故本文件必须以 **UTF-8 with BOM** 保存（否则中文注释按 GBK 解码会炸）。
#>

[CmdletBinding()]
param(
  [switch]$WhatIfOnly,
  [switch]$Apply,
  [switch]$Rollback,
  [string]$ProfileName = 'web',
  [string]$PluginName = 'dsh-session-rescue',
  # 以下两个仅供离线自测（不碰真实 profile / 不回写项目 backup 根）
  [string]$ProfileDirOverride = '',
  [string]$BackupRootOverride = ''
)

$ErrorActionPreference = 'Stop'

# 本项目根目录（脚本位于 <project>\tools\）
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackupRoot = Join-Path $ProjectRoot 'backup'
$HarnessHome = Join-Path $env:APPDATA 'dsh-desktop\harness'
$ProfileDir = Join-Path $HarnessHome ("profiles\" + $ProfileName)
if ($ProfileDirOverride -ne '') { $ProfileDir = $ProfileDirOverride; Write-Host ('  ! profile 目录被覆盖（自测用）：' + $ProfileDir) }
if ($BackupRootOverride -ne '') { $BackupRoot = $BackupRootOverride; Write-Host ('  ! 备份目录被覆盖（自测用）：' + $BackupRoot) }
$PkgPath = Join-Path $ProfileDir 'package.json'
$JunctionPath = Join-Path $ProfileDir ("node_modules\" + $PluginName)

function Write-Step($text) { Write-Host ("  · " + $text) }
function Write-Head($text) { Write-Host ""; Write-Host ("== " + $text) }

function Get-LatestSnapshot {
  if (-not (Test-Path $BackupRoot)) { return $null }
  $dirs = Get-ChildItem -LiteralPath $BackupRoot -Directory | Sort-Object Name -Descending
  if (-not $dirs -or $dirs.Count -eq 0) { return $null }
  return $dirs[0].FullName
}

function New-Snapshot {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dir = Join-Path $BackupRoot $stamp
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $dest = Join-Path $dir 'package.json'
  Copy-Item -LiteralPath $PkgPath -Destination $dest -Force
  return $dir
}

Write-Head ("DSH profile: " + $ProfileDir)
if (-not (Test-Path $ProfileDir)) { throw ("找不到 profile 目录：" + $ProfileDir) }
if (-not (Test-Path $PkgPath)) { throw ("找不到 profile 的 package.json：" + $PkgPath) }

$raw = [System.IO.File]::ReadAllText($PkgPath, [System.Text.Encoding]::UTF8)
try { $json = $raw | ConvertFrom-Json } catch { throw ("package.json 不是合法 JSON，已中止：" + $_.Exception.Message) }

$bundles = @()
if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }
Write-Step ("当前 dsh.profile.bundles = [" + ($bundles -join ', ') + "]")
Write-Step ("插件目录：" + $ProjectRoot)
Write-Step ("junction 目标：" + $JunctionPath)
$alreadyInBundles = $bundles -contains $PluginName
$junctionExists = Test-Path $JunctionPath
Write-Step ("是否已在 bundles 中：" + $alreadyInBundles + "　是否已有 junction：" + $junctionExists)

# ─────────────────────────────── 回滚 ───────────────────────────────
if ($Rollback) {
  Write-Head 'Rollback'
  $snap = Get-LatestSnapshot
  if (-not $snap) { throw ("没有可用的快照目录：" + $BackupRoot) }
  $snapPkg = Join-Path $snap 'package.json'
  if (-not (Test-Path $snapPkg)) { throw ("快照里没有 package.json：" + $snapPkg) }
  Write-Step ("使用快照：" + $snap)
  Copy-Item -LiteralPath $snapPkg -Destination $PkgPath -Force
  Write-Step 'package.json 已按快照恢复'
  if ($junctionExists) {
    # junction 是目录链接，Remove-Item 默认不会递归进去；-Force 不会删到目标内容
    [System.IO.Directory]::Delete($JunctionPath, $false)
    Write-Step 'junction 已移除'
  } else {
    Write-Step '没有 junction，跳过'
  }
  Write-Host ''
  Write-Host '回滚完成 —— 请重启 DSH Desktop 使其生效。'
  exit 0
}

# ─────────────────────────────── 安装 ───────────────────────────────
Write-Head 'Install plan'
Write-Step '1) 若尚无快照：把 profile\package.json 复制到 backup\<时间戳>\ '
Write-Step '2) junction: <profile>\node_modules\dsh-session-rescue  ->  本项目目录'
Write-Step '3) 文本级插入：在 profile\package.json 的 dsh.profile.bundles 里追加 "dsh-session-rescue"'
Write-Step '4) 校验：重新解析 JSON、确认条目存在；失败则提示用 -Rollback'
if ($alreadyInBundles -and $junctionExists) {
  Write-Host ''
  Write-Host '已经是安装状态（幂等）：无需改动。'
  exit 0
}

if (-not $Apply) {
  Write-Host ''
  Write-Host '预览模式（未做任何改动）。确认无误后加 -Apply 执行。'
  exit 0
}

if ($WhatIfOnly -and $Apply) { throw '不要同时使用 -WhatIfOnly 与 -Apply' }

$snapshotDir = New-Snapshot
Write-Step ("已创建快照：" + $snapshotDir)

if (-not $junctionExists) {
  New-Item -ItemType Junction -Path $JunctionPath -Target $ProjectRoot | Out-Null
  Write-Step 'junction 已建立'
} else {
  Write-Step 'junction 已存在，跳过'
}

if (-not $alreadyInBundles) {
  $pattern = '("bundles"\s*:\s*\[)'
  if ($raw -notmatch $pattern) { throw '在 profile\package.json 里找不到 "bundles": [ 结构，已中止（未改动文件）' }
  $emptyArray = '("bundles"\s*:\s*\[\s*\])'
  if ($raw -match $emptyArray) {
    $replacement = '"bundles": [ "' + $PluginName + '" ]'
    $new = [regex]::Replace($raw, $emptyArray, $replacement, 1)
  } else {
    $new = [regex]::Replace($raw, $pattern, ('$1' + [Environment]::NewLine + '      "' + $PluginName + '",'), 1)
  }
  try { $null = $new | ConvertFrom-Json } catch { throw ('插入后 JSON 校验失败，未写入。请用 -Rollback 恢复：' + $_.Exception.Message) }
  [System.IO.File]::WriteAllText($PkgPath, $new, (New-Object System.Text.UTF8Encoding($false)))
  Write-Step 'package.json 已更新（文本级插入，其余内容原样保留）'
} else {
  Write-Step 'bundles 中已存在该条目，跳过'
}

# 安装清单，便于人工核对与后续回滚
$manifest = [ordered]@{
  installedAt = (Get-Date).ToString('s')
  plugin = $PluginName
  projectRoot = $ProjectRoot
  profileDir = $ProfileDir
  packageJson = $PkgPath
  junction = $JunctionPath
  snapshot = $snapshotDir
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $snapshotDir 'install-manifest.json') -Encoding UTF8
Write-Step '安装清单已写入快照目录'

Write-Host ''
Write-Host '安装完成 —— 请**重启 DSH Desktop** 使其生效。'
Write-Host '若启动异常：菜单 Harness → Restart as Safe Mode… 可临时屏蔽第三方插件；'
Write-Host ('或用 -Rollback 一键恢复（快照：' + $snapshotDir + '）。')
