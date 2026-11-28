#!/bin/bash
# Zentralia - actualiza el código de los paneles en el servidor (Somos Viajes, Oficina y demo).
# Lo llama actualizar-servidor.ps1 desde la PC. No toca ajustes (config.js), datos ni la base de datos.
set -e
D=$(cd "$(dirname "$0")" && pwd)
APPS=/srv/zentralia/apps
falla() { echo; echo "    FALLA: $1"; echo "    No sigas: mandame este mensaje."; exit 1; }
[ "$(id -u)" = 0 ] || falla "hay que correrlo como root"
[ -d "$D/panel" ] || falla "no vino la carpeta panel"
echo "== 1/3 Revisando el código nuevo"
find "$D/panel" -type f \( -name '*.js' -o -name '*.html' \) -exec sed -i 's/\r$//' {} +
for f in $(cd "$D/panel" && find . -name '*.js'); do node --check "$D/panel/$f" || falla "$f tiene errores"; done
echo "    OK  sin errores"
echo "== 2/3 Copiando a los paneles (se guarda una copia de lo anterior)"
STAMP=$(date +%Y%m%d-%H%M)
for app in panel-correos kaizen-pruebas; do
  [ -d "$APPS/$app" ] || continue
  mkdir -p "/srv/zentralia/datos/codigo-anterior/$STAMP"
  tar czf "/srv/zentralia/datos/codigo-anterior/$STAMP/$app.tgz" -C "$APPS/$app" --exclude=node_modules --exclude=cache-correos --exclude='*.log' --exclude='config*.js' --exclude=empresas . 2>/dev/null || true
  cp -r "$D/panel/." "$APPS/$app/"
  # Los datos de socios y gastos solo van a la Oficina (kaizen-pruebas), no al panel de la empresa.
  # Datos iniciales: los de Operaciones (tarifarios, choferes) solo al panel de la empresa; los de socios solo a la Oficina.
  [ "$app" = panel-correos ] && rm -f "$APPS/$app/datos-iniciales/creacion-sistema.json"
  [ "$app" = kaizen-pruebas ] && rm -rf "$APPS/$app/datos-iniciales/operaciones"
  chown -R zentralia:zentralia "$APPS/$app"
  echo "    OK  $app"
done
# Oficina habla con el panel del cliente con una clave interna guardada en el servidor: se asegura que pueda leerla.
ENVPC=/srv/zentralia/datos/panel-cliente.env
UOF=$(systemctl show -p User --value zentralia-central 2>/dev/null || true); [ -n "$UOF" ] || UOF=root
if [ -f "$ENVPC" ]; then
  if [ "$UOF" != root ] && ! runuser -u "$UOF" -- test -r "$ENVPC" 2>/dev/null; then
    chgrp "$(id -gn "$UOF")" "$ENVPC" && chmod 640 "$ENVPC"
    echo "    OK  Oficina ($UOF) ya puede leer la clave del panel del cliente"
  fi
  if [ "$UOF" = root ] || runuser -u "$UOF" -- test -r "$ENVPC" 2>/dev/null; then echo "    OK  clave del panel del cliente: Oficina la lee"
  else echo "    AVISO: Oficina ($UOF) sigue sin poder leer $ENVPC. Mándame: ls -l $ENVPC"; fi
else
  echo "    AVISO: no existe $ENVPC (el panel del cliente no está instalado). Lo de PEX desde Oficina no funcionará hasta instalarlo."
fi
echo "== 3/3 Reiniciando los paneles"
systemctl restart zentralia-somosviajes zentralia-central
sleep 10
for u in 3001 3090; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$u/api/empresa" || true)
  [ "$c" = 200 ] && echo "    OK  panel $u responde" || echo "    AVISO: el panel $u respondió $c (espera 30 s; si sigue, mándame: journalctl -u zentralia-central -n 30)"
done
rm -rf "$D"
echo
echo "================ RESUMEN ================"
echo "Panel Somos Viajes: $(systemctl is-active zentralia-somosviajes)"
echo "Oficina y demo:     $(systemctl is-active zentralia-central)"
echo "Copia del código anterior: /srv/zentralia/datos/codigo-anterior/$STAMP"
echo "=========================================="
