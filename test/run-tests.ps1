#!/usr/bin/env pwsh
# Rebuild and run the automated test suite that does not need a browser.
# Browser E2E is run separately via test/e2e.mjs once Chrome CDP is running.
#   1. Go unit tests
#   2. Start a mock DeepSeek upstream
#   3. Start the app against the mock
#   4. Node integration/protocol tests
#   5. DOM-level UI test
#   6. Stop everything
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:GOCACHE = Join-Path $root '.gocache'
$env:GOMODCACHE = Join-Path $root '.gomodcache'
New-Item -ItemType Directory -Path $env:GOCACHE -Force | Out-Null
New-Item -ItemType Directory -Path $env:GOMODCACHE -Force | Out-Null

Write-Host '==> Go tests'
go test ./...
if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }

Write-Host '==> Build'
go build -o politicsqa.exe .
if ($LASTEXITCODE -ne 0) { throw 'Go build failed' }

Write-Host '==> Node unit tests'
node test/unit.mjs
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed' }

$mockLog = Join-Path $root '.mock-test-out.log'
$mockErr = Join-Path $root '.mock-test-err.log'
$appLog = Join-Path $root '.app-test-out.log'
$appErr = Join-Path $root '.app-test-err.log'

$env:MOCK_PORT = '9017'
$mock = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('test/mock-upstream.mjs') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $mockLog -RedirectStandardError $mockErr -PassThru
$app = $null
try {
  Start-Sleep -Milliseconds 900
  $app = Start-Process -FilePath (Join-Path $root 'politicsqa.exe') -ArgumentList @('-no-open', '-port', '5199', '-upstream', 'http://127.0.0.1:9017', '-data', $root) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $appLog -RedirectStandardError $appErr -PassThru
  Start-Sleep -Milliseconds 1200

  Write-Host '==> Integration tests'
  node test/integration.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Integration tests failed' }

  Write-Host '==> Protocol tests'
  node test/protocol.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Protocol tests failed' }

  Write-Host '==> DOM end-to-end tests'
  node test/dom-e2e.mjs
  if ($LASTEXITCODE -ne 0) { throw 'DOM E2E tests failed' }

  Write-Host '==> Real-UI request audit'
  if (Test-NetConnection -ComputerName 127.0.0.1 -Port 9223 -InformationLevel Quiet -WarningAction SilentlyContinue) {
    node test/request-audit.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Request audit failed' }
  } else {
    Write-Host 'Skipped: no Chrome CDP endpoint on 9223.'
  }
} finally {
  if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
  if ($mock -and -not $mock.HasExited) { Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue }
}
Write-Host 'All automated tests passed.'
