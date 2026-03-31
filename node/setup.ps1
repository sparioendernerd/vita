# setup.ps1 — Create venv and install all dependencies for the VITA node
# Usage: .\setup.ps1
# Run from the VITA/node directory

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $ScriptDir ".venv"

Write-Host "Setting up VITA node virtual environment..." -ForegroundColor Cyan

# Create venv if it doesn't exist
if (-not (Test-Path "$Venv\Scripts\python.exe")) {
    Write-Host "Creating venv at $Venv..." -ForegroundColor Yellow
    python -m venv $Venv
} else {
    Write-Host "Venv already exists, skipping creation." -ForegroundColor Green
}

# Install / sync packages
Write-Host "Installing dependencies..." -ForegroundColor Yellow
& "$Venv\Scripts\pip" install -e ".[dev]"

Write-Host ""
Write-Host "Done! To use the venv tools:" -ForegroundColor Green
Write-Host "  Record a sample : .venv\Scripts\lwake record src\wakeword\refs\sample-1.wav" -ForegroundColor White
Write-Host "  Compare samples : .venv\Scripts\lwake compare src\wakeword\refs\sample-1.wav src\wakeword\refs\sample-2.wav" -ForegroundColor White
Write-Host "  Test live       : .venv\Scripts\lwake listen src\wakeword\refs 0.1 --debug" -ForegroundColor White
Write-Host "  Run node        : .\run.ps1" -ForegroundColor White
