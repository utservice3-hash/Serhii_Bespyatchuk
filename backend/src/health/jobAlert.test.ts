import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #69 — БАНЕР «ДЖОБА ПАДАЛА» ГАСНЕ ПІСЛЯ УСПІХУ.
 *
 * 🔴 РЕГРЕСІЯ, ЯКУ Я САМ ВВІВ У `45465f5`. Умова була `else if (rec.last_error)` і
 * працювала правильно — але не сама по собі, а тому що `runJob` занулював
 * `last_error` на кожному успіху. Ненульова помилка за побудовою була свіжішою за
 * успіх, і заголовок «падала ПІСЛЯ ОСТАННЬОГО УСПІХУ» був істинним.
 *
 * Прибравши те занулення (щоб не втрачати причину аварій — саме так зник текст
 * помилки, що почала простій 14 год 52 хв), я змінив інваріанту й не перевірив
 * читача. Наслідок заміряно на проді: `syncCalls` впала 09:15, одужала 09:35,
 * банер висів годинами й сам не згас би НІКОЛИ.
 *
 * Ціна не косметична: банер, який не гасне, вчить ігнорувати банери — і знецінює
 * всю сигналізацію, яку ми того ж дня будували.
 *
 * Гейт перевіряє ПРАВИЛО на фікстурі з трьох станів, а не живу вибірку.
 */

/**
 * ⚠️ Тест біжить із `dist`, а звіряти треба ДЖЕРЕЛО — тому шлях будується від
 * `dist/health` у `src/health`. Перша редакція брала `import.meta.dirname + alerts.ts`
 * і падала з ENOENT: у `dist` лежить `.js`, а не `.ts`. Це не дрібниця — гейт, що
 * читає не той файл, або червоний завжди, або зелений завжди.
 */
const SRC = path.join(import.meta.dirname, "..", "..", "src", "health", "alerts.ts");

/** Три стани джоби — рівно ті, що розрізняє правило. */
const CASES = [
  { name: "впала-і-одужала", err: "fetch failed", errAt: "2026-08-10T09:15:00Z",
    okAt: "2026-08-10T09:35:00Z", wantAlert: false,
    why: "успіх ПІСЛЯ помилки — банера бути НЕ повинно (саме цей випадок і брехав)" },
  { name: "впала-і-не-одужала", err: "Connection terminated", errAt: "2026-08-10T09:35:00Z",
    okAt: "2026-08-10T09:15:00Z", wantAlert: true,
    why: "помилка СВІЖІША за успіх — банер обовʼязковий" },
  { name: "ніколи-не-падала", err: null, errAt: null,
    okAt: "2026-08-10T09:35:00Z", wantAlert: false,
    why: "помилки немає — банера немає" },
  { name: "впала-без-жодного-успіху", err: "boom", errAt: "2026-08-10T09:35:00Z",
    okAt: null, wantAlert: true,
    why: "успіху не було взагалі — помилка актуальна (це стан backupDb 10.08)" },
];

/** Копія правила з `alerts.ts`; #69b доводить, що копія не розійшлась із джерелом. */
const errorIsCurrent = (r: { last_error: string | null; last_error_at: Date | null; last_success_at: Date | null }): boolean =>
  Boolean(r.last_error) && r.last_error_at != null
  && (r.last_success_at == null || r.last_error_at > r.last_success_at);

test("#69 БАНЕР ДЖОБИ: помилка актуальна лише без пізнішого успіху", () => {
  for (const c of CASES) {
    const got = errorIsCurrent({
      last_error: c.err,
      last_error_at: c.errAt ? new Date(c.errAt) : null,
      last_success_at: c.okAt ? new Date(c.okAt) : null,
    });
    assert.equal(got, c.wantAlert, `🔴 ${c.name}: ${c.why} — очікували ${c.wantAlert}, отримали ${got}`);
  }
  // Невиродженість: якби правило завжди давало одне й те саме, збіги вище нічого б не доводили.
  assert.equal(new Set(CASES.map((c) => c.wantAlert)).size, 2,
    "🔴 фікстура не містить обох результатів — гейт порожній");
});

/**
 * 🪞 #69b — ДЖЕРЕЛО НЕ РОЗІЙШЛОСЬ ІЗ ГЕЙТОМ.
 *
 * Без цього #69 перевіряв би власну копію правила й лишався б зеленим навіть тоді,
 * коли в `alerts.ts` повернули стару умову. Рівно та декоративність, на якій я
 * сьогодні спіймався тричі: гейт міряв не те, що думав.
 *
 * Тому перевіряємо ЗВʼЯЗОК: у бойовому файлі гілка банера мусить кликати
 * `errorIsCurrent`, а голої умови `else if (rec.last_error)` бути не має.
 */
test("#69b ДЖЕРЕЛО: банер кличе errorIsCurrent, а не голий last_error", () => {
  const src = readFileSync(SRC, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /else if \(errorIsCurrent\(rec\)\)/,
    "🔴 гілка банера більше не кличе errorIsCurrent — правило й гейт розійшлись");
  assert.doesNotMatch(code, /else if \(rec\.last_error\)/,
    "🔴 повернулась стара умова `else if (rec.last_error)` — банер знову стане вічним");
  // Обидва місця, де текст помилки підмішується в ІНШІ тривоги, теж мусять бути під правилом.
  assert.equal((code.match(/errorIsCurrent\(rec\)/g) ?? []).length, 3,
    "🔴 правило застосоване не в усіх трьох місцях: банер + «мовчить» + «не відпрацювала жодного разу»");
});
