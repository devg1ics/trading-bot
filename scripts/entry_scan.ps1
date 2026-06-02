# Entry scan — run via Task Scheduler every 15 minutes
$ScriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
& "$ScriptDir\run_cycle.ps1" entry_scan
