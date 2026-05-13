#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "Node.js not found. Install Node 20+: https://nodejs.org/"
  exit 1
}
$major = [int]((node --version) -replace '^v','' -split '\.')[0]
if ($major -lt 20) {
  Write-Error "Node.js 20+ required. You have $(node --version). Upgrade: https://nodejs.org/"
  exit 1
}

node (Join-Path $repoRoot "scripts\uninstall.mjs")
