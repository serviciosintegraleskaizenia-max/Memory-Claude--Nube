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
# Oficina habla con el panel del cliente con una clave interna. En vez de que Oficina abra el archivo (puede no
# tener permiso), systemd se la entrega al arrancar: la lee como root y la pone en la variable PANEL_CLIENTE_INTERNO.
ENVPC=/srv/zentralia/datos/panel-cliente.env
if [ -f "$ENVPC" ] && grep -q '^PANEL_CLIENTE_INTERNO=' "$ENVPC"; then
  install -d -m 700 /etc/zentralia
  ( umask 077; grep '^PANEL_CLIENTE_INTERNO=' "$ENVPC" > /etc/zentralia/oficina-panel-cliente.env )
  mkdir -p /etc/systemd/system/zentralia-central.service.d
  printf '[Service]\nEnvironmentFile=-/etc/zentralia/oficina-panel-cliente.env\n' > /etc/systemd/system/zentralia-central.service.d/panel-cliente.conf
  systemctl daemon-reload
  echo "    OK  Oficina recibe la clave del panel del cliente al arrancar"
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
PID=$(systemctl show -p MainPID --value zentralia-central 2>/dev/null || echo 0)
if [ -f /etc/zentralia/oficina-panel-cliente.env ] && [ "$PID" != 0 ]; then
  if tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep -q '^PANEL_CLIENTE_INTERNO='; then echo "Oficina ↔ panel del cliente: conectados"
  else echo "AVISO: Oficina arrancó sin la clave del panel del cliente. Mándame: systemctl cat zentralia-central"; fi
fi
echo "Copia del código anterior: /srv/zentralia/datos/codigo-anterior/$STAMP"
echo "=========================================="
