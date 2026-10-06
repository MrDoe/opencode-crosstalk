<#
.SYNOPSIS
Reproduces the curated avatar pool from scripts/avatars/pool.json.

`from` records the pool a file was generated with — it can differ from its
current folder when the pool was sorted by hand — while `seed` and `skin` carry
the rest of the deterministic generation parameters.
#>
param(
  [string]$Root = (Join-Path $PSScriptRoot '..\..\assets\avatars'),
  [string]$Pool = (Join-Path $PSScriptRoot 'pool.json'),
  [int]$Size = 256
)

$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$femaleHair = 'bobBangs,bobCut,bunUndercut,curlyBun,extraLong,long,pigtails,straightBun'
$maleHair = 'bald,balding,buzzcut,fade,mohawk,shortCombover,shortComboverChops,curlyHighTop,sideShave'
$maleFacial = 'beardMustache,goatee,shadow,walrus,soulPatch,pyramid'

$entries = (Get-Content $Pool -Raw | ConvertFrom-Json).entries

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

$failed = @()
$i = 0
foreach ($entry in $entries) {
  $i++
  $hair = if ($entry.from -eq 'male') { $maleHair } else { $femaleHair }
  $url = "https://api.dicebear.com/10.x/personas/png?size=$Size&seed=$($entry.seed)&hair=$hair&skinColor=$($entry.skin)"
  if ($entry.from -eq 'male') {
    $url += "&facialHair=$maleFacial&facialHairProbability=65"
  } else {
    $url += "&facialHairProbability=0"
  }
  $dest = Join-Path (Join-Path $Root $entry.folder) $entry.file
  if (-not (Get-Png $url $dest)) { $failed += $entry.file }
  if ($i % 15 -eq 0) { Write-Host "... $i / $($entries.Count)" }
}

Write-Host "regenerated $(($entries.Count) - $failed.Count) of $($entries.Count) files into $Root"
if ($failed.Count -gt 0) { Write-Host "failed: $($failed -join ', ')" }
