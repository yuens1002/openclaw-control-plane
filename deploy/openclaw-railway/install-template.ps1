param(
  [string]$Template = "clawdbot-railway-template",
  [string]$Service = "clawdbot-railway-template",
  [int]$TargetPort = 8080,
  [int]$PollSeconds = 15,
  [int]$TimeoutMinutes = 25
)

$ErrorActionPreference = "Stop"
$script:RailwayExe = $null

function Resolve-Railway {
  $command = Get-Command railway -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $npmGlobalRailway = Join-Path $env:APPDATA "npm\node_modules\@railway\cli\bin\railway.exe"
  if (Test-Path $npmGlobalRailway) {
    return $npmGlobalRailway
  }

  throw "Railway CLI was not found. Install it with: npm install -g @railway/cli"
}

function New-Secret([int]$Bytes, [string]$Prefix = "") {
  $buffer = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }

  $secret = [Convert]::ToBase64String($buffer).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  return "$Prefix$secret"
}

function Invoke-RailwayJson {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)

  $output = & $script:RailwayExe @Args
  if ($LASTEXITCODE -ne 0) {
    throw "railway $($Args -join ' ') failed with exit code $LASTEXITCODE"
  }

  if ([string]::IsNullOrWhiteSpace($output)) {
    return $null
  }

  return $output | ConvertFrom-Json
}

function Get-ServiceState {
  $services = Invoke-RailwayJson service list --json
  return $services | Where-Object { $_.name -eq $Service } | Select-Object -First 1
}

$script:RailwayExe = Resolve-Railway

$setupPassword = New-Secret 24 "oc-"
$gatewayToken = New-Secret 32

Write-Host "Deploying Railway template '$Template'..."
& $script:RailwayExe deploy -t $Template -v "SETUP_PASSWORD=$setupPassword" -v "OPENCLAW_GATEWAY_TOKEN=$gatewayToken"
if ($LASTEXITCODE -ne 0) {
  throw "Railway template deploy failed."
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$state = $null
do {
  Start-Sleep -Seconds $PollSeconds
  $state = Get-ServiceState
  if (-not $state) {
    Write-Host "Waiting for service '$Service' to appear..."
    continue
  }

  $status = $state.latestDeployment.status
  Write-Host "Deployment status: $status"

  if ($status -eq "SUCCESS") {
    break
  }

  if ($status -in @("FAILED", "CRASHED", "NEEDS_APPROVAL", "SLEEPING", "SKIPPED", "REMOVED", "REMOVING")) {
    throw "Deployment ended in terminal state '$status'. Check logs with: railway logs --service $Service --lines 200"
  }
} while ((Get-Date) -lt $deadline)

if (-not $state -or $state.latestDeployment.status -ne "SUCCESS") {
  throw "Timed out waiting for '$Service' to deploy."
}

$domains = Invoke-RailwayJson domain list --service $Service --json
$domain = $domains.domains | Where-Object { $_.type -eq "service" } | Select-Object -First 1
if (-not $domain) {
  throw "No Railway service domain was found for '$Service'."
}

if ($domain.targetPort -ne $TargetPort) {
  Write-Host "Updating domain '$($domain.domain)' to port $TargetPort..."
  Invoke-RailwayJson domain update $domain.domain --service $Service --port "$TargetPort" --json | Out-Null
}

$baseUrl = "https://$($domain.domain)"
$healthUrl = "$baseUrl/setup/healthz"
Write-Host "Verifying $healthUrl..."
$health = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 30
if ($health.StatusCode -ne 200) {
  throw "Healthcheck failed with status $($health.StatusCode)."
}

Write-Host ""
Write-Host "OpenClaw is ready."
Write-Host "Setup URL: $baseUrl/setup"
Write-Host "Username: any value"
Write-Host "Setup password: $setupPassword"
