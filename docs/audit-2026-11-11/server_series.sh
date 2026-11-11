#!/bin/bash
# Аудит 11.11.2026: заміри кроків у КОПІЇ стенда (/home/evraziat/audit-1111). Стенд і прод не чіпаються.
# Перед кожним кроком чекаємо тиші: замок вільний, жодного deploy.js, жодних чужих тестів/tsc/vite — 60 с поспіль.
export PATH=/usr/local/node26/bin:$PATH
A=/home/evraziat/audit-1111; R=/tmp/audit-res; mkdir -p $R; G=/tmp/audit-guardrun.py
quiet() {
  local q=0
  while [ $q -lt 12 ]; do
    st=$(cd /home/evraziat/fwt/backend && node dist/tools/checkoutLock.js --status 2>&1 | head -1)
    n=$(pgrep -fc "dist/tools/deplo[y].js" || true)
    h=$(pgrep -fc "node --tes[t]|test:matri[x]|test:pro[d]|/\.bin/ts[c]|typescript/bin/ts[c]|vit[e] build" || true)
    if echo "$st" | grep -q "ВІЛЬНО" && [ "${n:-0}" = "0" ] && [ "${h:-0}" = "0" ]; then q=$((q+1)); else q=0; fi
    sleep 5
  done
}
step() { local name=$1 lim=$2; shift 2; quiet; echo "== $name $(date -u +%T)" >> $R/series.log
  nice -n 19 /usr/bin/python3 $G --kill-above=$lim --log=$R/$name.log --cwd="$PWD" -- "$@" >> $R/series.jsonl 2>>$R/series.log
  sleep 20; }
cd $A/backend
step buildBack 1500 node scripts/transpileBuild.mjs
step copyAssets 1500 node scripts/copyAssets.mjs
step typecheckProd 1650 /usr/bin/time -v node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json
cd $A/frontend
step tscFront 1650 /usr/bin/time -v node node_modules/typescript/bin/tsc -b
step buildFront 1650 /usr/bin/time -v node node_modules/vite/bin/vite.js build
cd $A/backend
for c in 1 2 4 8; do
  step test-c$c 1450 node --test-concurrency=$c --test-reporter=tap --test-reporter-destination=stdout --test-reporter=./dist/testRunGate.js --test-reporter-destination=stdout --test "dist/**/*.test.js"
done
echo "DONE $(date -u +%T)" >> $R/series.log
