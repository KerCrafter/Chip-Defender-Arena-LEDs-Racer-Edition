#!/bin/sh
# Construit le site de test dans test/e2e/site (configuration staging, serveur local 127.0.0.1:8787)
# CDA_MAPS_DIR=<dossier maps4> : cartes de test copiées à côté de la page (sinon : tests de carte impossibles)
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
mkdir -p "$HERE/.cfg"
printf '{"server":"http://127.0.0.1:8787","relay":"ws://127.0.0.1:8787/relay","pubkey":"auto","providers":["direct"],"turn":false}\n' > "$HERE/.cfg/auth.json"
printf '{}\n' > "$HERE/.cfg/cartes.json"
CDA_ENV=staging CDA_OUT="$HERE/site" CDA_AUTH_JSON="$HERE/.cfg/auth.json" CDA_CARTES_JSON="$HERE/.cfg/cartes.json" python3 "$ROOT/build/build.py"
if [ -n "$CDA_MAPS_DIR" ]; then ln -sfn "$CDA_MAPS_DIR" "$HERE/site/maps4"; echo "cartes : $CDA_MAPS_DIR"; fi
