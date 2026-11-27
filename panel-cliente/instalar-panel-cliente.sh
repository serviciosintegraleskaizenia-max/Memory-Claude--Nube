#!/bin/bash
# Zentralia - instala el panel del cliente (PEX Solution y los que sigan) en el servidor.
# Lo llama instalar-panel-cliente.ps1 desde la PC. No toca Oficina ni Somos Viajes.
set -e
D=$(cd "$(dirname "$0")" && pwd)
APP=/srv/zentralia/apps/panel-cliente
ENV=/srv/zentralia/datos/panel-cliente.env
UNIDAD=zentralia-panel-cliente
falla() { echo; echo "    FALLA: $1"; echo "    No sigas: mandame este mensaje."; exit 1; }
[ "$(id -u)" = 0 ] || falla "hay que correrlo como root"
[ -f "$D/servidor.js" ] || falla "no vino servidor.js"
id zentralia >/dev/null 2>&1 || falla "no existe el usuario zentralia"

echo "== 1/4 Revisando el código"
for f in servidor.js crear-cliente.js; do node --check "$D/$f" || falla "$f tiene errores"; done
echo "    OK  sin errores"

echo "== 2/4 Base de datos"
ORIGEN=""
for a in panel-correos kaizen-pruebas; do [ -f "/srv/zentralia/apps/$a/config.js" ] && { ORIGEN=$a; break; }; done
[ -n "$ORIGEN" ] || falla "no encuentro la configuración de la base de Oficina"
CLAVE_PG=$(node -e "console.log(require('/srv/zentralia/apps/$ORIGEN/config.js').db.password)")
[ -n "$CLAVE_PG" ] || falla "la configuración no trae la clave de PostgreSQL"
ESCAPADA=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$CLAVE_PG")
EXISTE=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='panel_cliente'")
[ "$EXISTE" = 1 ] || sudo -u postgres createdb panel_cliente
echo "    OK  base panel_cliente lista"

echo "== 3/4 Copiando el panel"
mkdir -p "$APP" /srv/zentralia/datos
cp "$D/servidor.js" "$D/crear-cliente.js" "$D/index.html" "$D/esquema.sql" "$D/package.json" "$D/LEEME.md" "$D/crear-cuenta.sh" "$APP/"
if [ ! -d "$APP/node_modules/pg" ]; then
  if [ -d /srv/zentralia/apps/panel-correos/node_modules/pg ]; then
    cp -r /srv/zentralia/apps/panel-correos/node_modules "$APP/"
  else
    (cd "$APP" && npm install --omit=dev --no-audit --no-fund) || falla "no pude instalar el módulo pg"
  fi
fi
if [ ! -f "$ENV" ]; then
  INTERNO=$(openssl rand -hex 24)
  printf 'PANEL_CLIENTE_DB=postgres://postgres:%s@127.0.0.1:5432/panel_cliente\nPANEL_CLIENTE_PUERTO=3110\nPANEL_CLIENTE_INTERNO=%s\nPANEL_CLIENTE_SEGURO=0\n' "$ESCAPADA" "$INTERNO" > "$ENV"
  chmod 600 "$ENV"
fi
chown -R zentralia:zentralia "$APP"
chown zentralia:zentralia "$ENV"
chmod +x "$APP/crear-cuenta.sh"
echo "    OK  copiado"

echo "== 4/4 Arrancando el servicio"
cat > "/etc/systemd/system/$UNIDAD.service" <<UNIT
[Unit]
Description=Zentralia - panel del cliente
After=network.target postgresql.service

[Service]
User=zentralia
WorkingDirectory=$APP
EnvironmentFile=$ENV
ExecStart=$(command -v node) $APP/servidor.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$UNIDAD" >/dev/null 2>&1 || true
systemctl restart "$UNIDAD"
sleep 5
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3110/ || true)
[ "$c" = 200 ] && echo "    OK  panel del cliente responde en 127.0.0.1:3110" || echo "    AVISO: respondió $c. Espera 20 s; si sigue, manda: journalctl -u $UNIDAD -n 30"
echo
echo "================ RESUMEN ================"
echo "Servicio panel del cliente: $(systemctl is-active $UNIDAD)"
echo "Solo responde dentro del servidor (127.0.0.1:3110). Sin subdominio todavía."
echo "=========================================="
