# Registra el vigilante del panel en el Programador de tareas de Windows (cada 5 minutos).
# Uso (PowerShell): powershell -ExecutionPolicy Bypass -File C:\panel-correos\instalar-vigilante.ps1
$script = 'C:\panel-correos\vigilante.ps1'
if (-not (Test-Path $script)) { Write-Host "No encuentro $script" -ForegroundColor Red; exit 1 }
$accion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$cada5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$alEntrar = New-ScheduledTaskTrigger -AtLogOn
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
Register-ScheduledTask -TaskName 'Vigilante panel de reservas' -Action $accion -Trigger @($cada5, $alEntrar) -Settings $ajustes `
  -Description 'Kaizen IA: enciende la base de datos y el panel de reservas si se apagan.' -Force | Out-Null
Write-Host 'Listo: el vigilante revisa el panel cada 5 minutos.' -ForegroundColor Green
Get-ScheduledTask -TaskName 'Vigilante panel de reservas' | Select-Object TaskName, State
