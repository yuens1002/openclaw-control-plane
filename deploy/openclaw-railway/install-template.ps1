param(
  [string]$Template = "clawdbot-railway-template",
  [string]$Service = "clawdbot-railway-template",
  [int]$TargetPort = 8080,
  [int]$PollSeconds = 15,
  [int]$TimeoutMinutes = 25,
  [string]$SetupUsername = "openclaw-admin",
  [string]$EnvLocalPath = ".env.local",
  [string]$HandoffPath = "openclaw-railway-handoff.local.md",
  [switch]$ForceNew,
  [switch]$NoLocalFiles
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
  "packages/openclaw-railway-installer/src/cli.ts",
  "--template",
  $Template,
  "--service",
  $Service,
  "--target-port",
  "$TargetPort",
  "--poll-seconds",
  "$PollSeconds",
  "--timeout-minutes",
  "$TimeoutMinutes",
  "--setup-username",
  $SetupUsername,
  "--env-local-path",
  $EnvLocalPath,
  "--handoff-path",
  $HandoffPath
)

if ($ForceNew) {
  $argsList += "--force-new"
}

if ($NoLocalFiles) {
  $argsList += "--no-local-files"
}

& $npm.Source @argsList
if ($LASTEXITCODE -ne 0) {
  throw "OpenClaw Railway install failed."
}
