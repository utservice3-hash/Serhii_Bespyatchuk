/**
 * 🔒 ЗБІРКА — ЛИШЕ ВЛАСНИКУ (задача 11232; зустріч 25.11.2026 «прибрати номери телефонів з відкритого доступу»).
 *
 * На проді веб-корінь = увесь git-чекаут, а nginx хостингу віддає файли зі «статичним» розширенням НАПРЯМУ, повз Node і
 * повз логін. Заміряно 26.11.2026 з браузера без входу: `/backend/dist/index.js` і `/backend/dist/core/*.test.js` віддаються
 * як файли (у тестових фікстурах — реальні номери телефонів), тоді як `.ts`, `.json`, `.md`, `.sql` ідуть у Node і дають
 * сторінку входу. `.htaccess` на статику nginx не діє; 24.11.2026 заміряно, що каталог із правами 700 дає 403.
 *
 * Тому права ставить САМА ЗБІРКА: `dist` перестворюється кожним викатом (`rm -rf dist`), і разова команда на сервері
 * прожила б рівно до наступного. Node працює від власника каталогу, йому 700 не заважає.
 *   node scripts/lockDist.mjs [корінь бекенда]   — за замовчуванням: каталог над scripts/
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!fs.existsSync(dist)) { console.error(`lockDist: ${dist} не існує — закривати нічого, збірка не відбулась`); process.exit(1); }
fs.chmodSync(dist, 0o700);
const mode = fs.statSync(dist).mode & 0o777;
if (mode !== 0o700) { console.error(`lockDist: права ${mode.toString(8)} замість 700 — каталог збірки лишився відкритим`); process.exit(1); }
console.log("lockDist: dist — лише власнику (700)");
