param(
  [Parameter(Mandatory = $true)]
  [string]$Service,
  [Parameter(Mandatory = $true)]
  [string]$TemplateRef,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedCurrentRef,
  [string]$SetupUsername,
  [int]$PollSeconds = 15,
  [int]$TimeoutMinutes = 25
)

$ErrorActionPreference = "Stop"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  throw "npm.cmd was not found. Install Node.js, run npm install, then retry."
}

$argsList = @(
  "exec",
  "--",
  "tsx",
  "packages/openclaw-railway-installer/src/client-cli.ts",
  "update-ref",
  "--service",
  $Service,
  "--template-ref",
  $TemplateRef,
  "--expected-current-ref",
  $ExpectedCurrentRef,
  "--poll-seconds",
  "$PollSeconds",
  "--timeout-minutes",
  "$TimeoutMinutes"
)

if ($SetupUsername) {
  $argsList += @("--setup-username", $SetupUsername)
}

& $npm.Source @argsList
if ($LASTEXITCODE -ne 0) {
  throw "OpenClaw client template-ref update failed."
}
