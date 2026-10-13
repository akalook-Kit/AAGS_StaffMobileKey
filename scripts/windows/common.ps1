# Shared helpers for the K Hotel staff key test scripts. Windows PowerShell 5.1 or PowerShell 7.
$Script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Script:EnvFile = Join-Path $Script:Root '.env'

function Initialize-SmkEnv {
  if (-not (Test-Path $Script:EnvFile)) {
    Copy-Item (Join-Path $Script:Root '.env.example') $Script:EnvFile
    Write-Host "Created .env from .env.example (edit it to change ports)." -ForegroundColor Yellow
  }
}

function Read-SmkEnv {
  $cfg = @{
    COMPOSE_PROJECT_NAME = 'khb-staffkey'; SMK_PORTAL_PORT = '14080'; SMK_SIM_PORT = '14444'
    SMK_CONNECTOR_PORT = '14090'; SMK_EXPO_PORT = '14081'; SMK_BIND = '127.0.0.1'; SMK_VL_PORT = '14443'; SMK_CONNECTOR = 'docker'
  }
  if (Test-Path $Script:EnvFile) {
    foreach ($line in Get-Content $Script:EnvFile) {
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  return $cfg
}

function Set-SmkEnvValue([string]$Name, [string]$Value) {
  $lines = @(Get-Content $Script:EnvFile)
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$Name\s*=") { $lines[$i] = "$Name=$Value"; $found = $true }
  }
  if (-not $found) { $lines += "$Name=$Value" }
  Set-Content -Path $Script:EnvFile -Value $lines -Encoding ASCII
}

function Test-ProjectRunning([hashtable]$cfg) {
  $ids = docker compose -p $cfg.COMPOSE_PROJECT_NAME ps -q
  return [bool]$ids
}

function Write-Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
