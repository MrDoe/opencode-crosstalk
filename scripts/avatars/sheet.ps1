<#
.SYNOPSIS
Rebuilds assets/avatars/index.html, a browsable contact sheet of the pool.
#>
param([string]$Root = (Join-Path $PSScriptRoot '..\..\assets\avatars'))

function New-Card($kind, $file) {
  "<figure><img src='$kind/$file' width='150' height='150'><figcaption>$file</figcaption></figure>"
}

$sections = ''
Get-ChildItem $Root -Directory | Sort-Object Name | ForEach-Object {
  $items = Get-ChildItem $_.FullName -Filter *.png -ErrorAction SilentlyContinue
  if (-not $items -or $items.Count -eq 0) { return }
  $cards = ($items | Sort-Object Name | ForEach-Object { New-Card $_.Directory.Name $_.Name }) -join ''
  $sections += "<h2>$($_.Name) ($($items.Count))</h2>$cards"
}

$html = @"
<!doctype html><meta charset=utf-8><title>Avatar pool</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#1b1b1f;color:#eee;margin:32px}h1{font-size:20px}h2{font-size:15px;margin-top:28px;color:#9ad}figure{display:inline-block;margin:5px;text-align:center}figcaption{font-size:11px;opacity:.7;margin-top:4px;line-height:1.4}img{border-radius:14px;background:#26262b;display:block}</style>
<h1>Avatar pool - DiceBear Personas, CC BY 4.0</h1>
$sections
"@

Set-Content -Path (Join-Path $Root 'index.html') -Value $html -Encoding UTF8
Write-Host "sheet written: $(Join-Path $Root 'index.html')"
