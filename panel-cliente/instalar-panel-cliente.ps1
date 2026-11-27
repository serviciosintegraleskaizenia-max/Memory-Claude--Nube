# Zentralia - instala el panel del cliente en el servidor.
# Solo te pide la contraseña de tu llave UNA vez: sube el paquete y lo instala en la misma conexión.
$ErrorActionPreference = 'Stop'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp = 'zpc-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$tgz = Join-Path $env:TEMP "$tmp.tgz"
Write-Host ''
if (-not (Test-Path (Join-Path $aqui 'panel-cliente\servidor.js'))) {
  Write-Host 'No encuentro la carpeta panel-cliente. Extrae el zip completo y ejecuta este archivo desde esa carpeta.' -ForegroundColor Red
  exit 1
}
Write-Host '== Preparando el panel del cliente' -ForegroundColor Cyan
tar -czf $tgz -C $aqui panel-cliente
if ($LASTEXITCODE -ne 0) { Write-Host 'No pude preparar el paquete.' -ForegroundColor Red; exit 1 }
Write-Host '== Instalando en el servidor. Escribe la contraseña de tu llave UNA vez.' -ForegroundColor Cyan
cmd /c "ssh zentralia `"mkdir -p /tmp/$tmp && tar -xzf - -C /tmp/$tmp && bash /tmp/$tmp/panel-cliente/instalar-panel-cliente.sh`" < `"$tgz`""
$codigo = $LASTEXITCODE
Remove-Item $tgz -ErrorAction SilentlyContinue
if ($codigo -ne 0) { Write-Host 'La instalación no terminó bien: mándame lo de arriba.' -ForegroundColor Red; exit 1 }
Write-Host ''
Write-Host 'Listo. El panel del cliente quedó instalado en el servidor.' -ForegroundColor Green
