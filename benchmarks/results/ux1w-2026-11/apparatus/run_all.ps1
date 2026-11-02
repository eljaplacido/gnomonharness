# UX1W measured phases, in the pre-registered order. Launched detached (WMI) so it
# survives the SSH session; progress in C:\dev\ux1w\run-all.log.
$py = 'C:\Python314\python.exe'
Set-Location 'C:\dev\ux1w\apparatus'
$log = 'C:\dev\ux1w\run-all.log'
"START $(Get-Date -Format o)" | Add-Content $log
foreach ($ph in @(@('warm', '20'), @('session', '10'), @('first', '3'), @('calib', '20'))) {
    "PHASE $($ph[0]) $(Get-Date -Format o)" | Add-Content $log
    & $py -u run_ux1w.py $ph[0] $ph[1] *>> $log
    "PHASE $($ph[0]) exit $LASTEXITCODE" | Add-Content $log
}
"ALL DONE $(Get-Date -Format o)" | Add-Content $log
