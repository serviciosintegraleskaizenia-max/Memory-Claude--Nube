# Zentralia - configura el respaldo automatico (una sola vez; se puede repetir sin problema).
#  1. Guarda la contrasena de la copia de Google Drive, cifrada con tu usuario de Windows.
#  2. Crea la tarea de Windows "Zentralia - Respaldo diario" (cada dia a las 3:00 a. m.).
#  3. Hace un primer respaldo para comprobar que todo funciona.
# Uso: powershell -ExecutionPolicy Bypass -File C:\panel-correos\configurar-respaldo.ps1   (agrega -NuevaClave para cambiar la contrasena)
param([switch]$NuevaClave, [switch]$SinPrueba)
$ErrorActionPreference = 'Stop'
$base = 'C:\Respaldos Zentralia'
$archivoClave = Join-Path $base 'clave-respaldo.dat'
$script = 'C:\panel-correos\respaldo-zentralia.js'
if (-not (Test-Path $script)) { Write-Host "No encuentro $script" -ForegroundColor Red; exit 1 }
New-Item -ItemType Directory -Force -Path $base | Out-Null

Write-Host ""
Write-Host "1/3  Contrasena de la copia de Google Drive" -ForegroundColor Cyan
if ((Test-Path $archivoClave) -and -not $NuevaClave) {
  Write-Host "     Ya hay una contrasena guardada (para cambiarla: agrega -NuevaClave)."
} else {
  Write-Host "     Esta contrasena cifra la copia que sube a Google Drive. APUNTALA EN PAPEL:" -ForegroundColor Yellow
  Write-Host "     sin ella esa copia no se puede abrir (ni Google, ni nadie, ni yo)." -ForegroundColor Yellow
  while ($true) {
    $c1 = Read-Host "     Escribe la contrasena (minimo 8 caracteres, no se va a ver)" -AsSecureString
    $c2 = Read-Host "     Repitela" -AsSecureString
    $t1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($c1))
    $t2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($c2))
    if ($t1 -ne $t2) { Write-Host "     No coinciden. Otra vez." -ForegroundColor Red; continue }
    if ($t1.Length -lt 8) { Write-Host "     Muy corta: minimo 8 caracteres." -ForegroundColor Red; continue }
    break
  }
  $c1 | ConvertFrom-SecureString | Set-Content -LiteralPath $archivoClave
  $t1 = $null; $t2 = $null
  Write-Host "     OK  guardada (cifrada con tu usuario de Windows)." -ForegroundColor Green
}

Write-Host ""
Write-Host "2/3  Tarea de Windows: cada dia a las 3:00 a. m." -ForegroundColor Cyan
$node = (Get-Command node -ErrorAction Stop).Source
$accion = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --automatico" -WorkingDirectory 'C:\panel-correos'
$hora = New-ScheduledTaskTrigger -Daily -At '3:00AM'
$ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$quien = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Zentralia - Respaldo diario' -Action $accion -Trigger $hora -Settings $ajustes -Principal $quien `
  -Description 'Respaldo de Zentralia en USB, C:, D: y Google Drive (cifrado). Lo creo configurar-respaldo.ps1.' -Force | Out-Null
$t = Get-ScheduledTask -TaskName 'Zentralia - Respaldo diario'
Write-Host ("     OK  tarea creada (proxima vez: {0})" -f ((Get-ScheduledTaskInfo -TaskName 'Zentralia - Respaldo diario').NextRunTime)) -ForegroundColor Green

if (-not $SinPrueba) {
  Write-Host ""
  Write-Host "3/3  Primer respaldo (tarda un par de minutos)" -ForegroundColor Cyan
  $ErrorActionPreference = 'Continue'
  & $node $script
  Write-Host ""
  Write-Host "     El resultado tambien se ve en la Oficina -> Respaldos." -ForegroundColor Gray
}
