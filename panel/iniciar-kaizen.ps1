# =====================================================================
#  INICIAR TODO - Kaizen IA (doble clic en el icono del escritorio)
#
#  Enciende, en orden, lo que haga falta (lo que ya esta encendido no se toca):
#    1. Docker Desktop y sus contenedores (base de datos y Chatwoot)
#    2. n8n                                  -> http://localhost:5678
#    3. Panel de Somos Viajes                -> http://localhost:3001
#    4. Panel central de pruebas (si existe) -> http://localhost:3090
#    5. Tunel de Cloudflare (si esta instalado)
#  Y al final abre cada uno en el navegador.
#
#  Los registros quedan en C:\panel-correos\logs\
# =====================================================================

param(
  [string]$Panel = 'C:\panel-correos',
  [string]$Central = 'C:\kaizen-pruebas',
  [string]$ContenedorBase = 'chatwoot-postgres-1',
  [switch]$SinNavegador
)

$Host.UI.RawUI.WindowTitle = 'Kaizen IA - Iniciando todo'
$logs = Join-Path $Panel 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$resumen = @()

function Paso($texto) { Write-Host ''; Write-Host "==> $texto" -ForegroundColor Cyan }
function Bien($texto) { Write-Host "    OK  $texto" -ForegroundColor Green; $script:resumen += "OK     $texto" }
function Mal($texto) { Write-Host "    FALLA  $texto" -ForegroundColor Red; $script:resumen += "FALLA  $texto" }
function Info($texto) { Write-Host "    $texto" -ForegroundColor Gray }

function Escucha($puerto) {
  return [bool](Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue)
}
function Responde($url, $segundos = 5) {
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $segundos; return $r.StatusCode -lt 500 } catch { return $false }
}
function Esperar($url, $maximo) {
  for ($i = 0; $i -lt $maximo; $i += 3) {
    if (Responde $url 3) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

# ---------------------------------------------------------------- 1. Docker
Paso '1/5 Docker (base de datos y Chatwoot)'
$dockerListo = $false
docker info *> $null
if ($LASTEXITCODE -eq 0) { $dockerListo = $true }
else {
  $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $exe) {
    Info 'Abriendo Docker Desktop (puede tardar 1 o 2 minutos)...'
    Start-Process -FilePath $exe
    for ($i = 0; $i -lt 180; $i += 5) {
      Start-Sleep -Seconds 5
      docker info *> $null
      if ($LASTEXITCODE -eq 0) { $dockerListo = $true; break }
    }
  } else { Info "No encontre Docker Desktop en $exe" }
}
if ($dockerListo) {
  # Se encienden los contenedores de Chatwoot (incluye la base de datos) que esten apagados.
  $apagados = docker ps -a --filter 'status=exited' --filter 'name=chatwoot' --format '{{.Names}}'
  foreach ($c in $apagados) { if ($c) { docker start $c | Out-Null; Info "Encendido: $c" } }
  $listaBase = $false
  for ($i = 0; $i -lt 60; $i += 3) {
    docker exec $ContenedorBase pg_isready -U postgres *> $null
    if ($LASTEXITCODE -eq 0) { $listaBase = $true; break }
    Start-Sleep -Seconds 3
  }
  if ($listaBase) { Bien 'Base de datos lista' } else { Mal "La base de datos ($ContenedorBase) no responde" }
} else { Mal 'Docker no encendio. Abre Docker Desktop a mano y vuelve a dar doble clic.' }

# ---------------------------------------------------------------- 2. n8n
Paso '2/5 n8n'
if (Escucha 5678) { Bien 'n8n ya estaba encendido' }
else {
  Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -ArgumentList '/c', "n8n start > `"$logs\n8n.log`" 2>&1"
  if (Esperar 'http://localhost:5678/healthz' 90) { Bien 'n8n encendido' } else { Mal "n8n no encendio. Revisa $logs\n8n.log" }
}

# ---------------------------------------------------------------- 3. Panel de Somos Viajes
Paso '3/5 Panel de Somos Viajes'
if (Escucha 3001) { Bien 'El panel ya estaba encendido' }
elseif (-not (Test-Path (Join-Path $Panel 'servidor.js'))) { Mal "No encontre $Panel\servidor.js" }
else {
  $env:PANEL_CONFIG = ''
  Start-Process -FilePath 'node' -ArgumentList 'servidor.js' -WorkingDirectory $Panel -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Panel 'panel.log') -RedirectStandardError (Join-Path $Panel 'panel-error.log')
  if (Esperar 'http://localhost:3001/api/empresa' 60) { Bien 'Panel encendido' } else { Mal "El panel no encendio. Revisa $Panel\panel-error.log" }
}

# ---------------------------------------------------------------- 4. Panel central de pruebas
Paso '4/5 Panel central de pruebas'
$configCentral = Join-Path $Central 'config-central.js'
if (-not (Test-Path $configCentral)) { Info 'No esta instalado (C:\kaizen-pruebas). Se omite.' }
elseif (Escucha 3090) { Bien 'El central ya estaba encendido' }
else {
  $env:PANEL_CONFIG = $configCentral
  Start-Process -FilePath 'node' -ArgumentList 'servidor.js' -WorkingDirectory $Central -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Central 'central.log') -RedirectStandardError (Join-Path $Central 'central-error.log')
  $env:PANEL_CONFIG = ''
  if (Esperar 'http://localhost:3090/api/empresa' 60) { Bien 'Central encendido (enciende solo sus empresas y la demo)' } else { Mal "El central no encendio. Revisa $Central\central-error.log" }
}

# ---------------------------------------------------------------- 5. Tunel de Cloudflare
Paso '5/5 Tunel de Cloudflare'
$tunel = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if (-not $tunel) { Info 'No esta instalado todavia (guia del tunel). Se omite.' }
elseif ($tunel.Status -eq 'Running') { Bien 'Tunel activo: somosviajes.kaizenia.app' }
else {
  try { Start-Service -Name 'cloudflared' -ErrorAction Stop; Bien 'Tunel encendido' }
  catch { Mal 'El tunel esta apagado y Windows no dejo encenderlo (dale doble clic al icono como administrador una vez).' }
}

# ---------------------------------------------------------------- Navegador
if (-not $SinNavegador) {
  $paginas = @('http://localhost:3001')
  if (Test-Path $configCentral) { $paginas += 'http://localhost:3090' }
  $paginas += 'http://localhost:5678'
  $chatwoot = docker ps --filter 'name=chatwoot' --format '{{.Ports}}' 2>$null | Select-String -Pattern '0\.0\.0\.0:(\d+)->3000' | Select-Object -First 1
  if ($chatwoot) { $paginas += 'http://localhost:' + $chatwoot.Matches[0].Groups[1].Value }
  foreach ($p in $paginas) { Start-Process $p; Start-Sleep -Milliseconds 400 }
}

Write-Host ''
Write-Host '=============================================================='
$resumen | ForEach-Object { if ($_ -like 'OK*') { Write-Host $_ -ForegroundColor Green } else { Write-Host $_ -ForegroundColor Red } }
Write-Host '=============================================================='
if ($resumen | Where-Object { $_ -like 'FALLA*' }) {
  Write-Host 'Algo no encendio. Lee el mensaje en rojo de arriba.' -ForegroundColor Yellow
  Read-Host 'Pulsa Enter para cerrar'
} else {
  Write-Host 'Todo encendido. Esta ventana se cierra sola en 10 segundos.' -ForegroundColor Green
  Start-Sleep -Seconds 10
}
