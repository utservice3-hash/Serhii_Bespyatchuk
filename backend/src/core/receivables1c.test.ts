import test from "node:test";
import assert from "node:assert/strict";
import { splitByLastSync, type Receivable1cRow } from "./receivables1c.js";

/**
 * 🕰 #234–#234c — «ЩО СИНК МІГ ЗАБРАТИ». Чисті функції на власних фікстурах: без БД,
 * без мережі, тож червоніють у будь-який день і в будь-якому оточенні.
 */
const ROW = (no: string, at: string | null): Receivable1cRow =>
  ({ clientKey: `k-${no}`, clientName: no, invoiceNo: no, invoiceDate: at?.slice(0, 10) ?? "2026-08-27",   // дата в стрічці є ЗАВЖДИ, сентинел убиває лише час
     invoiceAt: at, amount: 100, amountVal: 0, edrpou: "", comment: "", dealId: null, managerHint: "" });
/** 27.08.2026 17:24:52 UTC = 20:24:52 за Києвом (літній зсув +3, заміряно через Intl). */
const SYNC = new Date("2026-08-27T17:24:52.735Z");

test("#234 ВИКЛЮЧЕННЯ ЗА ЧАСОМ: виписане ПІСЛЯ синку не вимагається в базі", () => {
  const s = splitByLastSync([ROW("A", "2026-08-27 20:00:00"), ROW("B", "2026-08-27 21:00:00")], SYNC);
  assert.deepEqual(s.expected.map((r) => r.invoiceNo), ["A"],
    "🔴 рахунок, виписаний ПІСЛЯ останнього синку, вимагається в базі — гейт червонітиме не з нашої вини");
  assert.deepEqual(s.afterSync.map((r) => r.invoiceNo), ["B"]);
});

test("#234b 🔴 ДЗЕРКАЛО: виписане РАНІШЕ за синк лишається обовʼязковим", () => {
  // Без цієї половини «виправлення» просто вимикає гейт: виключиш усе — і теча
  // перестане бути видимою, а колір стане вічно зеленим.
  const s = splitByLastSync([ROW("A", "2026-08-27 09:00:00"), ROW("B", "2026-08-26 23:59:59")], SYNC);
  assert.equal(s.afterSync.length, 0, "🔴 старі рахунки виключено — гейт більше нічого не стереже");
  assert.deepEqual(s.expected.map((r) => r.invoiceNo).sort(), ["A", "B"]);
  // І межа доби: рівно на мить синку рахунок ще ОБОВʼЯЗКОВИЙ, а на секунду пізніше — ні.
  assert.equal(splitByLastSync([ROW("X", "2026-08-27 20:24:52")], SYNC).expected.length, 1,
    "🔴 рахунок рівно в мить синку випав із перевірки");
  assert.equal(splitByLastSync([ROW("X", "2026-08-27 20:24:53")], SYNC).afterSync.length, 1);
});

test("#234c СЕНТИНЕЛ: без часу — лишається в перевірці Й НАЗВАНИЙ окремо", () => {
  // 🔴 1С каже «часу не знаємо» сентинелом 00:00:00 (заміряно: 121 із 292; у годині
  // «00» немає жодного іншого значення). Проковтнути його в бік «виписано до синку»
  // означало б класифікувати ВПЕВНЕНО те, про що ми не знаємо нічого — родина
  // «`NULL` у `CHECK` проходить».
  const s = splitByLastSync([ROW("A", null), ROW("B", "2026-08-27 21:00:00")], SYNC);
  assert.deepEqual(s.unknownTime.map((r) => r.invoiceNo), ["A"], "🔴 невідомі не названі окремо");
  assert.ok(s.expected.some((r) => r.invoiceNo === "A"),
    "🔴 невідомі ВИКЛЮЧЕНО з перевірки — це тихіше в бік ПРОПУСКУ ТЕЧІ, а гейт існує саме проти неї");
  assert.equal(s.afterSync.length, 1);
});

test("#234d ЗОНА накладається ОДИН раз і береться з Intl, а не зашита", () => {
  // Константа «+3» була б правильною пів року. Взимку Київ = +2; рахунок 09:00 у
  // січні при зашитому +3 поїхав би на годину — і це виглядало б як дрейф даних.
  const winterSync = new Date("2026-01-15T09:00:00.000Z");   // = 11:00 за Києвом
  assert.equal(splitByLastSync([ROW("W", "2026-01-15 10:59:00")], winterSync).expected.length, 1,
    "🔴 зимовий зсув порахований як літній — рахунок до синку прочитано як після");
  assert.equal(splitByLastSync([ROW("W", "2026-01-15 11:01:00")], winterSync).afterSync.length, 1);
  // Без часу синку виключати нема від чого — усе лишається обовʼязковим.
  assert.equal(splitByLastSync([ROW("A", "2026-08-27 21:00:00")], null).expected.length, 1,
    "🔴 без last_success_at рядки мовчки виключились — це «не знаємо» в бік пропуску");
});
