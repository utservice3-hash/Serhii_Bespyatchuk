import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseLegacyTitle, planLegacyCleanup, planReceivableTasks, receivableTaskKey,
  type DueReceivable, type LiveByName,
} from "./receivableTasks.js";

/**
 * 💰 ЗАДАЧА 9934: ОДНА ВІДКРИТА ЗАДАЧА «ОТРИМАТИ ОПЛАТУ» НА БОРГ. Привід заміряний на проді 26.11.2026:
 * 164 відкриті, 98 зайвих копій, СМАР ТЕКС ТОВ — 14 задач у Семенюка, по одній на кожен перенесений дедлайн.
 */
const SRC = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url).href.replace("/dist/", "/src/")), "utf8");

const due = (key: string, title = "t"): DueReceivable => ({ key, title, comments: "c", managerId: 7, department: "d" });
const LIVE = { inv: 10, cli: 10 };

test("#9934 ОДНА ЗАДАЧА НА БОРГ: новий дедлайн оновлює відкриту, а не ставить другу; інший борг — нова", () => {
  const smar = receivableTaskKey("smar", null);
  const other = receivableTaskKey("other", null);
  const plan = planReceivableTasks({
    due: [due(smar, "дедлайн 24.11"), due(other)],
    open: [{ id: 11041, key: smar }],
    liveKeys: new Set([smar, other]), liveRows: LIVE,
  });
  assert.deepEqual(plan.update.map((u) => [u.id, u.due.title]), [[11041, "дедлайн 24.11"]],
    "🔴 перенесений дедлайн не оновив відкриту задачу боргу");
  assert.deepEqual(plan.insert.map((d) => d.key), [other],
    "🔴 по боргу з відкритою задачею поставлено ще одну (або по новому боргу — жодної)");
  // Рахунок і клієнт — різні борги навіть в одного клієнта.
  assert.notEqual(receivableTaskKey("smar", "17"), receivableTaskKey("smar", null));
  assert.notEqual(receivableTaskKey("smar", "17"), receivableTaskKey("smar", "18"));
});

test("#9934b ОПЛАЧЕНО → ЗАКРИТО: ключа немає в дебіторці — задача закривається; є — лишається", () => {
  const paid = receivableTaskKey("paid", "5");
  const alive = receivableTaskKey("alive", "6");
  const plan = planReceivableTasks({
    due: [], open: [{ id: 1, key: paid }, { id: 2, key: alive }],
    liveKeys: new Set([alive]), liveRows: LIVE,
  });
  assert.deepEqual(plan.closePaid, [1], "🔴 задача по оплаченому рахунку лишилась відкритою (або закрито живий борг)");
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.insert, []);
});

test("#9934c ПОРОЖНЯ ДЕБІТОРКА НЕ ЗАКРИВАЄ НІЧОГО — і закриває, щойно дані є", () => {
  const a = receivableTaskKey("a", "1");
  const b = receivableTaskKey("b", null);
  const empty = planReceivableTasks({
    due: [], open: [{ id: 1, key: a }, { id: 2, key: b }],
    liveKeys: new Set(), liveRows: { inv: 0, cli: 0 },
  });
  assert.deepEqual(empty.closePaid, [], "🔴 порожній синк дебіторки закрив задачі як «оплачені»");
  assert.deepEqual(empty.paidCheckSkipped, ["inv", "cli"]);
  // Порожні лише рахунки: клієнтський борг перевіряється, рахунковий — ні.
  const half = planReceivableTasks({
    due: [], open: [{ id: 1, key: a }, { id: 2, key: b }],
    liveKeys: new Set(), liveRows: { inv: 0, cli: 5 },
  });
  assert.deepEqual(half.closePaid, [2], "🔴 порожні рахунки закрили рахункову задачу або заблокували клієнтську");
  // Дзеркало: дані є — оплачене закривається (інакше гейт вище був би зелений і на мертвому кроці).
  const full = planReceivableTasks({
    due: [], open: [{ id: 1, key: a }, { id: 2, key: b }],
    liveKeys: new Set(), liveRows: LIVE,
  });
  assert.deepEqual(full.closePaid.sort(), [1, 2]);
});

test("#9934d ДУБЛІ: кілька відкритих з одним ключем — лишається найновіша, вона ж і оновлюється", () => {
  const k = receivableTaskKey("smar", null);
  const plan = planReceivableTasks({
    due: [due(k, "новий")],
    open: [{ id: 3942, key: k }, { id: 11041, key: k }, { id: 7561, key: k }],
    liveKeys: new Set([k]), liveRows: LIVE,
  });
  assert.deepEqual(plan.closeDuplicate.map((d) => [d.id, d.keptId]).sort(), [[3942, 11041], [7561, 11041]],
    "🔴 дублі не закрито або лишилась не найновіша");
  assert.deepEqual(plan.update.map((u) => u.id), [11041]);
  assert.deepEqual(plan.insert, []);
  // Дзеркало: різні ключі — дублів немає.
  const two = planReceivableTasks({
    due: [], open: [{ id: 1, key: receivableTaskKey("x", null) }, { id: 2, key: receivableTaskKey("y", null) }],
    liveKeys: new Set([receivableTaskKey("x", null), receivableTaskKey("y", null)]), liveRows: LIVE,
  });
  assert.deepEqual(two.closeDuplicate, []);
});

test("#9934e ДЖОБА ВИКОНУЄ ПЛАН: кожна вставка задачі несе ключ боргу, рішення — з planReceivableTasks", () => {
  const job = SRC("jobs/receivableDeadlineTasks.ts");
  assert.match(job, /planReceivableTasks\(/, "🔴 джоба вирішує сама, повз правило «одна задача на борг»");
  const inserts = job.match(/INSERT INTO tasks \([^)]*\)/g) ?? [];
  assert.ok(inserts.length >= 1, "🔴 у джобі не знайдено жодної вставки задачі — гейт нічого не перевіряє");
  for (const ins of inserts) {
    assert.match(ins, /receivable_key/, `🔴 вставка задачі без ключа боргу: ${ins}`);
  }
  // Ключ, за яким шукається «живий» борг, мусить будуватись так само, як у дедлайнах (COALESCE номера).
  assert.match(job, /'inv:' \|\| client_key \|\| ':' \|\| COALESCE\(invoice_no, ''\)/,
    "🔴 живі рахунки ключуються інакше, ніж дедлайни — усі рахункові задачі закрились би як «оплачені»");
  assert.match(SRC("db/schema.sql"), /ALTER TABLE tasks ADD COLUMN IF NOT EXISTS receivable_key TEXT;/);
});

test("#9934f ЧИСТКА СТАРИХ: назва → борг; один клієнт — ключ і найновіша лишається, нуль — закрити, кілька — не чіпати", () => {
  assert.deepEqual(parseLegacyTitle("💰 Отримати оплату: СМАР ТЕКС ТОВ (дедлайн 24.11.2026 минув)"),
    { clientName: "СМАР ТЕКС ТОВ", invoiceNo: null });
  assert.deepEqual(parseLegacyTitle("💰 Отримати оплату: МГЕР (готівка) (дедлайн 06.11.2026 минув)"),
    { clientName: "МГЕР (готівка)", invoiceNo: null }, "🔴 дужки в назві клієнта зламали розбір");
  assert.deepEqual(parseLegacyTitle("💰 Отримати оплату: ГРІОТ ТОВ — рахунок №1234 (дедлайн 01.11.2026 минув)"),
    { clientName: "ГРІОТ ТОВ", invoiceNo: "1234" });
  assert.equal(parseLegacyTitle("💰 Отримати оплату: щось інше"), null);

  const live: LiveByName = {
    clients: new Map([["СМАР ТЕКС ТОВ", new Set(["smar"])], ["ДВІЙНИК ТОВ", new Set(["d1", "d2"])]]),
    invoices: new Map([["ГРІОТ ТОВ", new Map([["1234", new Set(["griot"])]])]]),
  };
  const t = (id: number, name: string, inv?: string) => ({
    id, title: `💰 Отримати оплату: ${name}${inv ? ` — рахунок №${inv}` : ""} (дедлайн 01.11.2026 минув)` });
  const plan = planLegacyCleanup({
    legacy: [t(10, "СМАР ТЕКС ТОВ"), t(30, "СМАР ТЕКС ТОВ"), t(20, "СМАР ТЕКС ТОВ"),
      t(40, "ГРІОТ ТОВ", "1234"), t(41, "ГРІОТ ТОВ", "9999"), t(50, "ОПЛАЧЕНИЙ ТОВ"), t(60, "ДВІЙНИК ТОВ"),
      { id: 70, title: "💰 Отримати оплату: зламана назва" }],
    keyedOpen: [],
    live,
  });
  assert.deepEqual(plan.assignKey.sort((a, b) => a.id - b.id), [
    { id: 30, key: "cli:smar" }, { id: 40, key: "inv:griot:1234" }], "🔴 живий борг не отримав ключ на найновішій задачі");
  assert.deepEqual(plan.closeDuplicate.map((d) => [d.id, d.keptId]).sort(), [[10, 30], [20, 30]], "🔴 старі дублі не закрито");
  assert.deepEqual(plan.closePaid.sort((a, b) => a - b), [41, 50], "🔴 задача по боргу, якого немає в дебіторці, лишилась");
  assert.deepEqual(plan.untouched.map((u) => [u.id, u.why]).sort(), [[60, "ambiguous"], [70, "unparsed"]],
    "🔴 неоднозначну чи нерозібрану задачу зачеплено");

  // Уже ключована нова задача того самого боргу новіша за старі → лишається вона, старі — дублі, ключ нікому не ставиться.
  const mixed = planLegacyCleanup({ legacy: [t(10, "СМАР ТЕКС ТОВ")], keyedOpen: [{ id: 99, key: "cli:smar" }], live });
  assert.deepEqual(mixed.closeDuplicate, [{ id: 10, keptId: 99 }]);
  assert.deepEqual(mixed.assignKey, []);
});
