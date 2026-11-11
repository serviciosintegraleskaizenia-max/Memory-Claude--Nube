# Zentralia - Respaldo desde el servidor (se corre una vez en la PC, PowerShell como administrador).
#  1. Pone en C:\panel-correos el respaldo nuevo (baja la copia del servidor) y el programa para abrir copias.
#  2. Crea una llave SOLO para respaldos (sin frase): en el servidor solo puede bajar copias, nada mas.
#  3. Instala en el servidor el respaldo de las 2:00 a. m., el boton de la Oficina y actualiza los paneles.
#  4. Programa la tarea de Windows de las 3:00 a. m. que baja la copia al USB, C:, D: y Google Drive.
#  5. Hace la primera bajada para comprobar que todo funciona.
$ErrorActionPreference = 'Stop'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$ip = '2.25.172.8'
$base = 'C:\Respaldos Zentralia'
$panel = 'C:\panel-correos'
$llave = Join-Path $env:USERPROFILE '.ssh\zentralia-respaldo'
function P($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    OK  $t" -ForegroundColor Green }
function Falla($t) { Write-Host ''; Write-Host "    FALLA: $t" -ForegroundColor Red; Write-Host '    No sigas: mandame este mensaje.' -ForegroundColor Red; exit 1 }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Falla 'abre PowerShell como ADMINISTRADOR y vuelve a pegar el comando' }
if (-not (Test-Path $panel)) { Falla "no encuentro $panel" }
New-Item -ItemType Directory -Force -Path $base | Out-Null

P '1/5 Programas del respaldo en esta PC'
Copy-Item "$aqui\pc\respaldo-zentralia.js", "$aqui\pc\restaurar-respaldo.js" $panel -Force
Ok "Copiados a $panel"

P '2/5 Llave solo para respaldos'
if (-not (Test-Path $llave)) {
  & ssh-keygen -t ed25519 -N '""' -C 'zentralia-respaldo-pc' -f $llave -q
  if (-not (Test-Path "$llave.pub")) { Falla 'no se pudo crear la llave de respaldos' }
  Ok 'Llave creada (solo sirve para bajar respaldos)'
} else { Ok 'Ya existia' }
Copy-Item "$llave.pub" "$aqui\servidor\llave-pc.pub" -Force

P '3/5 Instalando en el servidor (te pide la frase de tu llave 2 veces: escribela RAPIDO)'
$tmp = 'zr-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$ErrorActionPreference = 'Continue'
scp -r "$aqui\servidor" "zentralia:/tmp/$tmp"
if ($LASTEXITCODE -ne 0) { Falla 'no se pudo enviar al servidor (vuelve a pegar el comando)' }
Write-Host ''
Write-Host '    Ahora el servidor te pide la CONTRASENA DE LOS RESPALDOS (no la de tu llave).' -ForegroundColor Yellow
Write-Host '    Usa la misma de la copia de Google Drive de antes y APUNTALA EN PAPEL.' -ForegroundColor Yellow
ssh -t zentralia "bash /tmp/$tmp/instalar-respaldo.sh"
if ($LASTEXITCODE -ne 0) { Falla 'la instalacion en el servidor no termino bien (mira el mensaje de arriba)' }
$ErrorActionPreference = 'Stop'

P '4/5 Tarea de Windows: cada dia a las 3:00 a. m.'
$cfg = [ordered]@{ host = $ip; usuario = 'root'; llave = $llave } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $base 'servidor.json'), $cfg)
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $panel 'respaldo-zentralia.js'
$accion = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --automatico" -WorkingDirectory $panel
$hora = New-ScheduledTaskTrigger -Daily -At '3:00AM'
$ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 4)
$quien = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Zentralia - Respaldo diario' -Action $accion -Trigger $hora -Settings $ajustes -Principal $quien `
  -Description 'Baja la copia cifrada del servidor y la guarda en USB, C:, D: y Google Drive.' -Force | Out-Null
Enable-ScheduledTask -TaskName 'Zentralia - Respaldo diario' | Out-Null
Ok ("Tarea lista (proxima vez: {0})" -f ((Get-ScheduledTaskInfo -TaskName 'Zentralia - Respaldo diario').NextRunTime))

P '5/5 Primera bajada (unos minutos, segun tu internet)'
$ErrorActionPreference = 'Continue'
& $node $script
Write-Host ''
Write-Host '==============================================================' -ForegroundColor Green
Write-Host ' Listo. El estado se ve en oficina.kaizenia.app -> Respaldos.' -ForegroundColor Green
Write-Host '==============================================================' -ForegroundColor Green
