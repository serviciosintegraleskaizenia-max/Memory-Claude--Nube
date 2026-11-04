# =====================================================================
#  RESPALDO COMPLETO - Panel de reservas (Somos Viajes) y Kaizen IA
#  Guarda una copia completa en el USB (E:), en D: y en C:.
#
#  Que respalda:
#    1. TODAS las bases de datos del contenedor Docker (Somos Viajes "correos",
#       panel central "kaizen_central", empresas de prueba "panel_...", Chatwoot)
#    2. Los flujos de n8n y sus credenciales (cifradas) + la llave de n8n
#    3. Las carpetas C:\panel-correos y C:\kaizen-pruebas (sin node_modules ni cache)
#    4. Los paquetes de instalacion (zip) que estan en Descargas
#
#  Como usarlo (PowerShell):
#    powershell -ExecutionPolicy Bypass -File C:\Respaldos\respaldo-panel.ps1
#
#  CUIDADO: el respaldo incluye config.js, las claves de cada empresa y la llave
#  de n8n (contrasenas). Guarda el USB en un lugar seguro y no lo subas a internet.
# =====================================================================

param(
  [string[]]$Destinos = @('E:\Respaldos', 'D:\Respaldos', 'C:\Respaldos'),
  [string[]]$Carpetas = @('C:\panel-correos', 'C:\kaizen-pruebas'),
  [string]$Contenedor = 'chatwoot-postgres-1'
)

$ErrorActionPreference = 'Stop'
$fecha = Get-Date -Format 'yyyy-MM-dd_HHmm'
$nombre = "respaldo-$fecha"
$temporal = Join-Path $env:TEMP $nombre
$problemas = @()

function Paso($texto) { Write-Host ""; Write-Host "==> $texto" -ForegroundColor Cyan }
function Bien($texto) { Write-Host "    OK  $texto" -ForegroundColor Green }
function Mal($texto) { Write-Host "    ERROR  $texto" -ForegroundColor Red; $script:problemas += $texto }

New-Item -ItemType Directory -Force -Path $temporal | Out-Null
$carpetaBases = Join-Path $temporal 'bases-de-datos'
New-Item -ItemType Directory -Force -Path $carpetaBases | Out-Null

# ---------------------------------------------------------------- 1. Bases de datos
Paso "1/4 Bases de datos (Docker: $Contenedor)"
$bases = @()
try {
  $lista = docker exec $Contenedor psql -U postgres -Atc "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname"
  if ($LASTEXITCODE -ne 0) { throw "no se pudo listar las bases (codigo $LASTEXITCODE)" }
  $bases = @($lista | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^[A-Za-z0-9_]+$' })
  if (-not $bases.Count) { throw "no encontre bases de datos" }
  Write-Host ("    Bases: " + ($bases -join ', '))
} catch {
  Mal "Bases de datos: $($_.Exception.Message). Esta Docker Desktop abierto?"
}
foreach ($base in $bases) {
  try {
    docker exec $Contenedor pg_dump -U postgres -d $base -Fc -f "/tmp/$base.backup"
    if ($LASTEXITCODE -ne 0) { throw "pg_dump termino con codigo $LASTEXITCODE" }
    $destinoBase = Join-Path $carpetaBases "$base.backup"
    docker cp "${Contenedor}:/tmp/$base.backup" $destinoBase
    if ($LASTEXITCODE -ne 0) { throw "docker cp termino con codigo $LASTEXITCODE" }
    docker exec $Contenedor rm -f "/tmp/$base.backup" | Out-Null
    $tam = (Get-Item $destinoBase).Length
    $minimo = if ($base -eq 'correos') { 10000 } else { 1000 }
    if ($tam -lt $minimo) { throw "el archivo quedo muy pequeno ($tam bytes)" }
    Bien ("{0}.backup  {1:N0} bytes" -f $base, $tam)
  } catch {
    Mal "Base ${base}: $($_.Exception.Message)"
  }
}
if ($bases.Count -and -not ($bases -contains 'correos')) { Mal "No aparece la base 'correos' de Somos Viajes" }

# ---------------------------------------------------------------- 2. n8n
Paso "2/4 Flujos y credenciales de n8n"
try {
  # La ruta se arma antes: PowerShell no calcula (Join-Path ...) pegado a --output=.
  $rutaFlujos = Join-Path $temporal 'flujos.json'
  n8n export:workflow --all "--output=$rutaFlujos" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "export:workflow termino con codigo $LASTEXITCODE" }
  if (-not (Test-Path $rutaFlujos) -or (Get-Item $rutaFlujos).Length -lt 100) { throw "no se creo flujos.json" }
  Bien ("flujos.json  {0:N0} bytes" -f (Get-Item $rutaFlujos).Length)
} catch { Mal "Flujos de n8n: $($_.Exception.Message)" }
try {
  # Las credenciales salen CIFRADAS; para restaurarlas hace falta el archivo config (la llave).
  $rutaCredenciales = Join-Path $temporal 'credenciales.json'
  n8n export:credentials --all "--output=$rutaCredenciales" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "export:credentials termino con codigo $LASTEXITCODE" }
  if (-not (Test-Path $rutaCredenciales) -or (Get-Item $rutaCredenciales).Length -lt 10) { throw "no se creo credenciales.json" }
  Bien ("credenciales.json (cifradas)  {0:N0} bytes" -f (Get-Item $rutaCredenciales).Length)
} catch { Mal "Credenciales de n8n: $($_.Exception.Message)" }
$llave = Join-Path $env:USERPROFILE '.n8n\config'
if (Test-Path $llave) {
  Copy-Item $llave (Join-Path $temporal 'n8n-config') -Force
  Bien "n8n-config (llave de las credenciales)"
} else { Mal "No encontre $llave" }

# ---------------------------------------------------------------- 3. Carpetas de los paneles
Paso "3/4 Carpetas de los paneles"
foreach ($carpeta in $Carpetas) {
  if (-not (Test-Path $carpeta)) { Write-Host "    (no existe $carpeta; se omite)" -ForegroundColor Yellow; continue }
  $destinoCarpeta = Join-Path $temporal (Split-Path $carpeta -Leaf)
  robocopy $carpeta $destinoCarpeta /E /XD node_modules cache-correos /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Mal "robocopy de $carpeta termino con codigo $LASTEXITCODE"; continue }
  $n = (Get-ChildItem $destinoCarpeta -Recurse -File).Count
  Bien "$carpeta  ($n archivos)"
}

# ---------------------------------------------------------------- 4. Paquetes de instalacion
Paso "4/4 Paquetes de instalacion (Descargas)"
$descargas = Join-Path $env:USERPROFILE 'Downloads'
$patrones = @('entrega-*.zip', 'motor-sombra*.zip', 'kaizen-pruebas*.zip', 'arreglo-*.zip', 'respaldo-panel*.ps1')
$paquetes = @($patrones | ForEach-Object { Get-ChildItem (Join-Path $descargas $_) -ErrorAction SilentlyContinue })
if ($paquetes.Count) {
  $carpetaPaquetes = Join-Path $temporal 'paquetes'
  New-Item -ItemType Directory -Force -Path $carpetaPaquetes | Out-Null
  $paquetes | ForEach-Object { Copy-Item $_.FullName $carpetaPaquetes -Force }
  Bien ("{0} paquete(s): {1}" -f $paquetes.Count, (($paquetes | ForEach-Object { $_.Name }) -join ', '))
} else { Write-Host "    (no hay paquetes en Descargas; se omite)" -ForegroundColor Yellow }

# Copia de este mismo script, para tenerlo en cada respaldo.
if ($PSCommandPath) { Copy-Item $PSCommandPath $temporal -Force }

@"
RESPALDO COMPLETO - $fecha

CONTENIDO
  bases-de-datos\     Una copia por base (pg_dump formato custom):
                        correos.backup          Somos Viajes (reservas, usuarios, tiempos, historial)
                        kaizen_central.backup   Panel central de Kaizen IA (si existe)
                        panel_*.backup          Cada empresa de prueba (si existen)
                        (y la base de Chatwoot)
  flujos.json         Flujos de n8n
  credenciales.json   Credenciales de n8n (cifradas)
  n8n-config          Llave de n8n para descifrar las credenciales
  panel-correos\      Panel de Somos Viajes (incluye config.js con contrasenas)
  kaizen-pruebas\     Panel central y empresas\ (ajustes y claves de cada empresa)
  paquetes\           Paquetes de instalacion

RESTAURAR UNA BASE (PowerShell, solo si hace falta). Ejemplo con "correos":
  docker cp .\bases-de-datos\correos.backup ${Contenedor}:/tmp/correos.backup
  docker exec $Contenedor pg_restore -U postgres -d correos --clean --if-exists /tmp/correos.backup
  (si la base no existe: docker exec $Contenedor psql -U postgres -c "CREATE DATABASE correos")
n8n:
  n8n import:workflow --input=.\flujos.json
  n8n import:credentials --input=.\credenciales.json
  (si es una computadora nueva, antes copia n8n-config a %USERPROFILE%\.n8n\config)
Panel:
  copia panel-correos a C:\panel-correos, luego: cd C:\panel-correos ; npm install ; node servidor.js

NUNCA uses "docker compose down -v": borra las bases de datos.
"@ | Set-Content -Path (Join-Path $temporal 'LEEME.txt') -Encoding UTF8

$tamTotal = (Get-ChildItem $temporal -Recurse -File | Measure-Object Length -Sum).Sum

# ---------------------------------------------------------------- Copiar a E:, D: y C:
Paso ("Copiando el respaldo ({0:N1} MB) a: {1}" -f ($tamTotal / 1MB), ($Destinos -join ', '))
$guardados = @()
foreach ($destino in $Destinos) {
  $unidad = Split-Path $destino -Qualifier
  if (-not (Test-Path "$unidad\")) { Mal "La unidad $unidad no esta conectada (USB?). Se omite."; continue }
  $libre = (Get-PSDrive ($unidad.TrimEnd(':'))).Free
  if ($libre -lt ($tamTotal * 1.2)) { Mal ("{0} no tiene espacio ({1:N1} MB libres)" -f $unidad, ($libre / 1MB)); continue }
  $final = Join-Path $destino $nombre
  New-Item -ItemType Directory -Force -Path $final | Out-Null
  robocopy $temporal $final /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Mal "Fallo la copia a $final (robocopy $LASTEXITCODE)"; continue }
  $copiado = (Get-ChildItem $final -Recurse -File | Measure-Object Length -Sum).Sum
  if ($copiado -ne $tamTotal) { Mal "La copia en $final no esta completa"; continue }
  Bien $final
  $guardados += $final
}

Remove-Item $temporal -Recurse -Force

# ---------------------------------------------------------------- Resumen
Write-Host ""
Write-Host "=============================================================="
if ($guardados.Count) {
  Write-Host "Respaldo guardado en:" -ForegroundColor Green
  $guardados | ForEach-Object { Write-Host "   $_" }
  Write-Host ""
  Get-ChildItem $guardados[0] | Select-Object Name, Length | Format-Table -AutoSize
  Get-ChildItem (Join-Path $guardados[0] 'bases-de-datos') -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table -AutoSize
}
if ($problemas.Count) {
  Write-Host "ATENCION, hubo problemas:" -ForegroundColor Red
  $problemas | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
} else {
  Write-Host "Todo bien. Respaldo completo." -ForegroundColor Green
}
Write-Host "=============================================================="
