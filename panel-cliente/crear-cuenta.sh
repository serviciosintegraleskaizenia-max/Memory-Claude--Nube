#!/bin/bash
# Crea una cuenta del panel del cliente en el servidor. Uso (como root):
#   bash /srv/zentralia/apps/panel-cliente/crear-cuenta.sh USUARIO "Nombre de la empresa"
# Te pide la contraseña en pantalla (no se muestra ni se guarda en ningún archivo).
set -e
[ "$(id -u)" = 0 ] || { echo "Hay que correrlo como root."; exit 1; }
[ -n "$1" ] || { echo "Falta el usuario. Ejemplo: crear-cuenta.sh pexsolutions \"PEX Solution\""; exit 1; }
set -a; . /srv/zentralia/datos/panel-cliente.env; set +a
read -r -s -p "Contraseña para $1 (mínimo 8 caracteres): " CLAVE; echo
cd /srv/zentralia/apps/panel-cliente
node crear-cliente.js crear --usuario "$1" --clave "$CLAVE" --nombre "${2:-$1}"
