<#
.SYNOPSIS
  Install-Plugin.ps1 的**离线自测**：在一个假 profile + 隔离备份目录上验证
  「干跑不写盘 / 安装 / 幂等 / 快照 / 回滚 / 空数组形态」。

.DESCRIPTION
  全程**不触碰真实 profile**（用 -ProfileDirOverride / -BackupRootOverride 把动作限制在
  本项目目录的 backup\selftest\ 里）。自测可通过 = 安装脚本的幂等与回滚可信。

  用法：
    powershell -ExecutionPolicy Bypass -File SelfTest-Install.ps1
#>

$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot | Split-Path -Parent
$InstallScript = Join-Path $ProjectRoot 'tools\Install-Plugin.ps1'
$Sandbox = Join-Path $ProjectRoot 'backup\selftest'
$FakeProfile = Join-Path $Sandbox 'profiles\demo'
$FakeBackup = Join-Path $Sandbox 'backup'
$PkgPath = Join-Path $FakeProfile 'package.json'
$Junction = Join-Path $FakeProfile 'node_modules\dsh-session-rescue'

$script:Fails = 0
function Assert($cond, $msg) {
  if ($cond) { Write-Host ("  PASS  " + $msg) } else { Write-Host ("  FAIL  " + $msg); $script:Fails = $script:Fails + 1 }
}
function HashOf($path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash }
function Run-Install([string[]]$Extra) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $InstallScript `
      -ProfileDirOverride $FakeProfile -BackupRootOverride $FakeBackup @Extra | Out-Null
  return $LASTEXITCODE
}
function New-FakeProfile([string]$json) {
  if (Test-Path $FakeProfile) {
    if (Test-Path $Junction) { [System.IO.Directory]::Delete($Junction, $false) }
    Remove-Item -LiteralPath $FakeProfile -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $FakeProfile 'node_modules') | Out-Null
  [System.IO.File]::WriteAllText($PkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}
function Read-Pkg { return ([System.IO.File]::ReadAllText($PkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) }

if (-not (Test-Path $InstallScript)) { throw ('找不到安装脚本：' + $InstallScript) }

# ───────── 变体 A：bundles 里已有别的 bundle ─────────
Write-Host ''
Write-Host '== 变体 A：bundles = ["some-other-plugin"] =='
$jsonA = '{"name":"demo-profile","dsh":{"profile":{"bundles":["some-other-plugin"],"patchReload":"live"}}}'
New-FakeProfile $jsonA
$origHash = HashOf $PkgPath

Write-Host '-- 1) 干跑：不得写盘 --'
$rc = Run-Install @('-WhatIfOnly')
Assert ($rc -eq 0) '干跑退出码为 0'
Assert ((HashOf $PkgPath) -eq $origHash) '干跑后 package.json 逐字节未变'
Assert (-not (Test-Path $Junction)) '干跑未创建 junction'

Write-Host '-- 2) -Apply：安装 --'
$rc = Run-Install @('-Apply')
Assert ($rc -eq 0) '安装退出码为 0'
$pkgA = Read-Pkg
Assert (@($pkgA.dsh.profile.bundles) -contains 'dsh-session-rescue') 'bundles 里出现 dsh-session-rescue'
Assert (@($pkgA.dsh.profile.bundles).Count -eq 2) 'bundles 长度为 2（未重复、未丢原条目）'
Assert (@($pkgA.dsh.profile.bundles)[-1] -eq 'dsh-session-rescue') '新条目追加在**数组末尾**（有序层语义）'
Assert (@($pkgA.dsh.profile.bundles) -contains 'some-other-plugin') '原有 bundle 仍在'
Assert ((Read-Pkg) -ne $null) '写入后 JSON 仍可解析'
Assert (Test-Path $Junction) 'junction 已建立'
$snaps = @(Get-ChildItem -LiteralPath $FakeBackup -Directory -ErrorAction SilentlyContinue)
Assert ($snaps.Count -ge 1) '已创建快照目录'
$snapFiles = @(Get-ChildItem -LiteralPath $snaps[0].FullName -File | Select-Object -ExpandProperty Name)
Assert ($snapFiles -contains 'package.json') '快照内含 package.json'
Assert ($snapFiles -contains 'install-manifest.json') '快照内含安装清单'
$afterApplyHash = HashOf $PkgPath

Write-Host '-- 3) 再次 -Apply：幂等（不得重复追加） --'
$rc = Run-Install @('-Apply')
Assert ($rc -eq 0) '重复安装退出码为 0'
Assert ((HashOf $PkgPath) -eq $afterApplyHash) '重复安装后 package.json 未变（幂等）'
Assert ((Read-Pkg).dsh.profile.bundles.Count -eq 2) '重复安装未产生重复条目'

Write-Host '-- 4) -Rollback：恢复 --'
$rc = Run-Install @('-Rollback')
Assert ($rc -eq 0) '回滚退出码为 0'
Assert ((HashOf $PkgPath) -eq $origHash) '回滚后 package.json 与安装前逐字节一致'
Assert (-not (Test-Path $Junction)) '回滚后 junction 已移除'

# ───────── 变体 B：空数组形态 ─────────
Write-Host ''
Write-Host '== 变体 B：bundles = [] （空数组文本形态）=='
$jsonB = '{"name":"demo-profile","dsh":{"profile":{"bundles":[]}}}'
New-FakeProfile $jsonB
$rc = Run-Install @('-Apply')
Assert ($rc -eq 0) '空数组安装退出码为 0'
$pkgB = Read-Pkg
Assert (($pkgB.dsh.profile.bundles.Count -eq 1) -and ($pkgB.dsh.profile.bundles[0] -eq 'dsh-session-rescue')) '空数组被正确替换为单元素数组'

Write-Host ''
if ($script:Fails -eq 0) {
  Write-Host '== 全部通过：安装脚本的干跑/幂等/快照/回滚语义已验证 =='
  exit 0
} else {
  Write-Host ('== 失败 ' + $script:Fails + ' 项 ==')
  exit 1
}
