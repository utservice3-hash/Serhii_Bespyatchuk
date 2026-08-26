/**
 * КАНОНІЧНИЙ РАХУНОК ГЕЙТІВ. Один інструмент для всіх чатів — див. `testManifest.ts`.
 *
 *   node dist/tools/gateCount.js                     # скільки гейтів у цьому дереві
 *   node dist/tools/gateCount.js --base=<sha>        # порівняти з базою (напр. health.version)
 *
 * Друкує ІМЕНА, що зникли й додались, а не лише дельту: критерій приймання —
 * «не зникло нічого ЧУЖОГО», і його число не виражає.
 *
 * 🪞 ІНСТРУМЕНТ У ПЕРШИЙ ЖЕ ДЕНЬ ДВІЧІ СПРАЦЮВАВ ПРОТИ СВОГО АВТОРА — і обидва
 * випадки записані тут, бо саме вони пояснюють, чому код виглядає саме так.
 *
 * ① **Виправив мене.** Я рахував гейти ґрепом по рядках, що починаються з `"#`, і
 *    доповів 563 → 568. Функція дала 562 → 567: ґреп рахував рядок, який гейтом не є.
 *    Тобто «свій швидкий спосіб» помилявся на одиницю, і це ніхто б не помітив —
 *    порівнювали ж із таким самим ґрепом учора.
 *
 * ② **Вигадав втрату.** Перша редакція не розекрановувала `\'`, і `#159c`
 *    («СЕО може … роз'єднати») читався ОДНОЧАСНО як зниклий і як доданий. Інструмент,
 *    зроблений заради «не втратити гейт», сам повідомляв про втрату, якої не було.
 *    Саме тому в `parseManifestTests` стоїть `.replace(/\\(.)/g, "$1")` — і саме тому
 *    його прибирати НЕ МОЖНА: тримає `#223d`.
 *
 * 🔴 Наслідок ② ширший за один баг: **хибна тривога в детекторі втрат дорожча за
 * пропуск.** Пропуск помітять при наступній звірці; а «зник гейт» відправляє людину
 * шукати диверсію в чужому коміті. Тому розбір мусить ПАДАТИ на незрозумілому вході,
 * а не віддавати порожній список — інакше «гейтів немає» читатиметься як норма.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { MANIFEST_TESTS, gateNames, diffGates } from "../testManifest.js";

/** Розбір маніфеста як ТЕКСТУ (для чужого коміту). Винесено, щоб гейт міг перевірити його без git. */
export function parseManifestTests(src: string, whence = "джерело"): string[] {
  const body = /export const MANIFEST_TESTS:[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src)?.[1];
  if (!body) throw new Error(`не знайшов MANIFEST_TESTS у ${whence} — розбір зламався, а не маніфест порожній`);
  // 🔴 Розекранувати ОБОВʼЯЗКОВО: `роз\'єднати` у джерелі — це `роз'єднати` в імені тесту.
  // Без цього той самий гейт читається як «зник» і «додався» одночасно (спіймано на #159c).
  return [...body.matchAll(/^\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1].replace(/\\(.)/g, "$1"));
}

/** Витягує список тестів із маніфеста ІНШОГО коміту — тим самим розбором, не своїм. */
export function testsAtRef(ref: string): string[] {
  return parseManifestTests(
    execFileSync("git", ["show", `${ref}:backend/src/testManifest.ts`], { encoding: "utf8" }), ref);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
const base = process.argv.find((a) => a.startsWith("--base="))?.slice(7);
if (!base) {
  console.log(`гейтів у дереві: ${gateNames().length}`);
} else {
  const d = diffGates(testsAtRef(base), MANIFEST_TESTS);
  console.log(`база ${base}: ${d.countBefore} · дерево: ${d.countAfter}`);
  console.log(d.onlyBefore.length
    ? `🔴 ЗНИКЛО ${d.onlyBefore.length}:\n  ` + d.onlyBefore.join("\n  ")
    : "✔ не зникло жодного");
  if (d.onlyAfter.length) console.log(`+ додано ${d.onlyAfter.length}:\n  ` + d.onlyAfter.join("\n  "));
  if (d.onlyBefore.length) process.exit(1);
}
}
