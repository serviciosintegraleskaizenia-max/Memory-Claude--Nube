# =====================================================================
#  INICIAR TODO - Zentralia App (doble clic en el icono del escritorio "Iniciar Zentralia")
#
#  Enciende, en orden, lo que haga falta (lo que ya esta encendido no se toca):
#    1. Docker Desktop y sus contenedores (base de datos y Chatwoot)
#    2. n8n                                  -> http://localhost:5678
#    3. Panel de Somos Viajes                -> http://localhost:3001
#    4. Panel central de pruebas (si existe) -> http://localhost:3090
#    5. Tunel de Cloudflare (si esta instalado)
#    6. Chatwoot (redes sociales)            -> http://localhost:3000
#  Y al final abre cada uno en el navegador.
#
#  Los registros quedan en C:\panel-correos\logs\
# =====================================================================

param(
  [string]$Panel = 'C:\panel-correos',
  [string]$Central = 'C:\kaizen-pruebas',
  [string]$ContenedorBase = 'chatwoot-postgres-1',
  [string]$CarpetaChatwoot = 'C:\chatwoot',
  [int]$PuertoChatwoot = 3000,
  [switch]$SinNavegador
)

$Host.UI.RawUI.WindowTitle = 'Zentralia App - Iniciando todo'
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
Paso '1/6 Docker (base de datos y Chatwoot)'
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
$composeChatwoot = @('docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml') | ForEach-Object { Join-Path $CarpetaChatwoot $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($dockerListo -and $composeChatwoot) {
  # Chatwoot completo (web, sidekiq, redis y la base de datos) con su docker compose. Lo que ya esta encendido no se toca.
  Info 'Encendiendo Chatwoot y la base de datos (docker compose)...'
  Push-Location $CarpetaChatwoot
  docker compose -f $composeChatwoot up -d *> (Join-Path $logs 'chatwoot.log')
  if ($LASTEXITCODE -ne 0) { Info "docker compose dio un aviso. Revisa $logs\chatwoot.log" }
  Pop-Location
}
if ($dockerListo) {
  # Por si quedo algun contenedor de Chatwoot apagado fuera del compose.
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
Paso '2/6 n8n'
if (Escucha 5678) { Bien 'n8n ya estaba encendido' }
else {
  Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -ArgumentList '/c', "n8n start > `"$logs\n8n.log`" 2>&1"
  if (Esperar 'http://localhost:5678/healthz' 90) { Bien 'n8n encendido' } else { Mal "n8n no encendio. Revisa $logs\n8n.log" }
}

# ---------------------------------------------------------------- 3. Panel de Somos Viajes
Paso '3/6 Panel de Somos Viajes'
if (Escucha 3001) { Bien 'El panel ya estaba encendido' }
elseif (-not (Test-Path (Join-Path $Panel 'servidor.js'))) { Mal "No encontre $Panel\servidor.js" }
else {
  $env:PANEL_CONFIG = ''
  Start-Process -FilePath 'node' -ArgumentList 'servidor.js' -WorkingDirectory $Panel -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Panel 'panel.log') -RedirectStandardError (Join-Path $Panel 'panel-error.log')
  if (Esperar 'http://localhost:3001/api/empresa' 60) { Bien 'Panel encendido' } else { Mal "El panel no encendio. Revisa $Panel\panel-error.log" }
}

# ---------------------------------------------------------------- 4. Panel central de pruebas
Paso '4/6 Panel central de pruebas'
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
Paso '5/6 Tunel de Cloudflare'
$tunel = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if (-not $tunel) { Info 'No esta instalado todavia (guia del tunel). Se omite.' }
elseif ($tunel.Status -eq 'Running') { Bien 'Tunel activo: somosviajes.kaizenia.app' }
else {
  try { Start-Service -Name 'cloudflared' -ErrorAction Stop; Bien 'Tunel encendido' }
  catch { Mal 'El tunel esta apagado y Windows no dejo encenderlo (dale doble clic al icono como administrador una vez).' }
}

# ---------------------------------------------------------------- 6. Chatwoot
Paso '6/6 Chatwoot (redes sociales)'
$chatwootListo = $false
if (-not $dockerListo) { Mal 'Chatwoot no encendio porque Docker no esta encendido.' }
elseif (-not $composeChatwoot -and -not (docker ps -a --filter 'name=chatwoot-rails' --format '{{.Names}}')) { Info "No esta instalado ($CarpetaChatwoot). Se omite." }
else {
  Info 'Esperando a que Chatwoot responda (la primera vez tarda 1 o 2 minutos)...'
  if (Esperar "http://localhost:$PuertoChatwoot/" 180) { $chatwootListo = $true; Bien "Chatwoot encendido: http://localhost:$PuertoChatwoot  (redes.kaizenia.app)" }
  else { Mal "Chatwoot todavia no responde. Espera 2 minutos y abre http://localhost:$PuertoChatwoot . Si sigue sin abrir, revisa $logs\chatwoot.log" }
}

# ---------------------------------------------------------------- Navegador
if (-not $SinNavegador) {
  $paginas = @('http://localhost:3001')
  if (Test-Path $configCentral) { $paginas += 'http://localhost:3090' }
  $paginas += 'http://localhost:5678'
  if ($chatwootListo) { $paginas += "http://localhost:$PuertoChatwoot" }
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
