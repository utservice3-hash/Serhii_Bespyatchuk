/**
 * 🧨 ОБГОРТКА САБОТАЖУ — ДОКАЗ ЗАСТОСУВАННЯ ПЕРЕД ДОКАЗОМ ЧЕРВОНОГО.
 *
 * 🔴 ЗАМІРЯНА ЧАСТОТА ВІДМОВИ, А НЕ ПОБОЮВАННЯ: за одну добу **три** саботажі в двох
 * чатах НЕ ЗАСТОСУВАЛИСЬ (екранування в `python -c`, `sed` без збігу), і кожен дав
 * ЗЕЛЕНИЙ прогін. Зелений колір при незастосованому саботажі читається як «гейт у
 * порядку» — тобто найгірший можливий висновок: із нього виходить робота в бік
 * «дзеркало беззубе», якої ніхто не замовляв.
 *
 * 🔴 ПРОБЛЕМА НЕ В ІНСТРУМЕНТІ ЗАМІНИ, А В ТОМУ, ЩО ДВА РІЗНІ СТАНИ ВИГЛЯДАЮТЬ
 * ОДНАКОВО: «саботаж застосувався, гейт беззубий» і «саботаж не застосувався» —
 * обидва зелені. Розрізняє їх лише доказ ЗМІНИ ФАЙЛА, зроблений ДО прогону.
 *
 *   node dist/tools/sabotage.js <файл> --find=<рядок> --replace=<рядок> [--expect=1]
 *   node dist/tools/sabotage.js --restore
 *
 * Він НЕ запускає тестів і НЕ судить про колір — цим займається той, хто саботує.
 * Його єдина робота: або довести, що файл змінився рівно N разів, або ВІДМОВИТИ.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

export interface SabotageResult { ok: boolean; hits: number; lines: string[] }

/** Скільки разів `find` трапляється в тексті. Підрядок, БЕЗ регулярок і екранування. */
export function countHits(src: string, find: string): number {
  if (!find) return 0;
  let n = 0, i = 0;
  for (;;) { const k = src.indexOf(find, i); if (k < 0) break; n++; i = k + find.length; }
  return n;
}

/**
 * Рішення про саботаж — чиста функція, тож її можна перевірити гейтом, не чіпаючи
 * файлової системи (і не саботуючи саму обгортку саботажу).
 */
export function decideSabotage(src: string, find: string, replace: string, expect: number): SabotageResult {
  const hits = countHits(src, find);
  if (hits === 0) return { ok: false, hits, lines: [
    "🔴 САБОТАЖ НЕ ВІДБУВСЯ Б: шуканого рядка у файлі НЕМАЄ.",
    "   Прогін після цього дав би ЗЕЛЕНЕ — і воно означало б «нічого не ламали», а не «гейт тримає».",
    `   шукав: ${JSON.stringify(find.slice(0, 120))}`,
  ] };
  if (hits !== expect) return { ok: false, hits, lines: [
    `🔴 ЗБІГІВ ${hits}, А ОЧІКУВАЛОСЬ ${expect}.`,
    "   Саботаж, що влучає не туди або в кілька місць, доводить не те, що ти думаєш.",
    "   Уточни рядок або постав --expect= свідомо.",
  ] };
  if (find === replace) return { ok: false, hits, lines: [
    "🔴 --find і --replace ОДНАКОВІ: файл не зміниться, а прогін виглядатиме як саботований.",
  ] };
  return { ok: true, hits, lines: [`✅ саботаж застосується: ${hits} збіг(ів)`] };
}

const BACKUP = (file: string) => `${file}.sabotage-backup`;

export function applySabotage(file: string, find: string, replace: string, expect = 1): SabotageResult {
  const src = readFileSync(file, "utf8");
  const v = decideSabotage(src, find, replace, expect);
  if (!v.ok) return v;
  writeFileSync(BACKUP(file), src);
  writeFileSync(file, src.split(find).join(replace));
  // 🔴 ДОКАЗ ПІСЛЯ ЗАПИСУ, а не віра в те, що запис удався: перечитуємо з диска.
  const after = readFileSync(file, "utf8");
  const left = countHits(after, find);
  if (left !== 0) return { ok: false, hits: v.hits, lines: [
    `🔴 ПІСЛЯ ЗАПИСУ шуканий рядок ЩЕ НА МІСЦІ (${left}) — файл не змінився. Не запускай прогін.`,
  ] };
  return { ok: true, hits: v.hits, lines: [
    `✅ САБОТОВАНО: ${file}, замін ${v.hits}. Копію збережено — знімай через --restore.`,
    "   ⚠️ Після відновлення обовʼязково `rm -rf dist && npm run build`: інкрементальний tsc",
    "   лишає саботовану версію в dist, і «повернено» буде неправдою.",
  ] };
}

export function restoreSabotage(file: string): SabotageResult {
  const b = BACKUP(file);
  if (!existsSync(b)) return { ok: false, hits: 0, lines: [`🔴 копії ${b} немає — відновлювати нема з чого`] };
  writeFileSync(file, readFileSync(b, "utf8"));
  unlinkSync(b);
  return { ok: true, hits: 0, lines: [`✅ ВІДНОВЛЕНО ${file}. Далі: rm -rf dist && npm run build`] };
}

// ─────────────────────────────── CLI ───────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) { console.error("🔴 потрібен файл"); process.exit(2); }
  const r = argv.includes("--restore")
    ? restoreSabotage(file)
    : applySabotage(file, arg("find") ?? "", arg("replace") ?? "", Number(arg("expect") ?? 1));
  console.log(r.lines.join("\n"));
  process.exit(r.ok ? 0 : 1);
}
