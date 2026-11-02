# =====================================================================
#  VIGILANTE DEL PANEL DE RESERVAS - Kaizen IA
#  Lo corre Windows cada 5 minutos (Programador de tareas).
#
#  - Si la base de datos (Docker: chatwoot-postgres-1) esta apagada, la enciende.
#  - Si el panel no responde 2 veces seguidas (10 minutos), lo vuelve a encender
#    en segundo plano y guarda lo que escribe en panel.log.
#  - Todo queda anotado en vigilante.log.
#
#  Para actualizar el panel sin que el vigilante lo encienda a mitad:
#  crea el archivo C:\panel-correos\MANTENIMIENTO.txt y borralo al terminar.
# =====================================================================

param(
  [string]$Panel = 'C:\panel-correos',
  [string]$Url = 'http://localhost:3001/api/empresa',
  [string]$Contenedor = 'chatwoot-postgres-1'
)

$registro = Join-Path $Panel 'vigilante.log'
$marcaFallo = Join-Path $Panel 'vigilante-fallo.txt'
function Anotar($texto) {
  $linea = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $texto
  Add-Content -Path $registro -Value $linea -Encoding UTF8
  # El registro no crece sin limite: se quedan las ultimas 2000 lineas.
  $lineas = Get-Content $registro -ErrorAction SilentlyContinue
  if ($lineas.Count -gt 2000) { $lineas | Select-Object -Last 2000 | Set-Content $registro -Encoding UTF8 }
}
function Avisar($texto) {
  # No se muestra nada en la pantalla de la oficina: el aviso le llega solo al programador
  # (el panel, al encender, le manda correo y aviso en la campanita).
}

if (Test-Path (Join-Path $Panel 'MANTENIMIENTO.txt')) { exit 0 }

# 1. Base de datos (Docker)
try {
  $corriendo = (docker inspect -f '{{.State.Running}}' $Contenedor 2>$null)
  if ($LASTEXITCODE -eq 0 -and $corriendo -ne 'true') {
    Anotar "La base de datos ($Contenedor) estaba apagada. Encendiendo..."
    docker start $Contenedor | Out-Null
    Start-Sleep -Seconds 10
    Anotar ("Base de datos: " + (docker inspect -f '{{.State.Status}}' $Contenedor 2>$null))
  }
} catch {
  Anotar "No se pudo revisar Docker: $($_.Exception.Message). Esta abierto Docker Desktop?"
}

# 2. Panel
$responde = $false
try {
  $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15
  $responde = ($r.StatusCode -eq 200)
} catch { $responde = $false }

if ($responde) {
  if (Test-Path $marcaFallo) {
    Remove-Item $marcaFallo -Force
    Anotar 'El panel volvio a responder.'
  }
  exit 0
}

if (-not (Test-Path $marcaFallo)) {
  # Primera vez sin respuesta: se espera a la proxima vuelta (puede ser una actualizacion).
  Set-Content -Path $marcaFallo -Value (Get-Date -Format s)
  Anotar 'El panel no respondio. Se vuelve a revisar en 5 minutos.'
  exit 0
}

# Segunda vez seguida: se enciende el panel.
$ocupado = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($ocupado) {
  Anotar "El puerto 3001 esta ocupado pero el panel no responde. Se cierra el proceso $($ocupado.OwningProcess)."
  Stop-Process -Id $ocupado.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}
Anotar 'Encendiendo el panel...'
$env:ARRANQUE_VIGILANTE = '1'
Start-Process -FilePath 'node' -ArgumentList 'servidor.js' -WorkingDirectory $Panel -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $Panel 'panel.log') -RedirectStandardError (Join-Path $Panel 'panel-error.log')
Start-Sleep -Seconds 15
try {
  $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15
  if ($r.StatusCode -eq 200) {
    Remove-Item $marcaFallo -Force -ErrorAction SilentlyContinue
    Anotar 'Panel encendido de nuevo.'
    Avisar 'el panel se habia caido y se volvio a encender solo.'
    exit 0
  }
} catch {}
Anotar 'El panel NO pudo encender. Revisa panel-error.log.'
Avisar 'el panel esta caido y no pudo encender solo. Revisa C:\panel-correos\panel-error.log'
