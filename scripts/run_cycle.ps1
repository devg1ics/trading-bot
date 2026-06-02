# Trading Bot Cycle Runner (Windows PowerShell)
# Usage:
#   .\scripts\run_cycle.ps1 entry_scan
#   .\scripts\run_cycle.ps1 position_check

param(
    [string]$Cycle = "entry_scan"
)

$BotDir = Split-Path $PSScriptRoot -Parent
$LogDir = Join-Path $BotDir "state\logs"
$HaltFile = Join-Path $env:TEMP "HALT_TRADING"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null }

$LogFile = Join-Path $LogDir "${Cycle}_$(Get-Date -Format 'yyyyMMdd').log"
$Timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

"────────────────────────────────" | Tee-Object -FilePath $LogFile -Append
"[$Timestamp] Starting $Cycle" | Tee-Object -FilePath $LogFile -Append

# Check kill switch
if (Test-Path $HaltFile) {
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    "[$ts] HALT_TRADING file exists — aborting" | Tee-Object -FilePath $LogFile -Append
    exit 0
}

# Select prompt based on cycle type
if ($Cycle -eq "entry_scan") {
    $Prompt = "Run an entry scan cycle as defined in CLAUDE.md. Check market conditions for all allowed pairs (BTCUSDT, ETHUSDT, SOLUSDT), reason about edge, and place orders only if clear edge exists with proper risk management. Write your decision to state/decisions.jsonl"
} elseif ($Cycle -eq "position_check") {
    $Prompt = "Run a position check cycle as defined in CLAUDE.md. Review all open positions, check if any time stops or thesis invalidations apply, and close positions if needed. Write your decision to state/decisions.jsonl"
} else {
    "Unknown cycle type: $Cycle" | Tee-Object -FilePath $LogFile -Append
    exit 1
}

# Run Claude Code from the bot directory
Set-Location $BotDir
$Output = claude --print $Prompt 2>&1
$ExitCode = $LASTEXITCODE
$Output | Tee-Object -FilePath $LogFile -Append

$ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
"[$ts] Cycle complete (exit: $ExitCode)" | Tee-Object -FilePath $LogFile -Append
exit $ExitCode
