param(
  [Parameter(Mandatory = $true)]
  [string]$Service,
  [Parameter(Mandatory = $true)]
  [string]$OpenClawRef,
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
  "update-openclaw-ref",
  "--service",
  $Service,
  "--openclaw-ref",
  $OpenClawRef,
  "--poll-seconds",
  "$PollSeconds",
  "--timeout-minutes",
  "$TimeoutMinutes"
)

& $npm.Source @argsList
if ($LASTEXITCODE -ne 0) {
  throw "OpenClaw client openclaw-ref update failed."
}
