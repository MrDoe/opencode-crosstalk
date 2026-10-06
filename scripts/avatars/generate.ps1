<#
.SYNOPSIS
Generates the base avatar pools into assets/avatars/<pool>/.

Every file is deterministic: the role seed plus the pool parameters and the skin
tone produce the same PNG on every run. The curated pool was generated with this
script and then sorted by hand; regenerate.ps1 reproduces the curated set file by
file.
#>
param(
  [string]$Root = (Join-Path $PSScriptRoot '..\..\assets\avatars'),
  [int]$Size = 256
)

$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$roles = @(
  'explorer', 'manager', 'coder', 'geek', 'analyst', 'planner', 'reviewer', 'tester',
  'migrator', 'builder', 'debugger', 'designer', 'researcher', 'writer', 'editor', 'fixer',
  'deployer', 'scout', 'architect', 'operator', 'coordinator', 'auditor', 'mentor', 'navigator',
  'pioneer', 'strategist', 'curator', 'librarian', 'mapper', 'tracker', 'gardener', 'refactorer',
  'simplifier', 'optimizer', 'profiler', 'integrator', 'compiler', 'parser', 'linter', 'formatter',
  'patcher', 'shipper', 'maintainer', 'guardian', 'sentinel', 'steward', 'shepherd', 'tinkerer',
  'hacker', 'wrangler'
)
$skins = @('eeb4a4', 'e7a391', 'e5a07e', 'd78774', 'b16a5b', '92594b', '623d36')
$femaleHair = 'bobBangs,bobCut,bunUndercut,curlyBun,extraLong,long,pigtails,straightBun'
$maleHair = 'bald,balding,buzzcut,fade,mohawk,shortCombover,shortComboverChops,curlyHighTop,sideShave'
$maleFacial = 'beardMustache,goatee,shadow,walrus,soulPatch,pyramid'

function Get-Png([string]$url, [string]$out) {
  for ($try = 1; $try -le 4; $try++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $out -ErrorAction Stop
      return $true
    } catch {
      Start-Sleep -Seconds (3 * $try)
    }
  }
  return $false
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'female'), (Join-Path $Root 'male') | Out-Null

$failed = @()
for ($i = 0; $i -lt $roles.Count; $i++) {
  $seed = $roles[$i]
  $number = '{0:D2}' -f ($i + 1)

  $femaleSkin = $skins[$i % $skins.Count]
  $femaleUrl = "https://api.dicebear.com/10.x/personas/png?size=$Size&seed=$seed&hair=$femaleHair&facialHairProbability=0&skinColor=$femaleSkin"
  if (-not (Get-Png $femaleUrl (Join-Path $Root "female\$number-$seed-$femaleSkin.png"))) { $failed += "female/$number-$seed" }

  $maleSkin = $skins[($i + 3) % $skins.Count]
  $maleUrl = "https://api.dicebear.com/10.x/personas/png?size=$Size&seed=$seed&hair=$maleHair&facialHair=$maleFacial&facialHairProbability=65&skinColor=$maleSkin"
  if (-not (Get-Png $maleUrl (Join-Path $Root "male\$number-$seed-$maleSkin.png"))) { $failed += "male/$number-$seed" }
}

Write-Host "generated $(($roles.Count * 2) - $failed.Count) of $($roles.Count * 2) files into $Root"
if ($failed.Count -gt 0) { Write-Host "failed: $($failed -join ', ')" }
