# Crea en el escritorio el icono "Iniciar Kaizen IA" (doble clic = enciende todo y lo abre).
# Uso (PowerShell):  powershell -ExecutionPolicy Bypass -File C:\panel-correos\crear-icono.ps1
$script = 'C:\panel-correos\iniciar-kaizen.ps1'
if (-not (Test-Path $script)) { Write-Host "No encuentro $script" -ForegroundColor Red; exit 1 }

$escritorio = [Environment]::GetFolderPath('Desktop')
$acceso = Join-Path $escritorio 'Iniciar Kaizen IA.lnk'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($acceso)
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$lnk.WorkingDirectory = 'C:\panel-correos'
$lnk.Description = 'Enciende Docker, n8n, el panel de Somos Viajes, el central y el tunel, y los abre en el navegador'
# Icono de un rayo (encender) que ya trae Windows.
$lnk.IconLocation = "$env:SystemRoot\System32\imageres.dll,101"
$lnk.Save()
Write-Host "Listo: icono creado en $acceso" -ForegroundColor Green
