# Zentralia - instala la versión nueva en el servidor.
# Solo te pide la contraseña de tu llave UNA vez: sube el paquete y lo instala en la misma conexión.
# Si el paquete trae la carpeta panel-cliente, también instala el panel del cliente (antes que Oficina).
$ErrorActionPreference = 'Stop'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp = 'zu-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$tgz = Join-Path $env:TEMP "$tmp.tgz"
Write-Host ''
if (-not (Test-Path (Join-Path $aqui 'servidor\panel\index.html'))) {
  Write-Host 'No encuentro la carpeta servidor. Extrae el zip completo y ejecuta este archivo desde esa carpeta.' -ForegroundColor Red
  exit 1
}
$conPanelCliente = Test-Path (Join-Path $aqui 'panel-cliente\servidor.js')
$carpetas = @('servidor')
if ($conPanelCliente) { $carpetas += 'panel-cliente' }
Write-Host '== Preparando la versión nueva' -ForegroundColor Cyan
tar -czf $tgz -C $aqui $carpetas
if ($LASTEXITCODE -ne 0) { Write-Host 'No pude preparar el paquete.' -ForegroundColor Red; exit 1 }
$pasos = "bash /tmp/$tmp/servidor/actualizar-paneles.sh"
if ($conPanelCliente) { $pasos = "bash /tmp/$tmp/panel-cliente/instalar-panel-cliente.sh && $pasos" }
Write-Host '== Instalando en el servidor. Escribe la contraseña de tu llave UNA vez.' -ForegroundColor Cyan
cmd /c "ssh zentralia `"mkdir -p /tmp/$tmp && tar -xzf - -C /tmp/$tmp && $pasos && rm -rf /tmp/$tmp`" < `"$tgz`""
$codigo = $LASTEXITCODE
Remove-Item $tgz -ErrorAction SilentlyContinue
if ($codigo -ne 0) { Write-Host 'La instalación no terminó bien: mándame lo de arriba.' -ForegroundColor Red; exit 1 }
Write-Host ''
if ($conPanelCliente) { Write-Host 'Listo. Oficina y el panel del cliente quedaron actualizados.' -ForegroundColor Green }
else { Write-Host 'Listo. Abre el panel de Somos Viajes y revisa la cabecera.' -ForegroundColor Green }
