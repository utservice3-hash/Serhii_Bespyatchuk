/**
 * 📦 НЕ-TS РЕСУРСИ В dist — SQL-схеми, вендорні файли конструктора, шаблони ТТН, рушій «Зарплати».
 * Раніше жило рядком `node -e` усередині `npm run build`; винесено 11.11.2026, щоб ланцюг викату міг зібрати БАЗУ
 * (поточний прод) тим самим кодом, що й нову версію (`deploy.ts`, крок `test`).
 *   node scripts/copyAssets.mjs [корінь бекенда]   — за замовчуванням: каталог над scripts/
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...x) => path.join(root, ...x);
fs.mkdirSync(p("dist/db"), { recursive: true });
fs.readdirSync(p("src/db")).filter((f) => f.endsWith(".sql")).forEach((f) => fs.copyFileSync(p("src/db", f), p("dist/db", f)));
fs.mkdirSync(p("dist/constructor/vendor"), { recursive: true });
fs.readdirSync(p("src/constructor/vendor")).forEach((f) => fs.copyFileSync(p("src/constructor/vendor", f), p("dist/constructor/vendor", f)));
fs.mkdirSync(p("dist/constructor/data/waybill"), { recursive: true });
fs.readdirSync(p("src/constructor/data/waybill")).forEach((f) => fs.copyFileSync(p("src/constructor/data/waybill", f), p("dist/constructor/data/waybill", f)));
fs.cpSync(p("src/payroll/engine"), p("dist/payroll/engine"), { recursive: true, filter: (s) => !s.endsWith(".d.mts") });
