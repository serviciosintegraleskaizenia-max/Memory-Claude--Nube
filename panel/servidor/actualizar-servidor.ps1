# Zentralia - sube la version nueva de los paneles al servidor (PowerShell de la PC; no hace falta administrador).
# Te pide la frase de tu llave 2 veces. Reinicia los paneles: todos vuelven a entrar con su usuario.
$ErrorActionPreference = 'Continue'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp = 'zu-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
Write-Host ''
Write-Host '== Enviando la version nueva al servidor (escribe la frase de tu llave RAPIDO)' -ForegroundColor Cyan
scp -r -q "$aqui\servidor" "zentralia:/tmp/$tmp"
if ($LASTEXITCODE -ne 0) { Write-Host 'FALLO el envio. Vuelve a pegar el comando.' -ForegroundColor Red; exit 1 }
Write-Host '== Instalando (otra vez la frase de tu llave)' -ForegroundColor Cyan
ssh zentralia "bash /tmp/$tmp/actualizar-paneles.sh"
if ($LASTEXITCODE -ne 0) { Write-Host 'La actualizacion no termino bien: mandame lo de arriba.' -ForegroundColor Red; exit 1 }
Write-Host ''
Write-Host 'Listo. Abre somosviajes.kaizenia.app y toca el boton Operaciones (solo tu lo ves mientras esta en construccion).' -ForegroundColor Green
