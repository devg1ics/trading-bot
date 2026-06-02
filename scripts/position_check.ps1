# Position check — run via Task Scheduler every 1 minute
$ScriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
& "$ScriptDir\run_cycle.ps1" position_check
