param(
  [Parameter(Mandatory = $true)]
  [string]$ClientName,
  [string]$ProjectId,
  [string]$Workspace,
  [int]$TargetPort = 8080,
  [string]$TemplateRef,
  [string]$SetupUsername = "openclaw-admin",
  [int]$PollSeconds = 15,
  [int]$TimeoutMinutes = 25,
  [string]$EnvLocalPath = ".env.local",
  [string]$HandoffPath = "openclaw-railway-client-handoff.local.md",
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
  "packages/openclaw-railway-installer/src/client-cli.ts",
  "provision",
  "--client-name",
  $ClientName,
  "--target-port",
  "$TargetPort",
  "--setup-username",
  $SetupUsername,
  "--poll-seconds",
  "$PollSeconds",
  "--timeout-minutes",
  "$TimeoutMinutes",
  "--env-local-path",
  $EnvLocalPath,
  "--handoff-path",
  $HandoffPath
)

if ($ProjectId) {
  $argsList += "--project-id"
  $argsList += $ProjectId
}

if ($Workspace) {
  $argsList += "--workspace"
  $argsList += $Workspace
}

if ($TemplateRef) {
  $argsList += "--template-ref"
  $argsList += $TemplateRef
}

if ($ForceNew) {
  $argsList += "--force-new"
}

if ($NoLocalFiles) {
  $argsList += "--no-local-files"
}

& $npm.Source @argsList
if ($LASTEXITCODE -ne 0) {
  throw "OpenClaw client provisioning failed."
}
