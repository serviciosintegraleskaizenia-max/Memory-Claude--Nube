#!/bin/bash
# Lo único que puede hacer la llave del respaldo de la PC en el servidor (va en authorized_keys con command=...):
#   ultimo           -> nombre, tamaño y huella (sha256) del respaldo más nuevo
#   bajar NOMBRE     -> manda ese respaldo (ya cifrado)
#   recibido         -> la PC cuenta dónde lo guardó (JSON por la entrada); lo muestra la Oficina
# Cualquier otra cosa se rechaza.
BASE=${ZR_BASE:-/srv/zentralia/respaldos}
read -r -a P <<< "${SSH_ORIGINAL_COMMAND:-}"
case "${P[0]:-}" in
  ultimo)
    f=$(ls -1 "$BASE"/zentralia-respaldo-*.tar.cifrado 2>/dev/null | sort | tail -1)
    [ -n "$f" ] || { echo "Todavia no hay respaldos en el servidor" >&2; exit 3; }
    echo "$(basename "$f") $(stat -c %s "$f") $(sha256sum "$f" | cut -d' ' -f1)"
    ;;
  bajar)
    n="${P[1]:-}"
    [[ "$n" =~ ^zentralia-respaldo-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}\.tar\.cifrado$ ]] && [ -f "$BASE/$n" ] || { echo "No existe ese respaldo" >&2; exit 4; }
    exec cat "$BASE/$n"
    ;;
  recibido)
    t=$(mktemp "$BASE/.pc-XXXX")
    head -c 50000 > "$t"
    if node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(typeof j!=='object'||!j) process.exit(1)" "$t" 2>/dev/null; then
      chmod 640 "$t"; mv -f "$t" "$BASE/pc-recibido.json"; echo ok
    else rm -f "$t"; echo "Datos no validos" >&2; exit 5; fi
    ;;
  *)
    echo "Esta llave solo sirve para bajar respaldos." >&2; exit 1
    ;;
esac
