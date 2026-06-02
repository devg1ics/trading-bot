# Trading Bot Launcher (Windows)
# Run this script to start the dashboard state server and open the dashboard.
# Keep this window open while trading.

$BotDir = Split-Path $MyInvocation.MyCommand.Path -Parent

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  CLAUDE TRADING BOT — Windows Launcher" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Check Node is available
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Check API keys are configured
$McpConfig = "$env:USERPROFILE\.claude\mcp.json"
if (-not (Test-Path $McpConfig)) {
    Write-Host "WARNING: $McpConfig not found." -ForegroundColor Yellow
    Write-Host "Copy mcp.json.template to $McpConfig and fill in your API keys." -ForegroundColor Yellow
    Write-Host ""
}

# Ensure state dir exists
$StateDir = Join-Path $BotDir "state\logs"
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }

Write-Host "Starting state server on http://localhost:3001 ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "node '$BotDir\state-server.js'" -WindowStyle Normal

Start-Sleep -Seconds 1

Write-Host "Opening dashboard..." -ForegroundColor Green
Start-Process (Join-Path $BotDir "dashboard\index.html")

Write-Host ""
Write-Host "Bot is ready. To run a cycle manually:" -ForegroundColor Cyan
Write-Host "  .\scripts\run_cycle.ps1 entry_scan" -ForegroundColor White
Write-Host "  .\scripts\run_cycle.ps1 position_check" -ForegroundColor White
Write-Host ""
Write-Host "Kill switch:" -ForegroundColor Cyan
Write-Host "  .\scripts\halt.ps1          # halt trading" -ForegroundColor White
Write-Host "  .\scripts\halt.ps1 -Resume  # resume trading" -ForegroundColor White
