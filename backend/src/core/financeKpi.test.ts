import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  weekStart, periodStart, periodEnd, shiftPeriod, currentPeriod, computeValues, blockMonday, planFmImport, type FmFile, type KpiDef,
} from "./financeKpi.js";

/**
 * 💰 ФІНАНСИ, прохід 2а (01.10.2026): «Тиждень і місяць» — гейти `#940`–`#947` (діапазон названо в плані 29.09.2026;
 * `#940`–`#949` вільні в `main` і в усіх гілках на 01.10.2026).
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const status = (e: unknown) => (e as { status?: number }).status;

/**
 * #940 — ПЕРІОДИ ЗА КИЄВОМ, ТИЖДЕНЬ З ПОНЕДІЛКА, по обидва боки межі (літо й зима). Будь-яка дата → початок
 * періоду; кінець місяця — останній день; підписи «ФМ» з помилками (8-денний тиждень, рік 2025 у січні) дають
 * правильний понеділок.
 * 🧨 Червоніє, якщо брати дату за UTC, тиждень з неділі або рік із підпису буквально.
 */
test("#940 ПЕРІОДИ: тиждень Пн–Нд за Києвом по обидва боки межі (літо й зима), місяць, підписи «ФМ» з помилками", () => {
  assert.equal(currentPeriod("week", new Date("2026-10-04T20:30:00Z")), "2026-09-28", "🔴 неділя 23:30 за Києвом (літо) віднесена до наступного тижня");
  assert.equal(currentPeriod("week", new Date("2026-10-04T21:30:00Z")), "2026-10-05", "🔴 понеділок 00:30 за Києвом (літо) лишився в минулому тижні");
  assert.equal(currentPeriod("week", new Date("2026-11-01T21:30:00Z")), "2026-10-26", "🔴 неділя 23:30 за Києвом (зима) віднесена до наступного тижня");
  assert.equal(currentPeriod("week", new Date("2026-11-01T22:30:00Z")), "2026-11-02", "🔴 понеділок 00:30 за Києвом (зима) лишився в минулому тижні");
  assert.equal(currentPeriod("month", new Date("2026-09-30T21:30:00Z")), "2026-10-01", "🔴 місяць узято за UTC");
  assert.equal(weekStart("2026-09-20"), "2026-09-14", "🔴 неділя — початок тижня");
  assert.equal(weekStart("2026-09-14"), "2026-09-14");
  assert.deepEqual(periodStart("month", "2026-02-17"), { kind: "month", start: "2026-02-01" });
  assert.equal(periodEnd("month", "2026-02-01"), "2026-02-28");
  assert.equal(periodEnd("week", "2026-12-28"), "2027-01-03");
  assert.equal(shiftPeriod("month", "2026-01-01", -1), "2025-12-01");
  assert.throws(() => periodStart("day", "2026-09-14"), /тиждень або місяць/);
  assert.throws(() => periodStart("week", "2026-02-30"), /Невалідна дата/);
  assert.equal(blockMonday("15.03-22.03.2026"), "2026-03-16", "🔴 8-денний підпис «ФМ» дав не той понеділок");
  assert.equal(blockMonday("29.12-04.01.2025"), "2025-12-29", "🔴 рік 2025 у підписі січневого кінця прочитано буквально");
  assert.equal(blockMonday("28.09-04.10.2026"), "2026-09-28");
});

/**
 * #941 — ОБЧИСЛЮВАНІ: «Комісійні» = дохід − витрати (лише коли є обидва), «Разом» = сума ДІЮЧИХ ручних показників
 * розділу; порожнє ≠ нуль — немає жодного доданка → «не внесено». Гроші — у копійках.
 * 🧨 Червоніє, якщо порожнє рахувати нулем, підсумувати вимкнений показник або іншого розділу.
 */
test("#941 ОБЧИСЛЮВАНІ: різниця лише з обох, сума лише діючих свого розділу, порожнє ≠ нуль, копійки", () => {
  const defs: KpiDef[] = [
    { id: 1, sectionId: 1, kind: "manual", argA: null, argB: null, active: true },
    { id: 2, sectionId: 1, kind: "manual", argA: null, argB: null, active: true },
    { id: 3, sectionId: 1, kind: "diff", argA: 1, argB: 2, active: true },
    { id: 10, sectionId: 2, kind: "sum", argA: null, argB: null, active: true },
    { id: 11, sectionId: 2, kind: "manual", argA: null, argB: null, active: true },
    { id: 12, sectionId: 2, kind: "manual", argA: null, argB: null, active: true },
    { id: 13, sectionId: 2, kind: "manual", argA: null, argB: null, active: false },
  ];
  const v = computeValues(defs, new Map([[1, 0.3], [2, 0.1], [11, 0.1], [12, 0.2], [13, 1000]]));
  assert.equal(v.get(3), 0.2, "🔴 різниця з плаваючою похибкою");
  assert.equal(v.get(10), 0.3, "🔴 сума взяла вимкнений показник або похибку");
  const partial = computeValues(defs, new Map([[1, 500], [11, 70]]));
  assert.equal(partial.get(3), null, "🔴 різниця без витрат порахована як дохід − 0");
  assert.equal(partial.get(10), 70, "🔴 сума частково внесених — не сума внесених");
  const empty = computeValues(defs, new Map());
  assert.equal(empty.get(10), null, "🔴 порожній розділ дав нуль замість «не внесено»");
  assert.equal(empty.get(3), null);
});

/** Схема з нуля + автор (той самий прийом, що в `finance.test.ts`). */
async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  await c.query(`INSERT INTO users (id, email, password_hash, role, is_active) VALUES (901, 'fin@test', 'x', 'admin', true)`);
  return { c, db: c as unknown as import("./finance.js").Db, url: scratch.url, dispose: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #942 — ЖИВИЙ SQL: ЗАКРИТИЙ ПЕРІОД НЕЗМІННИЙ, І ЦЕ СКАСОВНО. Закрити → значення й нотатка = 409; відкрити →
 * змінити → закрити знову. Обчислюваний показник не вноситься (400), одна погана клітинка — нічого не записано.
 * 🧨 Червоніє, якщо закриття не блокує запису, відкриття неможливе або обчислюване приймається на вхід.
 */
test("#942 ЖИВИЙ SQL: закритий період — 409, відкрити→змінити→закрити, обчислюване не вноситься, все-або-нічого", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const sec = await k.createSection(db, 901, { name: "Поставлені авто" });
    const inc = await k.createKpi(db, 901, { sectionId: sec, name: "Дохід" });
    const exp = await k.createKpi(db, 901, { sectionId: sec, name: "Витрати" });
    const com = await k.createKpi(db, 901, { sectionId: sec, name: "Комісійні", kind: "diff", argA: inc, argB: exp });
    await assert.rejects(k.saveKpiValues(db, 901, "week", "2026-09-16", [{ kpiId: inc, value: "4 766 271" }, { kpiId: exp, value: "три" }]),
      (e: unknown) => status(e) === 400, "🔴 погана клітинка не зупинила збереження");
    assert.equal(Number((await c.query(`SELECT count(*) n FROM fin_kpi_values`)).rows[0].n), 0, "🔴 записано частину");
    await assert.rejects(k.saveKpiValues(db, 901, "week", "2026-09-14", [{ kpiId: com, value: 1 }]), (e: unknown) => status(e) === 400, "🔴 обчислюване прийнято на вхід");
    assert.deepEqual(await k.saveKpiValues(db, 901, "week", "2026-09-16", [{ kpiId: inc, value: "4 766 271" }, { kpiId: exp, value: "3 832 826" }]), { changed: 2 });
    const p = await k.loadPeriod(db, "week", "2026-09-20");
    assert.equal(p.start, "2026-09-14");
    assert.equal(p.sections[0].kpis.find((x) => x.id === com).value, 933445, "🔴 комісійні не = дохід − витрати");

    await k.setPeriodClosed(db, 901, "week", "2026-09-14", true);
    await assert.rejects(k.setPeriodClosed(db, 901, "week", "2026-09-14", true), (e: unknown) => status(e) === 409);
    await assert.rejects(k.saveKpiValues(db, 901, "week", "2026-09-14", [{ kpiId: inc, value: 1 }]), (e: unknown) => status(e) === 409, "🔴 у закритий тиждень записано значення");
    await assert.rejects(k.setKpiNote(db, 901, inc, "week", "2026-09-14", "x"), (e: unknown) => status(e) === 409, "🔴 у закритий тиждень записано нотатку");
    assert.ok((await k.loadPeriod(db, "week", "2026-09-14")).closed, "🔴 закриття не видно");
    await k.setPeriodClosed(db, 901, "week", "2026-09-14", false);
    await k.saveKpiValues(db, 901, "week", "2026-09-14", [{ kpiId: inc, value: "4 766 272" }]);
    await k.setPeriodClosed(db, 901, "week", "2026-09-14", true);
    const log = (await c.query(`SELECT what FROM fin_kpi_log ORDER BY id`)).rows.map((x) => x.what);
    assert.ok(log.some((w) => /Закрито тиждень 14\.09–20\.09\.2026/.test(w)) && log.some((w) => /Відкрито тиждень/.test(w)), "🔴 закриття/відкриття не в історії");
    assert.ok(log.some((w) => /Дохід · 14\.09–20\.09\.2026: 4\s766\s271 → 4\s766\s272/.test(w)), "🔴 зміна значення не в історії «було → стало»");
    // «Попередній період» у відповіді — для порівняння поруч.
    assert.equal((await k.loadPeriod(db, "week", "2026-09-21")).sections[0].kpis.find((x) => x.id === inc).prevValue, 4766272);
  } finally { await s.dispose(); }
});

/**
 * #943 — ЖИВИЙ SQL: ДОВІДКА CRM/1С ЛИШЕ ПОРУЧ І ЗАПАМʼЯТОВУЄТЬСЯ. Значення — те, що внесла людина, не довідка;
 * довідка в момент збереження лягає поруч і не змінюється, коли «живе» число змінилось після збереження.
 * 🧨 Червоніє, якщо підставляти довідку замість числа, показувати живе число як збережене або не зберігати.
 */
test("#943 ЖИВИЙ SQL: довідка CRM/1С не підміняє число й запамʼятовується в момент збереження", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const sec = await k.createSection(db, 901, { name: "Залишки" });
    const deb = await k.createKpi(db, 901, { sectionId: sec, name: "Дебіторка 1С" });
    await c.query(`UPDATE fin_kpis SET ref_source = 'receivables' WHERE id = $1`, [deb]);
    await k.saveKpiValues(db, 901, "week", "2026-09-21", [{ kpiId: deb, value: "11 242 215" }], { receivables: 11430073 });
    const p = await k.loadPeriod(db, "week", "2026-09-21", { receivables: 9999999 });
    const x = p.sections[0].kpis[0];
    assert.equal(x.value, 11242215, "🔴 число людини підмінено довідкою");
    assert.deepEqual([x.savedRef?.value, x.liveRef], [11430073, 9999999], "🔴 збережена довідка поїхала за живою або не збереглась");
    await k.saveKpiValues(db, 901, "week", "2026-09-21", [{ kpiId: deb, value: "11 242 215" }], { receivables: 1 });
    assert.equal((await k.loadPeriod(db, "week", "2026-09-21")).sections[0].kpis[0].savedRef?.value, 11430073, "🔴 незмінене значення переписало збережену довідку");
  } finally { await s.dispose(); }
});

/**
 * #977 — ЖИВИЙ SQL: АВТОМАТИЧНИЙ РЯДОК «ФМ» (`kind = 'auto'`, прохід 2б). Поточний тиждень — живе число ядра, не
 * збережене; руками не вноситься (400); фіксація пише число з `frozen_at` і далі воно не рухається від живого;
 * повторна фіксація нічого не змінює; закритий період не фіксується; ключа немає (дебіторка вже не того дня) —
 * лишається незафіксованим, а не отримує чуже число. По обидва боки: ручний рядок поруч вноситься як раніше.
 * 🧨 Червоніє, якщо віддати збережене замість живого, дозволити ручне внесення, перезаписати зафіксоване чи
 * зафіксувати дебіторку без знімка.
 */
test("#977 ЖИВИЙ SQL: авто-рядок — живе ядро до фіксації, зафіксоване не рухається, руками не вноситься", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const sec = await k.createSection(db, 901, { name: "Поставлені авто" });
    const inc = await k.createKpi(db, 901, { sectionId: sec, name: "Дохід" });
    const deb = await k.createKpi(db, 901, { sectionId: sec, name: "Дебіторка 1С" });
    const man = await k.createKpi(db, 901, { sectionId: sec, name: "Ручний" });
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'delivered_income' WHERE id = $1`, [inc]);
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'receivables' WHERE id = $1`, [deb]);
    // проміжне число з «ФМ», не зафіксоване — живого не перекриває
    await c.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value) VALUES ($1, 'week', '2026-09-28', 111)`, [inc]);
    const now = new Date("2026-09-30T10:00:00Z");
    const row = async (refs: Record<string, number>, id = inc) =>
      (await k.loadPeriod(db, "week", "2026-09-28", refs, now)).sections[0].kpis.find((x: any) => x.id === id);
    const live = await row({ delivered_income: 5000 });
    assert.deepEqual([live.value, live.autoState], [5000, "live"], "🔴 авто-рядок показав збережене замість живого ядра");
    await assert.rejects(k.saveKpiValues(db, 901, "week", "2026-09-28", [{ kpiId: inc, value: "1" }]), (e: any) => e.status === 400,
      "🔴 авто-рядок прийняв ручне число");
    assert.deepEqual(await k.saveKpiValues(db, 901, "week", "2026-09-28", [{ kpiId: man, value: "7" }]), { changed: 1 }, "🔴 ручний рядок поруч перестав вноситись");

    const f1 = await k.freezeAutoKpis(db, "week", "2026-09-28", { delivered_income: 5000 });
    assert.equal(f1.frozen, 1, "🔴 фіксація не записала авто-рядок або зафіксувала дебіторку без знімка");
    const after = await row({ delivered_income: 9000 });
    assert.deepEqual([after.value, after.autoState], [5000, "frozen"], "🔴 зафіксоване число поїхало за живим");
    assert.equal((await row({ receivables: 42 }, deb)).autoState, "live", "🔴 дебіторка без знімка позначена зафіксованою");
    const f2 = await k.freezeAutoKpis(db, "week", "2026-09-28", { delivered_income: 9000, receivables: 42 });
    assert.equal(f2.frozen, 1, "🔴 повторна фіксація перезаписала зафіксоване (або не зафіксувала дебіторку зі знімком)");
    assert.equal((await row({ delivered_income: 9000 })).value, 5000, "🔴 повторна фіксація перезаписала число");

    // минулий тиждень: дебіторки «зараз» для нього немає — показуємо збережене (з «ФМ»), а не порожнечу
    await c.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value) VALUES ($1, 'week', '2026-09-21', 777)`, [deb]);
    const past = (await k.loadPeriod(db, "week", "2026-09-21", { delivered_income: 1 }, now)).sections[0].kpis.find((x: any) => x.id === deb);
    assert.deepEqual([past.value, past.autoState], [777, "saved"], "🔴 авто-рядок без живого числа сховав збережене");

    await k.setPeriodClosed(db, 901, "week", "2026-10-05", true);
    assert.deepEqual(await k.freezeAutoKpis(db, "week", "2026-10-05", { delivered_income: 1 }), { frozen: 0, skipped: "період закрито" },
      "🔴 зафіксовано в закритому періоді");
  } finally { await s.dispose(); }
});

/**
 * #978 — ПРОВОДКА АВТОМАТИКИ: синк пише `fm_income`/`fm_expense` у КОЖНОМУ проході (вставка й оновлення, параметри
 * в тому ж порядку, що колонки); фіксація має крон за Києвом, догін на старті й нагляд; дебіторка дається періоду
 * лише як знімок свого дня — по обидва боки межі. 🧨 Червоніє, якщо синк пише колонки лише при вставці, параметри
 * зсунуті, джобу не заплановано / не наглядають, або минулий тиждень отримує сьогоднішню дебіторку.
 */
test("#978 ПРОВОДКА: синк пише fm_income і fm_expense щопрохід, фіксація в кроні й нагляді, дебіторка — лише знімок свого дня", async () => {
  const sync = SRC("jobs/syncKommo.ts");
  const ins = sync.slice(sync.indexOf("INSERT INTO deals ("));
  const cols = ins.slice(ins.indexOf("(") + 1, ins.indexOf(")")).split(",").map((x) => x.trim()).filter(Boolean);
  const upd = ins.slice(ins.indexOf("ON CONFLICT (kommo_id) DO UPDATE SET"), ins.indexOf("`,"));
  const params = ins.slice(ins.indexOf("`,") + 2, ins.indexOf("]\n    );")).split("\n").map((x) => x.trim().replace(/,$/, "")).filter((x) => x && x !== "[");
  const maxPh = Math.max(...[...ins.slice(0, ins.indexOf("`,")).matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.equal(maxPh, params.length, "🔴 у вставці угоди кількість параметрів не дорівнює кількості плейсхолдерів");
  for (const [col, fn] of [["fm_income", "extractFmIncome(deal)"], ["fm_expense", "extractFmExpense(deal)"]]) {
    // дві колонки без власного параметра: `synced_at` = now(), `client_key` ділить $12 з `client_key_raw` —
    // отже колонка після них = параметр на два позиції раніше
    assert.equal(params.indexOf(fn), cols.indexOf(col) - 2, `🔴 ${col} пишеться не своїм параметром`);
    assert.match(upd, new RegExp(`\\b${col} = EXCLUDED\\.${col}\\b`), `🔴 ${col} не оновлюється на вже відомих угодах`);
  }
  const idx = SRC("index.ts");
  assert.match(idx, /cron\.schedule\("5 0 \* \* \*",\s*\(\) => \{\s*void runJob\("freezeFinanceKpis", \(\) => runFreezeFinanceKpis\(\)\);\s*\}, \{ timezone: "Europe\/Kyiv" \}\)/,
    "🔴 фіксація не запланована щодня за Києвом");
  assert.match(idx, /\["freezeFinanceKpis", \(\) => runFreezeFinanceKpis\(\)\]/, "🔴 немає догону фіксації на старті");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "freezeFinanceKpis")?.everyMin, 1440, "🔴 мовчання фіксації ніхто не помітить");

  const { receivablesSnapshotFits: fits } = await import("./financeKpi.js");
  const at = (iso: string) => new Date(iso);
  assert.equal(fits("week", "2026-09-28", at("2026-09-30T10:00:00Z"), false), true, "🔴 поточний тиждень без дебіторки");
  assert.equal(fits("week", "2026-09-21", at("2026-09-30T10:00:00Z"), false), false, "🔴 минулий тиждень на екрані отримав сьогоднішню дебіторку");
  assert.equal(fits("week", "2026-09-21", at("2026-09-27T21:05:00Z"), true), true, "🔴 фіксація в понеділок 00:05 Києва не взяла дебіторку");
  assert.equal(fits("week", "2026-09-21", at("2026-09-28T21:05:00Z"), true), false, "🔴 фіксація у вівторок узяла дебіторку чужого дня");
  assert.equal(fits("month", "2026-09-01", at("2026-09-30T21:05:00Z"), true), true, "🔴 місяць: 1-ше 00:05 Києва не взяло дебіторку");
});

/**
 * #979 — ФРОНТ АВТОМАТИЧНИХ РЯДКІВ: поле вводу — лише в ручних (авто не редагується навіть у режимі внесення);
 * авто-рядок підписаний станом із сервера (наживо / зафіксовано / з «ФМ» / збережене); підказка називає правило
 * фінансиста, а не «Приход 1». По обидва боки: ручний рядок лишається полем вводу.
 * 🧨 Червоніє, якщо дати поле авто-рядку, прибрати підпис стану або повернути в підказку «Приход 1».
 */
test("#979 ФРОНТ АВТО-РЯДКІВ: поле лише в ручних, підпис стану з сервера, підказка — правило фінансиста", () => {
  const wk = FE("pages/dashboard/sections/FinanceWeekTab.tsx");
  assert.match(wk, /const input = edit && k\.kind === "manual" && k\.active;/, "🔴 поле вводу не лише в ручних рядках");
  assert.match(wk, /\{input\s*\? <input /, "🔴 ручний рядок перестав бути полем вводу");
  assert.match(wk, /k\.kind === "auto" && <span [^>]*title=\{k\.autoState \? AUTO_STATE\[k\.autoState\]\[1\]/, "🔴 авто-рядок без підпису стану");
  for (const st of ["live", "frozen", "closed", "saved"]) assert.match(wk, new RegExp(`\\b${st}: \\["`), `🔴 немає підпису стану «${st}»`);
  const hint = wk.slice(wk.indexOf("export const REF_HINT"), wk.indexOf("};", wk.indexOf("export const REF_HINT")));
  assert.equal((hint.match(/«Приход 1–5»/g) ?? []).length, 2, "🔴 підказка доходу — не Σ «Приход 1–5»");
  assert.equal((hint.match(/крім типу оплати «Оплата на выгрузке»/g) ?? []).length, 2, "🔴 підказка витрат не каже про виключення");
  assert.doesNotMatch(hint, /«Приход 1»|«Расход 1»|Дата акту/, "🔴 у підказці старе правило");
});

/**
 * #948 — СУМИ ЗА ПРАВИЛОМ ФІНАНСИСТА (`core/fmSums.ts`, підтверджено Тетяною 01.10.2026): дохід = Σ «Приход 1–5»,
 * витрати = Σ «Расход 1–5» КРІМ слотів «Оплата на выгрузке». По обидва боки: той самий слот з іншим типом рахується.
 * Порожнє ≠ нуль. 🧨 Червоніє, якщо брати лише «Приход 1», не виключати «Оплата на выгрузке» чи виключати інші типи.
 */
test("#948 СУМИ «ФМ»: дохід = Σ Приход 1–5, витрати = Σ Расход 1–5 без «Оплата на выгрузке», порожнє ≠ нуль", async () => {
  const fm = await import("./fmSums.js");
  const deal = (f: Record<number, string>) => (id: number) => f[id] ?? null;
  const d = deal({ 2097627: "1000", 2097683: "250.5", 2097689: "1 000,25", 2097661: "800", 2097651: "Безнал с НДС",
    2097663: "300", 2097653: "Оплата на выгрузке", 2097669: "50", 2097659: "Наличные" });
  assert.equal(fm.fmIncomeFrom(d), 2250.75, "🔴 дохід — не сума всіх п'яти «Приходів»");
  assert.equal(fm.fmExpenseFrom(d), 850, "🔴 «Оплата на выгрузке» не виключено або виключено зайве");
  const same = deal({ 2097661: "800", 2097651: "Оплата на выгрузке" });
  assert.equal(fm.fmExpenseFrom(same), 0, "🔴 угода з єдиним розходом «на выгрузке» має витрати 0, а не «не знаємо»");
  assert.equal(fm.fmExpenseFrom(deal({ 2097661: "800", 2097651: "Оплата на выгрузке ", 2097663: "1", 2097653: "Наличные" })), 1);
  assert.equal(fm.fmIncomeFrom(deal({})), null, "🔴 порожня угода дала нуль замість «не знаємо»");
  assert.equal(fm.fmExpenseFrom(deal({ 2097651: "Наличные" })), null);
  assert.equal(fm.fmIncomeFrom(deal({ 2097627: "0.1", 2097683: "0.2" })), 0.3, "🔴 сума з плаваючою похибкою");
});

/**
 * #949 — ЖИВИЙ SQL: ФІЛЬТРИ ФІНАНСИСТА В ЯДРІ ГРОШЕЙ (`money.finDeliveredByLoadDate` / `finUnloadedTwoFilters`).
 * «Поставлені» — 8 етапів (з «Виставленням рахунку» й «Перевезення завершено»), «Дата загрузки» за Києвом, обидва кінці;
 * «Вигружені» — ① «Очікуємо оплату»/«Оплата отримана» за датою СТВОРЕННЯ + ② «Успішна» за датою ЗАКРИТТЯ. Суми — `fm_*`.
 * 🧨 Червоніє, якщо взяти 6 етапів, «Приход 1» замість `fm_income`, UTC або дату акту для «Вигружених».
 */
test("#949 ЖИВИЙ SQL: «поставлені» — 8 етапів за датою загрузки, «вигружені» — два фільтри, суми fm_income і fm_expense, Київ", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  // money.ts тягне db/pool.js → config.js, який вимагає змінні ще на імпорті; сам пул тут не використовується
  // (функція отримує клієнт scratch-бази параметром). Той самий прийом, що в `absences.test.ts`.
  process.env.DATABASE_URL ??= s.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const money = await import("./money.js");
  const { c } = s;
  try {
    const ins = (id: number, pipe: number, st: number, x: { load?: string; created?: string; closed?: string; unload?: string }, inc: number | null, exp: number | null, p1 = 999999) =>
      c.query(`INSERT INTO deals (kommo_id, pipeline_id, status_id, load_at, created_at_kommo, closed_at_kommo, unload_at, fm_income, fm_expense, client_pay_amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, pipe, st, x.load ?? null, x.created ?? null, x.closed ?? null, x.unload ?? null, inc, exp, p1]);
    await ins(1, 8921932, 142, { load: "2026-09-13T21:30:00Z" }, 1000, 800);          // пн 14.09 00:30 Київ
    await ins(2, 8921932, 100274340, { load: "2026-09-20T20:30:00Z" }, 2000, 1500);   // «Виставлення рахунку», нд 23:30 Київ
    await ins(3, 8921932, 98470988, { load: "2026-09-15T10:00:00Z" }, 300, 100);      // «Перевезення завершено»
    await ins(4, 8921932, 142, { load: "2026-09-13T20:30:00Z" }, 50000, 1);           // нд 13.09 23:30 Київ — минулий тиждень
    await ins(5, 8921932, 143, { load: "2026-09-15T10:00:00Z" }, 70000, 1);           // «Закрито» — ні
    await ins(6, 8921936, 142, { load: "2026-09-15T10:00:00Z" }, 90000, 1);           // інша воронка — ні
    await ins(7, 8921932, 69716260, { load: "2026-09-16T10:00:00Z" }, null, 40);      // без суми доходу
    const d = await money.finDeliveredByLoadDate("2026-09-14", "2026-09-20", c as never);
    assert.deepEqual(d, { deals: 4, income: 3300, expense: 2440, noIncome: 1 }, "🔴 «поставлені» порахувались не за фільтром фінансиста");

    await ins(10, 8921932, 69716312, { created: "2026-09-14T08:00:00Z", unload: "2026-08-01T10:00:00Z" }, 100, 60);   // ① створена в тижні
    await ins(11, 8921932, 69716460, { created: "2026-09-10T08:00:00Z", unload: "2026-09-15T10:00:00Z" }, 7777, 7777); // ① створена ДО тижня — ні (дата акту не рахується)
    await ins(12, 8921932, 142, { closed: "2026-09-20T20:30:00Z" }, 400, 300);         // ② закрита нд 23:30 Київ
    await ins(13, 8921932, 142, { closed: "2026-09-13T20:30:00Z" }, 5555, 5555);       // ② закрита в минулому тижні — ні
    const u = await money.finUnloadedTwoFilters("2026-09-14", "2026-09-20", c as never);
    assert.deepEqual([u.open.deals, u.closed.deals, u.income, u.expense], [1, 1, 500, 360],
      "🔴 «вигружені» — не сума двох фільтрів (створення + закриття) на fm_*");
  } finally { await s.dispose(); }
});

/**
 * #945 — ДОСТУП: кожен роут «Тижня й місяця» — у матриці з тим самим складом, що й «План/факт»; закриває тиждень
 * той, хто вносить (`canEdit`, рішення Романа 29.09.2026), а не окреме право погодження.
 * 🧨 Червоніє, якщо роут не в матриці, склад інший або закриття стоїть під `canApprove`.
 */
test("#945 ДОСТУП «ТИЖНЯ Й МІСЯЦЯ»: усі роути в матриці з тим самим складом; закриває той, хто вносить", () => {
  const src = SRC("routes/finance.ts");
  const routes = [...src.matchAll(/financeRouter\.(get|post|patch|put|delete)\("(\/kpi[^"]*)"/g)].map((m) => [m[1].toUpperCase(), m[2]] as const);
  assert.ok(routes.length >= 13, `🔴 знайдено лише ${routes.length} роутів /kpi — гейт нічого не перевіряє`);
  const matrix = SRC("auth/accessMatrix.ts");
  for (const [m, p] of routes) {
    const re = new RegExp(`method: "${m}", path: "/api/finance${p.replace(/[/:?]/g, (ch) => `\\${ch}`)}(\\?[^"]*)?", cls: "([^"]+)",\\s*\\n\\s*allow: \\[([^\\]]*)\\], deny: \\[([^\\]]*)\\]`);
    const row = re.exec(matrix);
    assert.ok(row, `🔴 ${m} /api/finance${p} немає в матриці доступу`);
    const allow = [...row[3].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
    const deny = [...row[4].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
    assert.deepEqual(deny, ["hr", "manager", "team_lead"], `🔴 ${m} ${p}: заборонено не тим ролям`);
    if (row[2] !== "deny-only") assert.deepEqual(allow, ["admin", "ceo", "financier", "kvp", "opdir"], `🔴 ${m} ${p}: дозволено не тим ролям`);
  }
  assert.match(src, /financeRouter\.post\("\/kpi\/close", async \(req, res\) => \{\s*try \{\s*canEdit\(req\);/, "🔴 закриття тижня не за правом «вносити»");
});

/**
 * #946 — ПЕРЕНЕСЕННЯ «ФМ» (чиста функція + живий SQL). Тиждень бере ФІНАЛ із наступного блоку («минулого тижня»),
 * інакше проміжне з власного; блок, якого немає у файлі, не губить тиждень, що в ньому мав би стати фінальним.
 * Місяць блоку — за даними (Тетяна перемикає місяць, коли починає новий блок), фінал — «минулий місяць».
 * Обчислювані рядки не переносяться, а звіряються; розбіжність — у звіт. Повтор — 409; фінальні періоди закриті.
 * 🧨 Червоніє, якщо брати проміжне замість фіналу, місяць за календарем понеділка, губити розбіжності чи дозволити повтор.
 */
test("#946 ПЕРЕНЕСЕННЯ «ФМ»: фінал тижня з наступного блоку, місяці за даними, розбіжності у звіт, повтор — 409", async (t) => {
  const row = (e: string, g: string, f = ""): [string, string, string] => [e, f, g];
  // Найсвіжіший блок першим, як у файлі. Блок 07.09 «загубився» — тиждень 31.08 лишається проміжним, 07.09 — фінальний з 14.09.
  const file: FmFile = { blocks: [
    { b: 0, label: "14.09-20.09.2026", rows: { 3: row("6 161 265,74", "3 257 843,85"), 5: row("100", "50"), 6: row("40", "10"), 7: row("60", "40"),
      21: row("24 940 504,10", "17 189 495,18", "39445 EUR"), 23: row("22 337 479", "1"), 24: row("18 499 920", "0") } },
    { b: 1, label: "31.08-06.09.2026", rows: { 3: row("9 323 880,66", "2 538 953,34"), 5: row("200", "70"), 6: row("50", "30"), 7: row("999", "40"),
      21: row("24 940 504,10", "") } },
    { b: 2, label: "24.08-30.08.2026", rows: { 3: row("6 999 985,30", "4 201 066,00"), 21: row("24 696 937,39", "22 065 094,11") } },
  ] };
  const p = planFmImport(file, "2026-07-01");
  const w = new Map(p.weeks);
  assert.deepEqual([w.get("2026-09-07")?.values.in, w.get("2026-09-07")?.final], [6161265.74, true], "🔴 тиждень 07.09 не взяв фінал із блоку 14.09");
  assert.deepEqual([w.get("2026-08-31")?.values.in, w.get("2026-08-31")?.final], [2538953.34, false], "🔴 тиждень без наступного блоку не позначено проміжним");
  assert.deepEqual([w.get("2026-08-24")?.values.in, w.get("2026-08-24")?.final], [9323880.66, true], "🔴 тиждень 24.08 не взяв фінал із блоку 31.08");
  assert.deepEqual([w.get("2026-09-14")?.values.in, w.get("2026-09-14")?.final], [3257843.85, false]);
  const m = new Map(p.months);
  // Блок 31.08–06.09 несе вже ВЕРЕСЕНЬ (як у Тетяни): серпень — фінал 24 940 504,10, а не липень.
  assert.deepEqual([m.get("2026-08-01")?.values.in, m.get("2026-08-01")?.final], [24940504.1, true], "🔴 серпень узято не з «минулого місяця» вересневих блоків");
  assert.equal(m.get("2026-08-01")?.notes.in, "39445 EUR", "🔴 валютна нотатка місяця загубилась");
  assert.deepEqual([m.get("2026-07-01")?.values.in, m.get("2026-07-01")?.final], [24696937.39, true], "🔴 липень визначено за календарем понеділка");
  assert.deepEqual([m.get("2026-09-01")?.values.in, m.get("2026-09-01")?.final], [17189495.18, false]);
  assert.ok(p.mismatches.some((x) => /тиждень 2026-08-24 · Комісійні: у файлі 999/.test(x)), "🔴 розбіжність комісійних файлу не потрапила у звіт");
  assert.ok(!p.mismatches.some((x) => /тиждень 2026-09-07 · Комісійні/.test(x)), "🔴 правильна різниця позначена розбіжністю");

  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  try {
    const out = await k.importFm(s.db, null, file, "2026-07-01", new Date("2026-10-01T09:00:00Z"));
    assert.deepEqual(out.interim, { week: ["2026-08-31", "2026-09-14"], month: ["2026-09-01"] }, "🔴 проміжні періоди не названі");
    const sep7 = await k.loadPeriod(s.db, "week", "2026-09-07");
    assert.ok(sep7.closed, "🔴 фінальний тиждень не закрито після перенесення");
    assert.equal(sep7.sections.find((x) => x.name.startsWith("Поставлені"))!.kpis.find((x) => x.name === "Комісійні")!.value, 60);
    assert.equal((await k.loadPeriod(s.db, "week", "2026-08-31")).closed, null, "🔴 проміжний тиждень закрито");
    assert.equal((await k.loadPeriod(s.db, "week", "2026-08-31")).importedInterim, true, "🔴 екран не дізнається, що тиждень проміжний");
    await assert.rejects(k.importFm(s.db, null, file, "2026-07-01"), (e: unknown) => status(e) === 409, "🔴 повторне перенесення дозволено");
  } finally { await s.dispose(); }
});

/**
 * #947 — ФРОНТ: вкладка «Тиждень і місяць» — справжня (не «скоро»), права з відповіді сервера, «Повернути» на
 * видаленні показника й розділу, закриття тижня — кнопкою з тієї ж відповіді.
 * 🧨 Червоніє, якщо лишити заглушку, вгадувати права з ролі або видаляти без «Повернути».
 */
test("#947 ФРОНТ «ТИЖНЯ Й МІСЯЦЯ»: справжня вкладка, права з сервера, «Повернути» на видаленні", () => {
  const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const sec = codeOnly(FE("pages/dashboard/sections/FinanceSection.tsx"));
  assert.match(sec, /\{tab === "week" && <FinanceWeekTab /, "🔴 вкладка «Тиждень і місяць» досі заглушка");
  assert.doesNotMatch(sec, /\["week", "Тиждень і місяць", true\]/, "🔴 вкладка досі позначена «скоро»");
  const wk = codeOnly(FE("pages/dashboard/sections/FinanceWeekTab.tsx"));
  assert.doesNotMatch(wk, /roleKey|auth\.role|"financier"|"admin"/, "🔴 права вгадуються з ролі на клієнті");
  assert.match(wk, /data\.canEdit/, "🔴 редагування не за canEdit із сервера");
  for (const k of ["section", "kpi"])
    assert.match(wk, new RegExp(`await deleteFinKpi\\("${k}", [a-z]+\\.id(?:, confirm)?\\); reload\\(\\); undo\\("${k}", `), `🔴 видалення «${k}» без «Повернути»`);
  assert.match(wk, /setFinKpiClosed\(/, "🔴 немає закриття / відкриття періоду");
});
