# Registra el vigilante del panel en el Programador de tareas de Windows (cada 5 minutos).
# Uso (PowerShell): powershell -ExecutionPolicy Bypass -File C:\panel-correos\instalar-vigilante.ps1
$script = 'C:\panel-correos\vigilante.ps1'
$nombre = 'Vigilante panel de reservas'
if (-not (Test-Path $script)) { Write-Host "No encuentro $script" -ForegroundColor Red; exit 1 }

$accion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$cada5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$alEntrar = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
$descripcion = 'Kaizen IA: enciende la base de datos y el panel de reservas si se apagan.'

$registrada = $false
try {
  # Con "al iniciar sesion" + cada 5 minutos (Windows a veces pide administrador para esto).
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger @($cada5, $alEntrar) -Settings $ajustes -Description $descripcion -Force -ErrorAction Stop | Out-Null
  $registrada = $true
} catch {
  try {
    # Sin permisos de administrador: solo cada 5 minutos (sigue funcionando despues de reiniciar).
    Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $cada5 -Settings $ajustes -Description $descripcion -Force -ErrorAction Stop | Out-Null
    $registrada = $true
  } catch {
    Write-Host ''
    Write-Host 'Windows no dejo crear la tarea (Acceso denegado).' -ForegroundColor Red
    Write-Host 'Abre PowerShell como ADMINISTRADOR (clic derecho en PowerShell > Ejecutar como administrador)' -ForegroundColor Yellow
    Write-Host 'y vuelve a correr este mismo comando.' -ForegroundColor Yellow
    exit 1
  }
}

if ($registrada) {
  Write-Host 'Listo: el vigilante revisa el panel cada 5 minutos.' -ForegroundColor Green
  Get-ScheduledTask -TaskName $nombre | Select-Object TaskName, State | Format-Table -AutoSize
}
