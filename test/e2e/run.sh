#!/bin/sh
# Lance la suite de bout en bout principale (les serveurs doivent tourner, voir README.md)
HERE=$(cd "$(dirname "$0")" && pwd); fail=0
for t in ${@:-sec coop entry invpop resume solocoop3 modesmap}; do
  echo "=== $t"; node "$HERE/$t.js" || fail=1
done
exit $fail
