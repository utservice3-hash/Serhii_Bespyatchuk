import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyMark, systemOf, markNote, MANUAL, type PayMark } from "./paymentMarks.js";

/**
 * ✋ «Погоджено» і коментар на запиті «Оплати перевізникам» (Тетяна 26.10.2026; Роман: коментар необовʼязковий, погоджують
 * Тетяна й адмін). Гейти `#1288`–`#1288d` (вільні в `main` і в усіх гілках на 26.10.2026); `#1288c` — наступник знятого
 * `#1271d` (роутів стало чотири).
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const check = { ok: false, paidBy: null, reasons: ["оплати від клієнта немає, і ліміту немає"], notes: ["висить 2 дн."] };
const mark = (o: Partial<PayMark>): PayMark => ({ requestId: 1, approved: true, amount: 3000, by: "Тетяна", at: "2026-10-26T12:00:00Z", comment: null, commentBy: null, ...o });

/**
 * #1288 — ПОГОДЖЕННЯ ПОВЕРХ СИСТЕМИ, ПРИВʼЯЗАНЕ ДО СУМИ. «Перевірити» + погоджено на ту саму суму — «до оплати» з
 * `paidBy = 'вручну'` і причиною системи; сума інша (навіть на 1 ₴) — лишається «перевірити» з «погодьте знову»; система вже
 * «до оплати» — погодження нічого не міняє; коментар — лише примітка; без позначки — як система. Журнал із погодженням
 * (`systemOf`) — знову рішення системи, тож зняте погодження діє одразу.
 * 🧨 Червоніє, якщо стара згода пропустить нову суму, погодження сховає причину системи чи коментар перенесе в оплату.
 */
test("#1288 ПОГОДЖЕННЯ: та сама сума — «до оплати» вручну з причиною системи, інша — «погодьте знову», коментар нічого не переносить", () => {
  const ok = applyMark(check, 3000, mark({}));
  assert.deepEqual([ok.ok, ok.paidBy, ok.reasons, ok.manual?.by, ok.stale], [true, MANUAL, check.reasons, "Тетяна", false], "🔴 погодження на ту саму суму");
  const stale = applyMark(check, 3001, mark({}));
  assert.deepEqual([stale.ok, stale.stale, stale.reasons.length, /погодьте знову/.test(stale.reasons[1])], [false, true, 2, true], "🔴 інша сума пройшла як погоджена");
  assert.equal(applyMark(check, null, mark({})).ok, false, "🔴 без суми пройшло як погоджене");
  const sysOk = { ok: true, paidBy: "1С", reasons: [], notes: [] };
  assert.deepEqual([applyMark(sysOk, 3000, mark({})).paidBy, applyMark(sysOk, 3000, mark({})).manual], ["1С", null], "🔴 погодження переписало рішення системи «до оплати»");
  const c = applyMark(check, 3000, mark({ approved: false, amount: null, comment: "перевірю завтра", commentBy: "Роман" }));
  assert.deepEqual([c.ok, c.comment, markNote(c)], [false, "перевірю завтра", ["коментар (Роман): перевірю завтра"]], "🔴 коментар переніс в оплату чи загубився");
  assert.deepEqual(applyMark(check, 3000, null), { ...check, manual: null, stale: false, comment: null, commentBy: null }, "🔴 без позначки рішення змінилось");
  assert.deepEqual(systemOf({ ok: true, paidBy: MANUAL, reasons: check.reasons, notes: [] }), { ok: false, paidBy: null, reasons: check.reasons, notes: [] }, "🔴 журнал із погодженням не повернувся до рішення системи");
  assert.match(markNote(ok)[0], /^погоджено вручну — Тетяна, /, "🔴 у файлі не видно, хто погодив");
});

async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  // Кластер уже піднятий: впало підключення чи схема — зупинити його, інакше тест висить вічно на живому postgres.
  try {
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  } catch (e) { await c.end().catch(() => undefined); scratch.dispose(); throw e; }
  return { c, dispose: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #1288b — ЖИВИЙ SQL: ХТО Й ЩО ЗАПИСУЄТЬСЯ. Погодити можна лише вже перевірений «перевірити» з сумою (ще не перевірений,
 * уже «до оплати», без суми — 400, і нічого не пишеться); погоджується сума з Kommo в мить натискання; коментар іншої людини
 * не переписує, хто погодив; «Скасувати» лишає коментар; ні погодження, ні коментаря — рядок зникає.
 * 🧨 Червоніє, якщо погодити неперевірений запит, загубити автора погодження чи лишити порожній рядок.
 */
test("#1288b ЖИВИЙ SQL: погодити лише перевірений «перевірити» з сумою, автор погодження й коментаря окремо, порожнє — видаляється", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { setMark, loadMarks } = await import("./paymentMarks.js");
  const db = c as unknown as import("./finance.js").Db;
  try {
    await c.query(`INSERT INTO users (id, email, password_hash, role, is_active, full_name) VALUES (8, 'fin@test', 'x', 'admin', true, 'Тетяна'), (50, 'adm@test', 'x', 'admin', true, 'Роман')`);
    const ctx = { system: check, amountNow: 3000 };
    for (const [why, cx] of [["неперевірений", { system: null, amountNow: 3000 }], ["вже до оплати", { system: { ok: true, paidBy: "1С", reasons: [], notes: [] }, amountNow: 3000 }], ["без суми", { system: check, amountNow: null }]] as const)
      await assert.rejects(setMark(db, 8, { requestId: 62801503, approved: true }, cx as never), (e: any) => e?.status === 400, `🔴 погоджено: ${why}`);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM payment_request_marks`)).rows[0].n, 0, "🔴 відмова щось записала");
    await setMark(db, 8, { requestId: 62801503, approved: true, comment: "домовились, оплатять у пн" }, ctx);
    await setMark(db, 50, { requestId: 62801503, comment: "ок, бачу" }, ctx);
    let m = (await loadMarks(db, [62801503])).get(62801503)!;
    assert.deepEqual([m.approved, m.amount, m.by, m.comment, m.commentBy], [true, 3000, "Тетяна", "ок, бачу", "Роман"], "🔴 коментар переписав автора погодження чи суму");
    assert.deepEqual(applyMark(check, 3000, m).ok, true, "🔴 записане погодження не діє");
    await setMark(db, 50, { requestId: 62801503, approved: false }, ctx);
    m = (await loadMarks(db, [62801503])).get(62801503)!;
    assert.deepEqual([m.approved, m.amount, m.by, m.comment], [false, null, null, "ок, бачу"], "🔴 «Скасувати» загубило коментар чи лишило погодження");
    await setMark(db, 50, { requestId: 62801503, comment: "  " }, ctx);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM payment_request_marks`)).rows[0].n, 0, "🔴 порожня позначка лишилась рядком");
  } finally { await s.dispose(); }
});

/**
 * #1288c — МЕЖА ЕКРАНА «ОПЛАТИ ПЕРЕВІЗНИКАМ» (наступник `#1271d`, роутів стало чотири): на екрані номери карток і ПІБ,
 * тож усі роути — лише `view_private_finance` (Адмін, фінансист) ПЕРШИМ middleware; у матриці — дозвіл адміну й фінансисту
 * і заборона СЕО / ОД / КВП (дзеркало), «Погоджено» — deny-only; вкладка «Фінанси» рендерить екран, а без права — напис,
 * і даних не просить.
 * 🧨 Червоніє, якщо зняти право з будь-якого роута, дати його СЕО/ОД/КВП у матриці чи показати екран без права.
 */
test("#1288c МЕЖА ЕКРАНА «ОПЛАТИ ПЕРЕВІЗНИКАМ»: чотири роути під view_private_finance, «Погоджено» в матриці, без права — напис", async () => {
  const fin = SRC("routes/financePayments.ts");
  const handlers = [...fin.matchAll(/financePaymentsRouter\.(get|post|put|patch|delete)\("([^"]+)",\s*([^,]+),/g)];
  assert.equal(handlers.length, 4, "🔴 обробників не рівно чотири — гейт не бачить нового роута");
  for (const [, m, p, first] of handlers) assert.equal(first.trim(), `requirePerm("view_private_finance")`, `🔴 ${m.toUpperCase()} ${p}: першим стоїть «${first.trim()}»`);
  assert.match(SRC("index.ts"), /app\.use\("\/api\/finance\/payments", financePaymentsRouter\);/, "🔴 роутер не підключено");
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js");
  const m = (method: string, p: string) => ACCESS_MATRIX.find((x) => x.method === method && x.path.startsWith(p) && (x.path === p || x.path[p.length] === "?"));
  for (const p of ["/api/finance/payments", "/api/finance/payments/export.xlsx"]) {
    const r = m("GET", p);
    assert.ok(r, `🔴 ${p} немає в матриці`);
    assert.deepEqual([...r!.allow].sort(), ["admin", "financier"], `🔴 ${p}: дозвіл не рівно Адмін і фінансист`);
    for (const role of ["ceo", "opdir", "kvp", "manager"]) assert.ok(r!.deny.includes(role), `🔴 ${p}: ${role} не в забороні`);
  }
  assert.ok(m("POST", "/api/finance/payments/run")?.deny.includes("kvp"), "🔴 «Перевірити зараз» не в матриці");
  assert.deepEqual(m("POST", "/api/finance/payments/mark")?.deny, ["ceo", "opdir", "kvp", "hr", "team_lead", "manager"], "🔴 «Погоджено» не в матриці чи доступне СЕО / ОД / КВП");
  const sec = FE("pages/dashboard/sections/FinanceSection.tsx"), tab = FE("pages/dashboard/sections/FinancePaymentsTab.tsx");
  assert.match(sec, /\{tab === "payments" && <FinancePaymentsTab \/>\}/, "🔴 вкладка не рендерить екран");
  assert.match(sec, /\["payments", "Оплати перевізникам", false\]/, "🔴 вкладки немає в «Фінансах»");
  assert.match(tab, /const canView = \(getAuthPayload\(\)\?\.perms \?\? \[\]\)\.includes\("view_private_finance"\);/, "🔴 екран не за view_private_finance");
  assert.ok(tab.indexOf("if (!canView) return") < tab.indexOf("<table"), "🔴 таблиця рендериться до перевірки права");
  assert.match(tab, /if \(!canView\) return;\n\s*fetchCarrierPayments/, "🔴 без права екран все одно просить дані");
});

/**
 * #1288d — ПРОВОДКА. Прогін: позначки до розподілу «До оплати» / «Перевірити», у журнал — рішення з погодженням, але
 * причини СИСТЕМИ, у «Перевірити» — хто погодив і коментар. Екран: журнал → `systemOf` → поточна позначка з ЖИВОЮ сумою;
 * Excel каже «погоджено вручну». Фронт: «✓ Погоджено» лише на перевіреному «перевірити», «Скасувати» — на погодженому,
 * «💬» на будь-якому; причина системи лишається видно. Таблиця закрита від AI.
 * 🧨 Червоніє, якщо погодження не дійде до файлу, екран братиме стару позначку з журналу чи кнопка зʼявиться на неперевіреному.
 */
test("#1288d ПРОВОДКА: позначка до розподілу файлу, журнал — причини системи, екран — поточна позначка з живою сумою, кнопки лише де можна", () => {
  const j = SRC("jobs/buildPaymentFile.ts");
  assert.match(j, /const v = applyMark\(sys, r\.cash, marks\.get\(r\.id\) \?\? null\);[\s\S]{0,400}reasons: sys\.reasons, notes: sys\.notes \}\);\s*if \(v\.ok && m\) pay\.push\(payRow\(r, m\)\);/, "🔴 погодження не до розподілу файлу чи журнал із чужими причинами");
  assert.match(j, /\[\.\.\.v\.notes, \.\.\.markNote\(v\)\]\.join\("; "\)/, "🔴 у «Перевірити» не видно погодження й коментаря");
  assert.match(j, /const v = x \? applyMark\(systemOf\(\{ ok: x\.ok, paidBy: x\.paid_by, reasons: x\.reasons \?\? \[\], notes: x\.notes \?\? \[\] \}\), amountNow, mark\) : null;/, "🔴 екран бере позначку з журналу, а не поточну");
  assert.match(j, /const amountNow = d \? num\(cf\(d, REQ_FIELDS\.cash\)\)/, "🔴 екран звіряє погодження не з живою сумою");
  assert.match(j, /r\.paidBy === MANUAL \? `погоджено вручну — /, "🔴 Excel не каже «погоджено вручну»");
  const fe = FE("pages/dashboard/sections/FinancePaymentsTab.tsx");
  assert.match(fe, /\{!r\.pending && !r\.ok && <button className="hr-btn p"[^>]*onClick=\{\(\) => void approve\(r\)\}/, "🔴 «Погоджено» не лише на перевіреному «перевірити»");
  assert.match(fe, /\{r\.paidBy === "вручну" && <button className="hr-btn"[^>]*onClick=\{\(\) => void unapprove\(r\)\}>Скасувати<\/button>\}/, "🔴 немає «Скасувати» на погодженому");
  assert.match(fe, /onClick=\{\(\) => void comment\(r\)\}/, "🔴 немає коментаря");
  assert.match(fe, /система: \{r\.reasons\.join\("; "\)\}/, "🔴 причина системи схована після погодження");
  assert.match(SRC("db/schema.sql"), /REVOKE ALL ON payment_request_marks FROM ai_readonly;/, "🔴 таблиця відкрита для AI");
  assert.match(SRC("ai/metricTools.ts"), /"payment_request_marks"/, "🔴 таблиця не в заборонених AI");
});
