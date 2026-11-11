#!/bin/bash
# Zentralia - instala el respaldo diario en el servidor y actualiza los paneles.
# Lo llama configurar-respaldo-servidor.ps1 desde la PC (ssh -t), o a mano:  bash instalar-respaldo.sh [--nueva-clave]
set -e
D=$(cd "$(dirname "$0")" && pwd)
BASE=/srv/zentralia/respaldos
APPS=/srv/zentralia/apps
CLAVE=/root/.zentralia-respaldo.clave
paso() { echo; echo "== $1"; }
ok() { echo "    OK  $1"; }
falla() { echo; echo "    FALLA: $1"; echo "    No sigas: mandame este mensaje."; exit 1; }
[ "$(id -u)" = 0 ] || falla "hay que correrlo como root"
id zentralia >/dev/null 2>&1 || falla "no existe el usuario zentralia (¿se hizo la mudanza?)"

paso "1/6 Contraseña de los respaldos"
if [ -s "$CLAVE" ] && [ "${1:-}" != "--nueva-clave" ]; then
  ok "Ya hay una contraseña guardada (para cambiarla: --nueva-clave)"
else
  echo "    Esta contraseña cifra TODAS las copias: servidor, USB, C:, D: y Google Drive."
  echo "    Te conviene usar la MISMA de la copia de Google Drive de antes: así una sola abre todo."
  echo "    APUNTALA EN PAPEL: sin ella las copias no se pueden abrir (ni yo, ni nadie)."
  while true; do
    read -rsp "    Escribe la contraseña (no se va a ver): " c1; echo
    read -rsp "    Repítela: " c2; echo
    [ "$c1" = "$c2" ] || { echo "    No coinciden. Otra vez."; continue; }
    [ ${#c1} -ge 8 ] || { echo "    Muy corta: mínimo 8 caracteres."; continue; }
    break
  done
  (umask 077; printf '%s' "$c1" > "$CLAVE")
  unset c1 c2
  ok "Guardada en el servidor (solo root la puede leer)"
fi

paso "2/6 Programas del respaldo"
install -d -m 755 /usr/local/lib/zentralia
install -m 755 "$D/respaldo-servidor.js" /usr/local/lib/zentralia/respaldo-servidor.js
sed -i 's/\r$//' "$D/entregar-respaldo.sh"
install -m 755 "$D/entregar-respaldo.sh" /usr/local/bin/zentralia-entregar-respaldo
install -d -o root -g zentralia -m 2770 "$BASE"
chown root:zentralia "$BASE"; chmod 2770 "$BASE"
chgrp zentralia "$BASE"/*.json 2>/dev/null || true
touch "$BASE/servidor-configurado"; chgrp zentralia "$BASE/servidor-configurado"; chmod 640 "$BASE/servidor-configurado"
ok "Instalados"

paso "3/6 Cada noche a las 2:00 a. m. + botón 'Respaldar ahora' de la Oficina"
cat > /etc/systemd/system/zentralia-respaldo.service <<'UNIT'
[Unit]
Description=Zentralia - Respaldo del servidor
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/node /usr/local/lib/zentralia/respaldo-servidor.js
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=2h
UNIT
cat > /etc/systemd/system/zentralia-respaldo.timer <<'UNIT'
[Unit]
Description=Zentralia - Respaldo cada noche a las 2:00 a. m.

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/zentralia-respaldo.path <<'UNIT'
[Unit]
Description=Zentralia - Respaldo pedido desde la Oficina

[Path]
PathExists=/srv/zentralia/respaldos/pedir-respaldo
Unit=zentralia-respaldo.service

[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /etc/systemd/system/zentralia-central.service.d
printf '[Service]\nEnvironment=RESPALDO_BASE=%s\n' "$BASE" > /etc/systemd/system/zentralia-central.service.d/respaldo.conf
systemctl daemon-reload
systemctl enable --now zentralia-respaldo.timer zentralia-respaldo.path >/dev/null 2>&1
ok "Programado (próximo: $(systemctl show zentralia-respaldo.timer -p NextElapseUSecRealtime --value 2>/dev/null || echo '2:00 a. m.'))"

paso "4/6 Llave de la PC (solo puede bajar respaldos, nada más)"
PUB=$(tr -d '\r\n' < "$D/llave-pc.pub")
[[ "$PUB" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+\ zentralia-respaldo-pc$ ]] || falla "la llave de la PC no tiene el formato esperado"
AK=/root/.ssh/authorized_keys
cp -a "$AK" "$AK.antes-respaldo"
grep -c . "$AK" >/dev/null || falla "authorized_keys está vacío"
{ grep -v 'zentralia-respaldo-pc$' "$AK" || true; echo "restrict,command=\"/usr/local/bin/zentralia-entregar-respaldo\" $PUB"; } > "$AK.nuevo"
[ "$(grep -vc 'zentralia-respaldo-pc$' "$AK.nuevo")" -ge 1 ] || falla "se perdería tu llave principal; no cambio nada"
chmod 600 "$AK.nuevo"; mv -f "$AK.nuevo" "$AK"
ok "Llave de la PC agregada (tu llave principal sigue igual)"

paso "5/6 Actualizando los paneles (Oficina, Somos Viajes y demo)"
if [ -d "$D/panel" ]; then
  find "$D/panel" -type f \( -name '*.js' -o -name '*.html' \) -exec sed -i 's/\r$//' {} + 2>/dev/null || true
  for app in panel-correos kaizen-pruebas; do
    [ -d "$APPS/$app" ] || continue
    cp -r "$D/panel/." "$APPS/$app/"
    chown -R zentralia:zentralia "$APPS/$app"
    for f in $(cd "$D/panel" && find . -name '*.js'); do node --check "$APPS/$app/$f" || falla "$app/$f quedó con errores"; done
  done
  systemctl restart zentralia-somosviajes zentralia-central
  sleep 8
  for u in 3001 3090; do
    c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$u/api/empresa" || true)
    [ "$c" = 200 ] && ok "Panel $u responde" || echo "    AVISO: el panel $u respondió $c (espera 30 s y revisa)"
  done
else ok "(no venían paneles nuevos)"; fi

paso "6/6 Primer respaldo (unos minutos)"
rm -f "$BASE/pedir-respaldo"
node /usr/local/lib/zentralia/respaldo-servidor.js --manual || true
rm -rf "$D"
echo
echo "================ RESUMEN ================"
echo "Respaldo cada noche:   $(systemctl is-active zentralia-respaldo.timer)"
echo "Botón de la Oficina:   $(systemctl is-active zentralia-respaldo.path)"
ls -lh "$BASE"/zentralia-respaldo-*.tar.cifrado 2>/dev/null | awk '{print "Copia en el servidor:  " $NF " (" $5 ")"}' | tail -1
echo "=========================================="
