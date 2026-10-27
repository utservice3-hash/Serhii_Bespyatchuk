import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { finFieldsOf, finFromRow, finRow, FIN_COLS } from "./dealFinFields.js";

/**
 * 💾 «Результат місяця» з бази + вкладка «Угоди місяця» (задача #5583, 26.10.2026; Роман: «окремою таблицею всі угоди
 * по кожному менеджеру, як окрему вкладку… оптимізація, а не підгружає по 5 хвилин»). Гейти `#1285`–`#1285d` (вільні в
 * `main` і в усіх гілках на 26.10.2026). Замір до: відкриття вересня 55 с, з них 54 с — запити до Kommo.
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");

/**
 * #1285 — ПОЛЯ УГОДИ ТІ САМІ З БАЗИ, ЩО Й НАЖИВО. `finFieldsOf` дає те, що раніше рахувалось на кожне відкриття
 * («Номер заказа» без нулів, галочка 1С лише `"true"`, «Приход 1–5», готівковий розхід, приходи й розходи за типом), а
 * рядок `deal_fin_fields` (`finRow` → `finFromRow`) повертає РІВНО ці самі поля — по обидва боки кожної межі.
 * 🧨 Червоніє, якщо загубити колонку при записі чи читанні, переплутати знак розходу чи прочитати «false» як галочку.
 */
test("#1285 ПОЛЯ УГОДИ: з бази — рівно те, що наживо (рахунок, галочка 1С, приходи, розходи за типом, вигрузка, без типу)", () => {
  const F: Record<number, string> = { 2096315: "№ 00123", 2096325: "true", 2097627: "10 000", 2097629: "Безнал с НДС", 2097683: "500,5", 2097631: "€ Безготівковий",
    2097661: "7000", 2097651: "Наличные", 2097669: "1500", 2097659: "Оплата на выгрузке" };
  const f = finFieldsOf((id) => F[id]);
  assert.deepEqual([f.orderNo, f.paid1c, f.income, f.cashExpense], ["123", true, 10500.5, 7000], "🔴 рахунок / галочка / прихід / готівковий розхід");
  assert.deepEqual([f.flows.in, f.flows.out, f.flows.untyped], [{ vat: 10000, novat: 0, cash: 0 }, { vat: 0, novat: 0, unload: -1500, cash: -7000 }, 1], "🔴 за типом");
  assert.equal(finFieldsOf((id) => (id === 2096325 ? "false" : undefined)).paid1c, false, "🔴 «false» прочитано як галочку");
  assert.deepEqual([finFieldsOf(() => undefined).income, finFieldsOf(() => undefined).orderNo], [null, null], "🔴 порожні поля — не «немає»");
  const row = Object.fromEntries(FIN_COLS.map((c, i) => [c, finRow(62700001, new Date("2026-10-26T08:00:00Z"), f)[i]]));
  assert.deepEqual(finFromRow(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "number" ? String(v) : v]))), f, "🔴 база ≠ наживо (запис або читання губить поле)");
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
 * #1285b — ЖИВИЙ SQL: ЗАПИС ПОЛІВ. Нова угода — вставка; новіший знімок Kommo перетирає; СТАРІШИЙ (повтор сторінки, запізнілий
 * інкремент) — ні; без дати зміни — перетирає (не знаємо — беремо свіже). Записується саме те, що повертає `finFromRow`.
 * 🧨 Червоніє, якщо старий знімок перепише новий чи запис загубить поле.
 */
test("#1285b ЖИВИЙ SQL: поля угоди — вставка, новіший знімок перетирає, старіший ні, читання = запис", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { upsertDealFin } = await import("./dealFinSync.js");
  const db = c as unknown as import("./finance.js").Db;
  const lead = (price: string, upd: number | null) => ({ id: 62700001, name: "", price: 0, pipeline_id: 8921932, status_id: 142, responsible_user_id: 1, created_at: 0,
    updated_at: upd as number, closed_at: 0, custom_fields_values: [{ field_id: 2097627, values: [{ value: price }] }, { field_id: 2097629, values: [{ value: "Безнал с НДС" }] }] });
  const read = async () => finFromRow((await c.query(`SELECT * FROM deal_fin_fields WHERE kommo_id = 62700001`)).rows[0]);
  try {
    await upsertDealFin(db, [lead("1000", 1_792_000_000) as never]);
    assert.equal((await read()).flows.in.vat, 1000, "🔴 вставка");
    await upsertDealFin(db, [lead("2000", 1_792_000_100) as never]);
    assert.equal((await read()).flows.in.vat, 2000, "🔴 новіший знімок не перетер");
    await upsertDealFin(db, [lead("500", 1_791_999_000) as never]);
    assert.equal((await read()).flows.in.vat, 2000, "🔴 старіший знімок переписав новіший");
    await upsertDealFin(db, [lead("700", null) as never]);
    assert.deepEqual([(await read()).flows.in.vat, (await read()).income], [700, 700], "🔴 без дати зміни не взято свіже");
  } finally { await s.dispose(); }
});

/**
 * #1285c — ВІДКРИТТЯ З БАЗИ, А НЕ З KOMMO. Розрахунок місяця читає `deal_fin_fields` і йде в Kommo лише по угоди, яких там
 * немає, без контактів; «Оновити з Kommo» спершу кличе інкремент. Синк — етап «Успішна» обох воронок «Повного циклу», за
 * датою зміни з запасом 10 хв від вотермарки; бекфіл — за датою закриття; крон :05/:35 і нагляд з тим самим інтервалом.
 * 🧨 Червоніє, якщо повернути запит до Kommo на кожне відкриття, тягнути всі угоди чи загубити вотермарку.
 */
test("#1285c ВІДКРИТТЯ З БАЗИ: Kommo лише по відсутні угоди, інкремент — успішні ПЦ за датою зміни, крон :05/:35 під наглядом", () => {
  const d = SRC("jobs/monthResultData.ts");
  assert.match(d, /SELECT \* FROM deal_fin_fields WHERE kommo_id = ANY\(\$1\)/, "🔴 поля не з бази");
  assert.match(d, /const missing = ids\.filter\(\(id\) => !out\.has\(id\)\);/, "🔴 у Kommo не лише по відсутні");
  assert.doesNotMatch(d, /fetchLeadsByIds\(/, "🔴 повернувся запит до Kommo з контактами на кожне відкриття");
  assert.match(d, /refresh \? syncDealFinance\(\)/, "🔴 «Оновити з Kommo» не дотягує змінене");
  const j = SRC("jobs/syncDealFinance.ts") + SRC("core/dealFinSync.ts");
  assert.match(j, /FULL_CYCLE_PIPELINES\.map\(\(p, i\) => `filter\[statuses\]\[\$\{i\}\]\[pipeline_id\]=\$\{p\}&filter\[statuses\]\[\$\{i\}\]\[status_id\]=142`\)/, "🔴 синк не лише «Успішна» Повного циклу");
  assert.match(j, /filter\[updated_at\]\[from\]=\$\{Math\.floor\(wm - OVERLAP_S\)\}/, "🔴 інкремент не від вотермарки з запасом");
  assert.match(j, /const OVERLAP_S = 600;/, "🔴 запас вотермарки не 10 хв");
  assert.match(j, /filter\[closed_at\]\[from\]=/, "🔴 бекфіл не за датою закриття");
  assert.match(SRC("index.ts"), /cron\.schedule\("5,35 \* \* \* \*", \(\) => \{\s*void runJob\("syncDealFinance", \(\) => syncDealFinance\(\)\);/, "🔴 крону немає");
  assert.match(SRC("jobs/monitoredJobs.ts"), /\{ name: "syncDealFinance", everyMin: 30,/, "🔴 нагляд не з тим самим інтервалом");
  for (const tbl of ["deal_fin_fields", "deal_fin_state"]) {
    assert.match(SRC("db/schema.sql"), new RegExp(`REVOKE ALL ON ${tbl} FROM ai_readonly;`), `🔴 ${tbl} відкрита для AI`);
    assert.match(SRC("ai/metricTools.ts"), new RegExp(`"${tbl}"`), `🔴 ${tbl} не в заборонених AI`);
  }
});

/**
 * #1285d — ВКЛАДКА «УГОДИ МІСЯЦЯ». Окрема вкладка «Фінансів» поруч із «Результатом місяця», місяць і менеджер спільні;
 * клік по менеджеру в зведенні відкриває його угоди. Одна таблиця всіх угод, згрупована за тим, хто закривав: заголовок
 * групи — числа СЕРВЕРА (ті самі, що в зведенні), підсумок групи, фільтри (на перевірці, мінусові, з рішенням, Kommo ≠ 1С,
 * без 1С), пошук, закріплені шапка й колонка угоди, рішення в рядку. Обидві вкладки беруть дані, колонки й рішення з
 * одного модуля — власного запиту чи копії колонок ні в кого немає.
 * 🧨 Червоніє, якщо вкладку загубити, групу рахувати не тими числами, що зведення, чи дати вкладкам розійтися.
 */
test("#1285d ВКЛАДКА «УГОДИ МІСЯЦЯ»: окрема, спільний місяць, групи з числами сервера, фільтри й пошук, закріплена шапка, один модуль", () => {
  const sec = FE("pages/dashboard/sections/FinanceSection.tsx");
  assert.match(sec, /\["result", "Результат місяця", false\], \["deals", "Угоди місяця", false\]/, "🔴 вкладки «Угоди місяця» немає поруч");
  assert.match(sec, /\{tab === "deals" && <FinanceMonthDealsTab ask=\{ask\} toast=\{toast\} ym=\{mrYm\} setYm=\{setMrYm\} manager=\{mrManager\} setManager=\{setMrManager\} \/>\}/, "🔴 вкладка не рендериться зі спільним місяцем");
  assert.match(sec, /onOpenDeals=\{\(m\) => \{ setMrManager\(m\); pick\("deals"\); \}\}/, "🔴 клік по менеджеру не відкриває угоди");
  const res = FE("pages/dashboard/sections/FinanceMonthResultTab.tsx"), deals = FE("pages/dashboard/sections/FinanceMonthDealsTab.tsx");
  assert.match(res, /onClick=\{\(\) => onOpenDeals\(m\.kommoUserId\)\}/, "🔴 рядок менеджера не веде в угоди");
  assert.match(deals, /угод <b>\{m\.deals\}<\/b> · результат <b>\{money\(m\.result\)\}<\/b>/, "🔴 заголовок групи — не числа сервера");
  assert.match(deals, /\{!shut && sums\(shown,/, "🔴 немає підсумку групи");
  for (const f of ["На перевірці", "Мінусові", "З рішенням", "Kommo ≠ 1С", "Без 1С"]) assert.ok(deals.includes(`"${f}"`), `🔴 немає фільтра «${f}»`);
  assert.match(deals, /String\(d\.id\)\.includes\(needle\) \|\| \(d\.client \?\? d\.name\)\.toLowerCase\(\)\.includes\(needle\)/, "🔴 пошук не за угодою й клієнтом");
  assert.match(deals, /position: "sticky", top: 0/, "🔴 шапка не закріплена");
  for (const [n, t] of [["зведення", res], ["угоди", deals]] as const) {
    assert.match(t, /from "\.\/financeMonthShared"/, `🔴 ${n} не з спільного модуля`);
    assert.doesNotMatch(t, /fetchMonthResult|setMonthResultOverride|const COLS/, `🔴 ${n} має власний запит чи копію колонок`);
  }
});
