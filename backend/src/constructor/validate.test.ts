/**
 * ✅ Перевірка полів конструктора (`constructor/validate.ts`, затверджено 02.10.2026) — гейти #1197–#1199.
 * На кожне правило — значення по ОБИДВА боки межі; контрольні суми — на справжніх кодах (наші юрособи — публічні
 * реквізити з договорів; РНОКПП — вигаданий з правильною контрольною цифрою).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateForm, firstError, edrpouValid, rnokppValid, ibanValid, type Issue } from "./validate.js";
import type { DocumentState } from "./services/docgen.js";

const base = (): DocumentState => ({
  ent: "uts", doc: "carr", party: "carrier", intl: false, stamp: true, fopAcc: 0,
  cp: { name: "ТОВ «Тест Логістик»", edrpou: "39404434", ipn: "394044326590", addr: "м. Київ, вул. Тестова, 1", iban: "UA693052990000026009035008866",
        bank: "АТ КБ «ПриватБанк», МФО 305299", phone: "+380 67 000 00 00", email: "test@example.com", dir: "Тестенко Остап Петрович" },
  trip: { loadDate: "15.01.2026, 08:00", unloadDate: "16.01.2026, 09:00" },
  pay: { sum: "13 000", cur: "грн", form: "б/г без ПДВ", order: "" },
  dealNo: "61575919", docDate: "2026-10-02", mainNo: "", mainDate: "", mainUntil: "", manager: { name: "", phone: "" },
} as unknown as DocumentState);
const run = (patch: (s: DocumentState) => void, ctx = {}) => { const s = base(); patch(s); return validateForm(s, { today: "2026-10-02", ...ctx }); };
const on = (xs: Issue[], field: string) => xs.find((i) => i.field === field);

test("#1197 КОНТРОЛЬНІ СУМИ: ЄДРПОУ, РНОКПП, IBAN — справжні сходяться, переставлена цифра — ні", () => {
  for (const c of ["44186230", "45618360", "39404434"]) assert.equal(edrpouValid(c), true, `🔴 правильний ЄДРПОУ ${c} відхилено — заблокуємо справжніх контрагентів`);
  for (const c of ["44186203", "45618361", "3940443"]) assert.equal(edrpouValid(c), false, `🔴 кривий ЄДРПОУ ${c} пропущено`);
  assert.equal(rnokppValid("3478512294"), true, "🔴 РНОКПП нашого ФОП відхилено");
  assert.equal(rnokppValid("1234567899"), true); assert.equal(rnokppValid("1234567890"), false, "🔴 кривий РНОКПП пропущено");
  assert.equal(ibanValid("UA69 3052 9900 0002 6009 0350 0886 6"), true, "🔴 IBAN із пробілами відхилено");
  assert.equal(ibanValid("UA693052990000026009035008867"), false, "🔴 IBAN зі зміненою цифрою пропущено");
});

test("#1198 ПРАВИЛА ПОЛІВ: правильна форма — 0 зауважень; кожне правило з обох боків і з затвердженим рівнем", () => {
  assert.deepEqual(run(() => {}), [], "🔴 правильно заповнена заявка має зауваження");
  // порожнє необовʼязкове — не помилка
  assert.deepEqual(run((s) => { s.cp = { name: "ТОВ «Тест»" }; }).filter((i) => i.field.startsWith("cp.")), [], "🔴 порожні необовʼязкові поля дали зауваження");
  const lvl = (xs: Issue[], f: string) => on(xs, f)?.level;
  assert.equal(lvl(run((s) => { s.cp.name = ""; }), "cp.name"), "error");
  assert.equal(lvl(run((s) => { s.cp.name = "Тест Логістик"; }), "cp.name"), "warn");
  assert.equal(lvl(run((s) => { s.cp.edrpou = "39404443"; }), "cp.edrpou"), "error", "🔴 ЄДРПОУ з переставленими цифрами пропущено");
  assert.equal(lvl(run((s) => { s.cp.edrpou = "44186230"; }), "cp.edrpou"), "error", "🔴 свій код замість контрагента пропущено");
  assert.match(on(run((s) => { s.cp.name = "ФОП Тестенко О.П."; s.cp.edrpou = "39404434"; }), "cp.edrpou")!.msg, /ФОП/, "🔴 ФОП з 8-значним кодом пропущено");
  assert.equal(on(run((s) => { s.cp.name = "ФОП Тестенко О.П."; s.cp.edrpou = "1234567899"; s.cp.ipn = "1234567899"; }), "cp.edrpou"), undefined, "🔴 правильний ІПН ФОП відхилено");
  assert.equal(lvl(run((s) => { s.cp.edrpou = "1234567899"; }), "cp.edrpou"), "error", "🔴 10-значний код у компанії пропущено");
  assert.equal(lvl(run((s) => { s.cp.ipn = "39404432659"; }), "cp.ipn"), "error", "🔴 11-значний ІПН ПДВ пропущено");
  assert.match(on(run((s) => { s.cp.iban = "693052990000026009035008866"; }), "cp.iban")!.msg, /UA/, "🔴 IBAN без UA — без зрозумілої підказки");
  assert.equal(lvl(run((s) => { s.cp.iban = "UA693052990000026009035008867"; }), "cp.iban"), "error");
  assert.equal(lvl(run((s) => { s.cp.bank = ""; }), "cp.bank"), "warn");
  assert.equal(lvl(run((s) => { s.cp.bank = "АТ «ПУМБ», МФО 334851"; }), "cp.bank"), "warn", "🔴 МФО банку ≠ МФО в IBAN пропущено");
  // затверджено: телефон і пошта — лише попередження
  assert.equal(lvl(run((s) => { s.cp.phone = "123"; }), "cp.phone"), "warn", "🔴 телефон має лише попереджати (рішення 02.10)");
  assert.equal(lvl(run((s) => { s.cp.email = "test@"; }), "cp.email"), "warn", "🔴 пошта має лише попереджати (рішення 02.10)");
  assert.equal(lvl(run((s) => { s.cp.dir = "Тестенко"; }), "cp.dir"), "warn");
  assert.equal(lvl(run((s) => { s.cp.addr = "Київ"; }), "cp.addr"), "warn");
  // заявка
  assert.equal(lvl(run((s) => { s.dealNo = "6157-5919"; }), "dealNo"), "error");
  assert.equal(lvl(run(() => {}, { dealKnown: false }), "dealNo"), "warn", "🔴 угода, якої немає в CRM, має лише попереджати (рішення 02.10)");
  assert.equal(on(run(() => {}, { dealKnown: true }), "dealNo"), undefined);
  assert.equal(lvl(run((s) => { s.pay.sum = ""; }), "pay.sum"), "error", "🔴 сума має бути обовʼязковою (рішення 02.10)");
  assert.equal(lvl(run((s) => { s.pay.sum = "0"; }), "pay.sum"), "error");
  assert.equal(on(run((s) => { s.pay.sum = "13000,50"; }), "pay.sum"), undefined, "🔴 сума з комою відхилена");
  assert.equal(lvl(run((s) => { s.trip.unloadDate = "14.01.2026"; }), "trip.unloadDate"), "warn");
  assert.equal(lvl(run((s) => { s.docDate = "2026-11-15"; }), "docDate"), "warn");
  assert.equal(lvl(run((s) => { s.docDate = "2025-09-01"; }), "docDate"), "warn");
  assert.equal(on(run((s) => { s.docDate = "2026-10-30"; }), "docDate"), undefined);
  // основний договір: суми й № заявки не вимагаємо
  assert.deepEqual(run((s) => { s.doc = "main"; s.pay.sum = ""; s.dealNo = ""; }).filter((i) => i.field === "pay.sum" || i.field === "dealNo"), []);
  assert.match(firstError(run((s) => { s.cp.edrpou = "39404443"; s.pay.sum = ""; })) ?? "", /ЄДРПОУ/, "🔴 перша помилка — не та");
  assert.equal(firstError(run((s) => { s.cp.phone = "1"; })), null, "🔴 попередження блокує формування");
});

test("#1199 ПЕРЕВІРКА ПІДКЛЮЧЕНА: формування блокує 🔴, прев'ю віддає список, екран показує позначки й підсумок", () => {
  const src = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", rel), "utf8");
  const route = src("backend/src/routes/constructor.ts");
  assert.match(route, /const block = blockers\(s\) \?\? firstError\(await checkFields\(s\)\);\s*\n\s*if \(block\) throw new HttpError\(422, block\);/, "🔴 формування не блокується на помилках перевірки");
  assert.match(route, /blockers: blockers\(s\) \?\? firstError\(issues\), issues,/, "🔴 прев'ю не віддає список перевірок");
  assert.match(route, /FROM deals WHERE kommo_id = \$1::bigint/, "🔴 «угода є в CRM» звіряється не з deals.kommo_id");
  const ui = src("frontend/src/pages/dashboard/sections/ConstructorSection.tsx");
  assert.match(ui, /setIssues\(r\.issues \?\? \[\]\)/, "🔴 екран не бере перевірки з прев'ю");
  assert.match(ui, /<IssueSummary issues=\{issues\} \/>/, "🔴 немає підсумку біля «Сформувати»");
  for (const f of ["pay.sum", "dealNo", "docDate"]) assert.ok(ui.includes(`<FieldMsg is={iss("${f}")} />`), `🔴 під полем ${f} немає пояснення`);
});
