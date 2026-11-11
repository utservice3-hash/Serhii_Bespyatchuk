/**
 * 🧪 ПЕРЕВІРКА ТИПІВ БЕКЕНДА — ОСТАННІМ КРОКОМ ЗБІРКИ (11.11.2026).
 *
 * Переклад у JavaScript робить `transpileBuild.mjs` (по файлу, ~360 МБ); типи — тут, окремо.
 *   · на ХОСТИНГУ (є `/proc/lve` — ліміт памʼяті акаунта, де прод і PHP уже тримають ~1,1 ГБ): лише робочий код,
 *     без тестів (`tsconfig.typecheck.json`, ~730 МБ) — повний `tsc` (~1 ГБ) там вбивали пʼять разів поспіль;
 *   · ДЕІНДЕ (ноутбук, сесії перед пушем): повний `tsc --noEmit` разом із тестами — як і було до 11.11.
 * Примусити: `UTS_TYPECHECK=prod|all`. Код виходу — код `tsc`: тип зламано → збірка червона.
 * Стоїть ОСТАННІМ: якщо хостинг уб'є саму перевірку, `dist` уже зібраний і інструменти стенда (замок, викат) живі.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forced = process.env.UTS_TYPECHECK;
const light = forced ? forced === "prod" : existsSync("/proc/lve");
const args = light ? ["-p", "tsconfig.typecheck.json"] : ["-p", "tsconfig.json", "--noEmit"];
console.log(`typecheck: ${light ? "робочий код без тестів (хостинг)" : "повний — з тестами"}`);
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const r = spawnSync(tsc, args, { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
