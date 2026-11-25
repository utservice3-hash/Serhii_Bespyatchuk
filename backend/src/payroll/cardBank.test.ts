/**
 * 🏦 Банк карти (Тетяна 25.11.2026, через Романа): «додати можливість додати назву банку (обовʼязкове поле)»; «не видаляй картки,
 * а лиш додай віконце»; «щоб в заявках (які вже подані) десь назви банків було видно».
 *
 * Банк — колонка `payroll_cards.bank`. Нова карта без банку не зберігається (кабінет і нова карта в заявці). Старі карти лишаються:
 * людина вказує банк кнопкою «Вказати банк». Заявки й відомість читають банк із КАРТИ, тож уже подані заявки показують його,
 * щойно людина його вкаже.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "payroll", p), "utf8");

test("#10960 БАНК ОБОВʼЯЗКОВИЙ: нова карта без банку відхиляється і в кабінеті, і в заявці; з банком проходить; старі карти не видаляються", async () => {
  const C = await import("./cards.js");
  assert.match(C.validateBank("") ?? "", /банк/i, "порожній банк");
  assert.match(C.validateBank("   ") ?? "", /банк/i, "пробіли — теж порожньо");
  assert.match(C.validateBank(undefined) ?? "", /банк/i, "без поля");
  assert.match(C.validateBank("Б".repeat(61)) ?? "", /60/, "задовга назва");
  assert.equal(C.validateBank("Монобанк"), null, "дзеркало: з банком проходить");
  assert.equal(C.validateBank("Б".repeat(60)), null, "дзеркало: рівно 60 — можна");
  const svc = SRC("payroll/service.ts");
  const add = svc.slice(svc.indexOf("export async function addCard"), svc.indexOf("export async function setCardBank"));
  assert.match(add, /validateBank\(body\.bank\)/, "🔴 кабінет зберігає карту без банку");
  assert.match(add, /INSERT INTO payroll_cards \([^)]*\bbank\b/, "🔴 банк не пишеться в карту");
  const lines = svc.slice(svc.indexOf("async function resolveLines"), svc.indexOf("export async function submitForm"));
  assert.match(lines, /validateBank\(nc\.bank\)/, "🔴 нова карта в заявці без банку");
  assert.match(lines, /INSERT INTO payroll_cards \([^)]*\bbank\b/, "🔴 банк нової карти з заявки не пишеться");
  const schema = SRC("db/schema.sql");
  assert.match(schema, /ALTER TABLE payroll_cards ADD COLUMN IF NOT EXISTS bank TEXT;/, "колонка банку");
  assert.doesNotMatch(schema, /payroll_cards[^;]*\bbank\b[^;]*NOT NULL/, "🔴 NOT NULL зламав би старі карти — їх не видаляємо");
  assert.match(FRONT("cabinet/payDraft.ts"), /newCard: \{ number: [^}]*bank: \(l\.bank \?\? ""\)\.trim\(\) \}/, "🔴 форма не шле банк нової карти");
  assert.match(FRONT("cabinet/PayLines.tsx"), /<BankField value=\{l\.bank/, "🔴 у заявці немає поля «Банк»");
  assert.match(FRONT("cabinet/Payouts.tsx"), /addCard\(.*add\.bank\.trim\(\)\)/, "🔴 кабінет не шле банк");
});

test("#10961 ВКАЗАТИ БАНК: стара карта отримує банк кнопкою в кабінеті — лише своя й не прибрана; маршрут у матриці", () => {
  const svc = SRC("payroll/service.ts");
  const fn = svc.slice(svc.indexOf("export async function setCardBank"), svc.indexOf("export async function archiveCard"));
  assert.match(fn, /validateBank\(body\.bank\)/, "🔴 порожній банк через «Вказати»");
  assert.match(fn, /UPDATE payroll_cards SET bank = \$3 WHERE id = \$1 AND user_id = \$2 AND archived_at IS NULL/, "🔴 можна змінити чужу карту");
  assert.match(SRC("routes/payroll.ts"), /payrollRouter\.post\("\/me\/cards\/:id\/bank", h\(null, \(req, _r, v\) => P\.setCardBank\(pool, v, intP\(req\.params\.id\), body\(req\)\)\)\)/, "маршрут — id користувача з сесії");
  assert.match(SRC("auth/accessMatrix.ts"), /path: "\/api\/payroll\/me\/cards\/:id\/bank", cls: "deny-only"/, "🔴 маршрут поза матрицею");
  const pay = FRONT("cabinet/Payouts.tsx");
  assert.match(pay, /Банк не вказано/, "🔴 стара карта без позначки");
  assert.match(pay, /\{c\.bank \? "Змінити банк" : "Вказати банк"\}/, "🔴 немає кнопки «Вказати банк»");
  assert.match(pay, /payrollApi\.setCardBank\(bankFor\.id, bankFor\.bank\.trim\(\)\)/);
  assert.match(pay, /setDel\(c\.id\)/, "«Прибрати» лишилось як було — картки не чіпаємо");
});

test("#10962 БАНК У ЗАЯВКАХ: «Аванси», Excel авансів, відомість і кабінет читають банк із карти — подані заявки теж", () => {
  const svc = SRC("payroll/service.ts"), st = SRC("payroll/state.ts");
  const adv = svc.slice(svc.indexOf("export async function advancesView"), svc.indexOf("export async function advancesXlsx"));
  assert.match(adv, /'bank', c\.bank/, "🔴 «Аванси» без банку");
  assert.match(adv, /bank: l\.bank/, "🔴 банк не віддається фронту");
  const xl = svc.slice(svc.indexOf("export async function advancesXlsx"));
  assert.match(xl, /\["ПІБ", "Сума", "Спосіб", "Номер карти", "Банк", "Отримувач", "Стан"\]/, "🔴 Excel авансів без колонки «Банк»");
  assert.match(xl, /"карта", no, r\.bank \?\? "не вказано", r\.holder/, "🔴 колонка «Банк» не з карти");
  assert.match(xl, /"готівка", "", "", "", r\.status/, "рядок готівки вирівняно під нову колонку");
  assert.match(svc, /bank: \["Банк", \(r\) => \(r\.cardLast4 \? \(r\.bank as string\) \?\? "не вказано" : ""\)\]/, "🔴 відомість (Excel) без банку");
  assert.match(svc, /holder: c\.who, bank: banks\.get\(cardId\) \?\? null/, "🔴 рядок відомості без банку");
  assert.match(st, /c\.holder, c\.bank, l\.amount/, "🔴 форма виплати ЗП без банку");
  assert.match(st, /'holder', c\.holder, 'bank', c\.bank/, "🔴 заявка авансу (кабінет) без банку");
  assert.match(FRONT("finance/AdvancesTab.tsx"), /cardTag\(l\.last4, l\.bank \?\? "банк не вказано"\)/, "🔴 у списку заявок банк не видно");
  assert.match(FRONT("finance/StatementTab.tsx"), /\["bank", "Банк"\]/, "🔴 відомість без колонки «Банк»");
  assert.match(FRONT("cabinet/format.ts"), /const bank = \(c: Obj\) => \(c\.bank \? ` · \$\{c\.bank\}` : ""\)/, "🔴 кабінет не показує банк у поданій заявці");
});
