$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  @"
cd '$backend'
if (!(Test-Path '.venv')) { python -m venv .venv }
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
"@
)

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  @"
cd '$frontend'
npm install
npm run dev
"@
)

Write-Host "Backend/Frontend dev servers launching in new terminals..."
