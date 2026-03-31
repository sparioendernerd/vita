# run.ps1 — Start the VITA node using the local venv
# Usage: .\run.ps1
# Run from the VITA/node directory

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $ScriptDir ".venv\Scripts\python.exe"

if (-not (Test-Path $Venv)) {
    Write-Error "venv not found. Run setup.ps1 first."
    exit 1
}

Write-Host "Starting VITA node..." -ForegroundColor Cyan
& $Venv -m src.main @args
