# Wrapper invoked by Windows Task Scheduler. Usage: run_job.ps1 <ingest|personalize|send>
param(
  [Parameter(Mandatory=$true)][ValidateSet('ingest','personalize','send','check:acceptances','replies')]
  [string]$Job
)

$ErrorActionPreference = 'Continue'
$root = 'D:\linkedin leads'
Set-Location $root

$triggersDir = Join-Path $root '.tmp\triggers'
if (-not (Test-Path $triggersDir)) { New-Item -ItemType Directory -Force $triggersDir | Out-Null }

$today = (Get-Date).ToString('yyyy-MM-dd')
$log   = Join-Path $triggersDir "$Job.$today.log"
$heart = Join-Path $triggersDir "$Job.last.log"
$err   = Join-Path $triggersDir "$Job.errors.log"

$stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
"---- $stamp $Job ----" | Add-Content $log -Encoding utf8

try {
  # Capture both stdout + stderr; `npm run` exits with the underlying script's code.
  # NOTE: Tee-Object defaults to UTF-16 on Windows PowerShell 5.1, which makes logs
  # unreadable with standard tools. Stream output through Out-String -> Add-Content
  # with explicit UTF-8 encoding instead.
  $output = & npm.cmd run $Job 2>&1 | Out-String
  $code = $LASTEXITCODE
  $output | Add-Content $log -Encoding utf8

  if ($code -ne 0) {
    "$stamp $Job exited $code" | Add-Content $err -Encoding utf8
  }
  "$stamp $Job exit=$code" | Set-Content $heart -Encoding utf8
  exit $code
}
catch {
  "$stamp $Job EXCEPTION: $($_.Exception.Message)" | Add-Content $err -Encoding utf8
  "$stamp $Job EXCEPTION" | Set-Content $heart -Encoding utf8
  exit 99
}
