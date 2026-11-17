---
name: stand-build-oom-node-options
description: "Збірка в стенді fwt гине від памʼяті нестабільно; 900 МБ уже ЗАМАЛО (heap OOM 11.11) — без ліміту проходить, «Killed» лікується повтором; після збою dist стенда зникає"
metadata:
  type: reference
---

10.11.2026: `tsc` у стенді «Killed» (LVE, прод-процес ~500–665 МБ); тоді допоміг `NODE_OPTIONS=--max-old-space-size=900`.
11.11.2026: з 900 МБ збірка впала **heap OOM** (код виріс) — ліміт 900 тепер шкодить. Без ліміту: раз «Killed» (збіглось із сусіднім прийманням), раз пройшло; tscFront раз упав без тексту, повтор — зелений.

**Why:** «Command failed: npm run build» / tscFront без тексту — це памʼять хоста, а не код; перевіряй локально `tsc -b --force` і повторюй.
**How to apply:** NODE_OPTIONS=900 у ship-скрипти НЕ ставити. Після збою на buildBack `dist` стенда без `deploy.js`/`checkoutLock.js` → ланцюг і замок мертві; ручну збірку стенда класифікатор мені блокує — просити Романа: `ssh … 'cd ~/fwt/backend && export PATH=/usr/local/node26/bin:$PATH && npm run build'`, потім свій замок `--release` і перезапуск wait-скрипта. Збій лише на tscFront (бекенд зібрався) — замок відпускаю й перезапускаю сам.

**11.11.2026:** 900 МБ уже замало — `tsc` у стенді впав «JavaScript heap out of memory» на 888 МБ (код виріс). З `--max-old-space-size=1200` збірка пройшла (RSS усіх процесів акаунта ~900 МБ, стелю LVE прочитати не вдалось). Якщо збірка впала посеред `deploy:check`, `dist` стенда лишається напівзібраним — навіть `checkoutLock.js` не стартує; статус замка тоді дивитись прод-копією інструмента (`~/uts.ua/dashboard/backend/dist/tools/checkoutLock.js --status`), перезбирати стенд під своїм замком і запускати ship напряму (замок «уже твій»).
