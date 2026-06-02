# Toggle the kill switch
param([switch]$Resume)
$HaltFile = Join-Path $env:TEMP "HALT_TRADING"
if ($Resume) {
    if (Test-Path $HaltFile) { Remove-Item $HaltFile }
    Write-Host "Trading RESUMED — halt file removed" -ForegroundColor Green
} else {
    Set-Content $HaltFile (Get-Date).ToUniversalTime().ToString("o")
    Write-Host "Trading HALTED — halt file created at $HaltFile" -ForegroundColor Red
}
