import { test } from "node:test";
import assert from "node:assert/strict";
import { endOfKyivDay, nextWorkingDay, promiseDeadline, promiseState, worstPromiseState, DEFAULT_PROMISE_MINUTES, type CallFact } from "./callAiPromise.js";

/**
 * 🎯 #789–#790 — «ОБІЦЯВ І НЕ ПЕРЕДЗВОНИВ»: термін і стан обіцянки (рішення Романа 29.09.2026, П4–П7).
 * Чисті функції: термін рахує код із прочитаного моделлю, виконання — дзвінки Ringostat.
 */

const END = new Date("2026-09-25T09:00:00Z"); // пʼятниця, 12:00 за Києвом (UTC+3)
const P = (o: Partial<{ deadline_kind: "minutes" | "day" | "none"; deadline_minutes: number; deadline_date: string; conditional: boolean }>) =>
  ({ deadline_kind: "none" as const, deadline_minutes: 0, deadline_date: "", conditional: false, ...o });

/**
 * #789 — ТЕРМІН: «через 15 хв» → +15; «завтра» → кінець завтрашнього дня за Києвом; часу не названо → +20 хв;
 * умовна без часу в пʼятницю → кінець ПОНЕДІЛКА (вихідні пропускаються); неправдоподібне прочитання (0 хв, дата
 * в минулому чи далі за 60 днів) — не на віру, а за правилом «часу не названо».
 * 🧨 Червоніє, якщо змінити 20 хв, рахувати кінець дня в UTC чи пустити в роботу субботу.
 */
test("#789 ТЕРМІН ОБІЦЯНКИ: як пообіцяв, «завтра» — кінець дня (Київ), без часу — 20 хв, умовна — наступний робочий день", () => {
  assert.equal(DEFAULT_PROMISE_MINUTES, 20);
  assert.equal(promiseDeadline(P({ deadline_kind: "minutes", deadline_minutes: 15 }), END).deadline.toISOString(), "2026-09-25T09:15:00.000Z");
  const tomorrow = promiseDeadline(P({ deadline_kind: "day", deadline_date: "2026-09-26" }), END);
  assert.deepEqual([tomorrow.deadline.toISOString(), tomorrow.basis], ["2026-09-26T20:59:59.000Z", "day"], "🔴 «завтра» — не кінець київського дня");
  assert.equal(promiseDeadline(P({}), END).deadline.toISOString(), "2026-09-25T09:20:00.000Z", "🔴 без часу — не 20 хвилин");
  const cond = promiseDeadline(P({ conditional: true }), END);
  assert.deepEqual([cond.deadline.toISOString(), cond.basis], ["2026-09-28T20:59:59.000Z", "conditional_next_workday"], "🔴 умовна з пʼятниці — не до кінця понеділка");
  assert.equal(nextWorkingDay(new Date("2026-09-23T09:00:00Z")), "2026-09-24", "дзеркало: у середу наступний робочий — четвер");
  for (const bad of [P({ deadline_kind: "minutes", deadline_minutes: 0 }), P({ deadline_kind: "day", deadline_date: "2026-09-20" }),
    P({ deadline_kind: "day", deadline_date: "2027-01-10" }), P({ deadline_kind: "day", deadline_date: "завтра" })])
    assert.equal(promiseDeadline(bad, END).basis, "default_minutes", `🔴 неправдоподібне прочитання взято на віру: ${JSON.stringify(bad)}`);
  assert.equal(endOfKyivDay("2026-12-01").toISOString(), "2026-12-01T21:59:59.000Z", "🔴 зимовий час: кінець київського дня — 21:59 UTC");
});

const MADE = END, DL = new Date("2026-09-25T09:20:00Z");
const call = (min: number, callType: string, billsec: number): CallFact => ({ at: new Date(MADE.getTime() + min * 60_000), callType, billsec });

/**
 * #790 — СТАН: вихідний із розмовою до терміну — «передзвонив» (чий саме — `#850`); лише спроби — окремо;
 * клієнт подзвонив сам — окремий стан, а не «передзвонив»; дзвінок після терміну не рятує; до терміну — «чекає»;
 * месенджер — «не перевіряється», навіть без жодного дзвінка. Рядок бере найгірший стан.
 * 🧨 Червоніє, якщо зарахувати дзвінок клієнта нашим, дзвінок після терміну, чи ставити прапорець на месенджер.
 */
test("#790 СТАН ОБІЦЯНКИ: передзвонив / лише спроби / клієнт сам / не передзвонив / чекає / месенджер не перевіряється", () => {
  const later = new Date("2026-09-26T00:00:00Z");
  const st = (channel: "call" | "message", calls: CallFact[], now = later) => promiseState({ channel }, MADE, DL, calls, now);
  assert.equal(st("call", [call(10, "out", 40)]), "kept_talk", "🔴 наш вихідний із розмовою до терміну не зараховано");
  assert.equal(st("call", [call(10, "out", 0)]), "kept_attempt_only");
  assert.equal(st("call", [call(10, "in", 60)]), "client_called", "🔴 дзвінок клієнта зараховано як наш передзвін");
  assert.equal(st("call", [call(200, "out", 60)]), "late", "🔴 дзвінок ПІСЛЯ терміну зараховано як вчасний");
  assert.equal(st("call", []), "broken");
  assert.equal(st("call", [], new Date(MADE.getTime() + 5 * 60_000)), "pending", "🔴 до терміну вже «не передзвонив»");
  assert.equal(st("message", []), "unverifiable", "🔴 обіцянку в месенджер позначено як невиконаний дзвінок");
  assert.equal(worstPromiseState(["kept_talk", "unverifiable", "broken"]), "broken");
  assert.equal(worstPromiseState(["unverifiable", "kept_talk"]), "kept_talk");
  assert.equal(worstPromiseState([]), null);
});

/**
 * #850 — ЛИШЕ ТОЙ, ХТО ОБІЦЯВ, І «ЗАПІЗНИВСЯ» БЕЗ МЕЖІ (ТЗ «звіт тімліда», відповіді Романа 30.09.2026). Дзвінок
 * колеги до терміну обіцянку НЕ виконує; дзвінок того, хто обіцяв, до терміну — «передзвонив», після — «запізнився»
 * будь-коли (і через 3 доби); «не передзвонив» — поки його дзвінка немає; до синку за термін — «чекає».
 * 🧨 Червоніє, якщо зарахувати колегу, повернути межу запізнення чи рахувати «не передзвонив» до синку.
 */
test("#850 ОБІЦЯНКА — ЛИШЕ ТОЙ, ХТО ОБІЦЯВ: колега не рахується, «запізнився» без межі, до синку — чекає", () => {
  const far = new Date("2026-10-05T00:00:00Z");
  const ME = 7, MATE = 8;
  const by = (min: number, mgr: number, sec = 40): CallFact => ({ ...call(min, "out", sec), managerId: mgr });
  const st = (calls: CallFact[], known = far) => promiseState({ channel: "call" }, MADE, DL, calls, known, ME);
  assert.equal(st([by(10, ME)]), "kept_talk");
  assert.equal(st([by(10, MATE)]), "broken", "🔴 дзвінок колеги до терміну виконав чужу обіцянку");
  assert.equal(st([by(10, MATE), by(3 * 24 * 60, ME)]), "late", "🔴 передзвін через 3 доби — не «запізнився» (межу не знято)");
  assert.equal(st([by(25, ME, 0)]), "late", "спроба після терміну — теж запізнення");
  assert.equal(st([], new Date(DL.getTime() - 60_000)), "pending", "🔴 дзвінки ще не синхронізовано за термін, а вже «не передзвонив»");
  assert.equal(st([], new Date(DL.getTime() + 60_000)), "broken", "дзеркало: синк за терміном і дзвінка немає — не передзвонив");
  assert.equal(promiseState({ channel: "call" }, MADE, DL, [by(10, MATE)], far, null), "kept_talk", "невідомий менеджер — приписати нікому: рахується будь-хто");
});
