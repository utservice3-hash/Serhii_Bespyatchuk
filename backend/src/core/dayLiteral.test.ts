import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRealDate, monthEndOf, kyivMonthBounds } from "./dates.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Усі вихідні дерева, а не «каталог, який я згадав». */
function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(e)) acc.push(p);
  }
  return acc;
}

/**
 * 🗓 #239 — У ДЕРЕВІ НЕ ЛИШАЄТЬСЯ МІСЦЬ, ДЕ ДЕНЬ МІСЯЦЯ БЕРЕТЬСЯ ЛІТЕРАЛОМ.
 *
 * 🔴 ПРИВІД — ЖИВА АВАРІЯ 01.09.2026, і вона показала межу мого ж попереднього
 * перелічування. Я відзвітував «51 із 51» — але шукав ЛИШЕ в наборі гейтів, бо таку
 * межу мені й задали. У продукті той самий дефект лишився живим: `syncAdBudget`
 * падала кожен прогін на `date/time field value out of range: "2026-09-31"`.
 *
 * ⚠️ ГЕЙТ СТОЇТЬ НА ОЗНАЦІ, А НЕ НА СПИСКУ ФАЙЛІВ. Перелік файлів має власну сліпу
 * зону — новий файл; критерій пишеться від ПРЕДМЕТА: «дата, зібрана з літерала дня».
 * Тому обхід дерева тут повний, від кореня репозиторію.
 *
 * 🔍 ЩО САМЕ ЗАБОРОНЕНО: день 29/30/31 ОДРАЗУ за підстановкою — тобто місяць
 * змінний, а день зашитий. Дві межі, обидві куплені першим же прогоном цього гейта:
 *   · `-01` дозволено НАВМИСНО — перше число є в КОЖНОМУ місяці, це не припущення;
 *   · `${y}-12-31` дозволено — місяць тут ФІКСОВАНИЙ, і в грудні справді 31 день.
 *     Саме тому день мусить стояти ВПРИТУЛ до `}`: коли між ними є `-12`, місяць
 *     уже не змінний. Перша редакція цього не розрізняла й червоніла на робочому коді.
 */
const BAD = /\$\{[^}]*\}-(29|30|31)(?![\d-])/;

/**
 * ⚠️ КОМЕНТАР — НЕ КОД. Перший прогін почервонів на власному ж доккоментарі, який
 * ОПИСУЄ стару помилку. Гейт, що забороняє згадувати дефект, змушує стирати пам'ять
 * про нього — тобто працює проти себе. Межа груба (рядкові коментарі `*`, `//`, `--`)
 * і названа вголос: код після коментаря в ТОМУ САМОМУ рядку вона пропустить.
 */
const isComment = (line: string): boolean => /^\s*(\*|\/\/|--|\/\*)/.test(line);

test("#239 у дереві немає дат, зібраних із ЛІТЕРАЛА дня місяця", () => {
  const files = sources(path.join(ROOT, "backend", "src"))
    .concat(sources(path.join(ROOT, "frontend", "src")));
  assert.ok(files.length > 300, `🔴 обхід дерева знайшов лише ${files.length} файлів — шукали не там`);

  const hits: string[] = [];
  for (const f of files) {
    if (f.endsWith("dayLiteral.test.ts")) continue;          // сам гейт містить зразок
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (!isComment(line) && BAD.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(hits, [],
    "🔴 ДЕНЬ МІСЯЦЯ ЗАШИТО В ДАТУ. У вересні 30 днів, у лютому 28 — таке місце падає "
    + "рівно на межі місяця, і саме воно 01.09.2026 поклало `syncAdBudget`:\n  " + hits.join("\n  "));
});

test("#239b 🪞 ДЗЕРКАЛО: ознака справді ловить те, заради чого існує", () => {
  // Без цього #239 зеленів би й тоді, коли регулярка не бачить нічого взагалі.
  assert.ok(BAD.test('const to = `${ym}-31`;'), "🔴 не спіймано класичний `${ym}-31`");
  assert.ok(BAD.test('from=${ym}-01&to=${ym}-30'), "🔴 не спіймано `-30`");
  assert.ok(BAD.test("`${m}-29`"), "🔴 не спіймано `-29` (лютий невисокосний)");
  // 🪞 І не ловить законного: перше число є в КОЖНОМУ місяці, а фіксовані дати — не припущення.
  assert.equal(BAD.test('const from = `${ym}-01`;'), false, "🔴 `-01` оголошено дефектом");
  assert.equal(BAD.test('const t = `${y}-12-31`;'), false, "🔴 грудень має 31 день — це не припущення");
  // 🪞 І коментар не є кодом: гейт, що забороняє ОПИСУВАТИ дефект, стирає пам'ять про нього.
  assert.equal(isComment(" * будували період як `${ym}-31`"), true, "🔴 доккоментар прийнято за код");
  assert.equal(isComment("  const to = `${ym}-31`;"), false, "🔴 живий рядок оголошено коментарем");
  assert.equal(BAD.test('"0-30": "до 30 днів"'), false, "🔴 підпис кошика віку прийнято за дату");
});

/**
 * 🔴 #239c — ДЕНЬ ІЗ ЧУЖОГО ДЖЕРЕЛА ПЕРЕВІРЯЄТЬСЯ КАЛЕНДАРЕМ, А НЕ РЕГУЛЯРКОЮ.
 * `\d{8}` пропускає `20260931`; `new Date` не кидає, а НОРМАЛІЗУЄ у 1 жовтня.
 */
test("#239c неіснуючий день не проходить у БД — і високосний рік не постраждав", () => {
  assert.equal(isRealDate("2026-09-31"), false, "🔴 «31 вересня» знову поїде в SQL");
  assert.equal(isRealDate("2026-02-30"), false);
  assert.equal(isRealDate("2026-02-29"), false, "🔴 2026 не високосний");
  assert.equal(isRealDate("2024-02-29"), true, "🔴 справжній високосний день відкинуто");
  assert.equal(isRealDate("2026-09-30"), true, "🔴 звичайний день відкинуто — джоба втратить дані");
  assert.equal(isRealDate("2026-9-1"), false, "🔴 формат без padStart прийнято");
  // Межі місяців рахує ядро, і воно згодне саме з собою.
  assert.equal(monthEndOf("2026-09"), "2026-09-30");
  assert.equal(isRealDate(kyivMonthBounds("2026-09-15").to), true);
});
