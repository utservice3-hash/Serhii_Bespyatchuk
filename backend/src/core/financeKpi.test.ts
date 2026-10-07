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
    await c.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value) VALUES ($1, 'week', '2026-10-12', 111)`, [inc]);
    const now = new Date("2026-10-14T10:00:00Z");
    const row = async (refs: Record<string, number>, id = inc) =>
      (await k.loadPeriod(db, "week", "2026-10-12", refs, now)).sections[0].kpis.find((x: any) => x.id === id);
    const live = await row({ delivered_income: 5000 });
    assert.deepEqual([live.value, live.autoState], [5000, "live"], "🔴 авто-рядок показав збережене замість живого ядра");
    await assert.rejects(k.saveKpiValues(db, 901, "week", "2026-10-12", [{ kpiId: inc, value: "1" }]), (e: any) => e.status === 400,
      "🔴 авто-рядок прийняв ручне число");
    assert.deepEqual(await k.saveKpiValues(db, 901, "week", "2026-10-12", [{ kpiId: man, value: "7" }]), { changed: 1 }, "🔴 ручний рядок поруч перестав вноситись");

    const f1 = await k.freezeAutoKpis(db, "week", "2026-10-12", { delivered_income: 5000 });
    assert.equal(f1.frozen, 1, "🔴 фіксація не записала авто-рядок або зафіксувала дебіторку без знімка");
    const after = await row({ delivered_income: 9000 });
    assert.deepEqual([after.value, after.autoState], [5000, "frozen"], "🔴 зафіксоване число поїхало за живим");
    assert.equal((await row({ receivables: 42 }, deb)).autoState, "live", "🔴 дебіторка без знімка позначена зафіксованою");
    const f2 = await k.freezeAutoKpis(db, "week", "2026-10-12", { delivered_income: 9000, receivables: 42 });
    assert.equal(f2.frozen, 1, "🔴 повторна фіксація перезаписала зафіксоване (або не зафіксувала дебіторку зі знімком)");
    assert.equal((await row({ delivered_income: 9000 })).value, 5000, "🔴 повторна фіксація перезаписала число");

    // минулий тиждень: дебіторки «зараз» для нього немає — показуємо збережене (з «ФМ»), а не порожнечу
    await c.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value) VALUES ($1, 'week', '2026-10-05', 777)`, [deb]);
    const past = (await k.loadPeriod(db, "week", "2026-10-05", { delivered_income: 1 }, now)).sections[0].kpis.find((x: any) => x.id === deb);
    assert.deepEqual([past.value, past.autoState], [777, "saved"], "🔴 авто-рядок без живого числа сховав збережене");

    await k.setPeriodClosed(db, 901, "week", "2026-10-19", true);
    assert.deepEqual(await k.freezeAutoKpis(db, "week", "2026-10-19", { delivered_income: 1 }), { frozen: 0, skipped: "період закрито" },
      "🔴 зафіксовано в закритому періоді");
  } finally { await s.dispose(); }
});

/**
 * #1205 — ПРОВОДКА АВТОМАТИКИ: синк пише `fm_income`/`fm_expense` у КОЖНОМУ проході (вставка й оновлення, параметри
 * в тому ж порядку, що колонки); НІЧНОЇ фіксації немає (рішення Тетяни 05.10.2026: тижні живі, місяць — кнопкою), і
 * нагляд її не чекає (інакше вартовий кричав би «мовчить»); дебіторка дається періоду
 * лише як знімок свого дня — по обидва боки межі. 🧨 Червоніє, якщо синк пише колонки лише при вставці, параметри
 * зсунуті, нічну фіксацію повернуто в крон або нагляд, або минулий тиждень отримує сьогоднішню дебіторку.
 */
test("#1205 ПРОВОДКА: синк пише fm_income і fm_expense щопрохід, нічної фіксації немає, дебіторка — лише знімок свого дня", async () => {
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
  const idx = SRC("index.ts").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(idx, /runJob\("freezeFinanceKpis"|runFreezeFinanceKpis\(\)/, "🔴 нічна фіксація знову в розкладі — тижні замерзнуть без Тетяни");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.some((j) => j.name === "freezeFinanceKpis"), false, "🔴 нагляд чекає джобу, якої немає в розкладі — тривога «мовчить»");
  // а ДЕ ЦЕ ТЕПЕР: фіксує закриття (`setPeriodClosed` з refs) — доведено в #993 / #1221 (раніше #1201)
  assert.match(SRC("routes/finance.ts"), /const refs = closed \? await refsFor\(req\.body\?\.kind, req\.body\?\.p\) : \{\};/, "🔴 закриття не отримує числа для фіксації");

  const { receivablesSnapshotFits: fits } = await import("./financeKpi.js");
  const at = (iso: string) => new Date(iso);
  assert.equal(fits("week", "2026-09-28", at("2026-09-30T10:00:00Z"), false), true, "🔴 поточний тиждень без дебіторки");
  assert.equal(fits("week", "2026-09-21", at("2026-09-30T10:00:00Z"), false), false, "🔴 минулий тиждень на екрані отримав сьогоднішню дебіторку");
  assert.equal(fits("week", "2026-09-21", at("2026-09-27T21:05:00Z"), true), true, "🔴 фіксація в понеділок 00:05 Києва не взяла дебіторку");
  assert.equal(fits("week", "2026-09-21", at("2026-09-28T21:05:00Z"), true), false, "🔴 фіксація у вівторок узяла дебіторку чужого дня");
  assert.equal(fits("month", "2026-09-01", at("2026-09-30T21:05:00Z"), true), true, "🔴 місяць: 1-ше 00:05 Києва не взяло дебіторку");
});

/**
 * #1218 — ФРОНТ АВТОМАТИЧНИХ РЯДКІВ: поле вводу — там, де дозволяє СЕРВЕР (`editable`: ручні й операційні поверх
 * «План/факт», зустріч з Тетяною 05.10.2026); решта авто-рядків не редагується;
 * авто-рядок підписаний станом із сервера (наживо / зафіксовано / з «ФМ» / збережене); підказка називає правило
 * фінансиста, а не «Приход 1». По обидва боки: ручний рядок лишається полем вводу.
 * 🧨 Червоніє, якщо дати поле авто-рядку, прибрати підпис стану або повернути в підказку «Приход 1».
 */
test("#1218 ФРОНТ АВТО-РЯДКІВ: поле — де дозволяє сервер (ручні й операційні), підпис стану, підказка — правило фінансиста", () => {
  const wk = FE("pages/dashboard/sections/FinanceWeekTab.tsx");
  assert.match(wk, /const input = edit && \(k\.editable \?\? k\.kind === "manual"\) && k\.active;/, "🔴 поле вводу не за дозволом сервера");
  assert.match(wk, /\{input\s*\? <input /, "🔴 ручний рядок перестав бути полем вводу");
  const badge = wk.slice(wk.indexOf('{k.kind === "auto" && <span'), wk.indexOf("</span>}</td>", wk.indexOf('{k.kind === "auto" && <span')));
  assert.ok(badge.length > 0, "🔴 авто-рядок без позначки");
  assert.match(badge, /AUTO_STATE\[k\.autoState\]\[1\]/, "🔴 авто-рядок без підпису стану (підказка)");
  assert.match(badge, /k\.autoState \? AUTO_STATE\[k\.autoState\]\[0\]/, "🔴 авто-рядок без підпису стану (текст)");
  for (const st of ["live", "frozen", "override", "closed", "saved"]) assert.match(wk, new RegExp(`\\b${st}: \\["`), `🔴 немає підпису стану «${st}»`);
  const hint = wk.slice(wk.indexOf("export const REF_HINT"), wk.indexOf("};", wk.indexOf("export const REF_HINT")));
  assert.equal((hint.match(/«Приход 1–5»/g) ?? []).length, 2, "🔴 підказка доходу — не Σ «Приход 1–5»");
  assert.equal((hint.match(/крім типу оплати «Оплата на выгрузке»/g) ?? []).length, 2, "🔴 підказка витрат не каже про виключення");
  assert.doesNotMatch(hint, /«Приход 1»|«Расход 1»|Дата акту/, "🔴 у підказці старе правило");
});

/**
 * #1204 — СТАРТ АВТОМАТИКИ ЗА ДЖЕРЕЛОМ (зустріч з Тетяною 05.10.2026). Фільтри Kommo («Поставлені», «Вигрузка») — з
 * ВЕРЕСНЯ (тиждень 31.08), бо звірка дала рівно її числа; решта авто-рядків («Виписка», «План/факт», дебіторка) — як
 * і було, з 05.10 / жовтня: у вересні там немає Сейфу, карток і зарплат. По обидва боки кожної межі.
 * 🧨 Червоніє, якщо вересень «Поставлених» знову показує число з таблиці, або «Гроші» вересня — неповну «Виписку».
 */
test("#1204 СТАРТ ЗА ДЖЕРЕЛОМ: фільтри Kommo — з вересня, «Виписка» й «План/факт» — з 05.10 / жовтня", async (t) => {
  const kk = await import("./financeKpi.js");
  assert.deepEqual([kk.autoActiveFor("delivered_income", "week", "2026-08-24"), kk.autoActiveFor("delivered_income", "week", "2026-08-31"),
    kk.autoActiveFor("unloaded_expense", "month", "2026-08-01"), kk.autoActiveFor("unloaded_expense", "month", "2026-09-01")], [false, true, false, true],
  "🔴 межа старту фільтрів Kommo зсунута");
  assert.deepEqual([kk.autoActiveFor("bank_in", "month", "2026-09-01"), kk.autoActiveFor("bank_in", "month", "2026-10-01"),
    kk.autoActiveFor("opex_general", "week", "2026-09-28"), kk.autoActiveFor("opex_general", "week", "2026-10-05")], [false, true, false, true],
  "🔴 «Виписка» / «План/факт» стартували з вересня — там немає Сейфу, карток і зарплат");
  const s = await scratchDb(t);
  if (!s) return;
  const { db, c } = s;
  try {
    const sec = await kk.createSection(db, 901, { name: "Зміш" });
    const del = await kk.createKpi(db, 901, { sectionId: sec, name: "Поставлені · дохід" });
    const inc = await kk.createKpi(db, 901, { sectionId: sec, name: "Надходження загальні" });
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'delivered_income' WHERE id = $1`, [del]);
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'bank_in' WHERE id = $1`, [inc]);
    await c.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value) VALUES ($1, 'month', '2026-09-01', 26220353), ($2, 'month', '2026-09-01', 30000000)`, [del, inc]);
    const refs = { delivered_income: 26725166, bank_in: 1 };
    const rows = (await kk.loadPeriod(db, "month", "2026-09-01", refs, new Date("2026-10-05T15:00:00Z"))).sections[0].kpis;
    const by = (id: number) => rows.find((x: any) => x.id === id);
    assert.deepEqual([by(del).value, by(del).kind, by(del).autoState], [26725166, "auto", "live"], "🔴 вересень «Поставлених» показує число з таблиці, а не CRM");
    assert.deepEqual([by(inc).value, by(inc).kind], [30000000, "manual"], "🔴 вересень «Надходжень» підмінено неповною «Виписки»");
    await assert.rejects(kk.saveKpiValues(db, 901, "month", "2026-09-01", [{ kpiId: del, value: "1" }], refs), (e: unknown) => status(e) === 400, "🔴 CRM-рядок вересня вноситься руками");
    assert.deepEqual(await kk.saveKpiValues(db, 901, "month", "2026-09-01", [{ kpiId: inc, value: "31 000 000" }], refs), { changed: 1 }, "🔴 табличний рядок вересня не вноситься");
  } finally { await s.dispose(); }
});

/**
 * #1217 — «БЕКФІЛ ПО ТАБЛИЦІ» (`importFmPeriods`): фінал тижня 28.09 і вересня з аркуша лягає в базу, позначка
 * «проміжне» знімається, а період НЕ закривається (місяць закриває Тетяна кнопкою, зустріч 05.10.2026) — КРІМ рядків із фільтрів Kommo: їх у цих періодах уже рахує CRM
 * (з вересня, #1204), і число з таблиці їх не перекриває. Відмова (нічого не записано): проміжне у файлі, закритий період,
 * період після старту автоматики. 🧨 Червоніє, якщо записати проміжне, переписати закрите чи період, який рахує CRM.
 */
test("#1217 ПЕРІОДИ З «ФМ»: лише фінал, незакриті й до старту; період лишається відкритим; рядки Kommo — з CRM", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const row = (e: string, g: string): [string, string, string] => [e, "", g];
  const b28 = { b: 1, label: "28.09-04.10.2026", rows: { 3: row("1000", "50"), 5: row("10", "5"), 21: row("24 000 000", "26 000 000") } };
  const b21 = { b: 2, label: "21.09-27.09.2026", rows: { 3: row("900", "400"), 21: row("24 000 000", "") } };
  const file1: FmFile = { blocks: [b28, b21] };
  const file2: FmFile = { blocks: [{ b: 0, label: "05.10-11.10.2026", rows: { 3: row("1 111", "77"), 5: row("12", "3"), 21: row("30 858 596", "1") } }, b28, b21] };
  const { db } = s;
  try {
    await k.importFm(db, null, file1, "2026-09-21", new Date("2026-10-01T09:00:00Z"));
    const val = async (kind: "week" | "month", p: string, sec: string, name: string) =>
      (await k.loadPeriod(db, kind, p)).sections.find((x) => x.name.startsWith(sec))!.kpis.find((x) => x.name === name)!.value;
    assert.equal(await val("week", "2026-09-28", "Гроші", "Надходження загальні"), 50, "🔴 фікстура: тиждень 28.09 не проміжний");

    // причина перевіряється ТЕКСТОМ: усі три відмови — 409, і одна може прикрити відсутність іншої (05.10 у файлі теж проміжний)
    const why = (re: RegExp) => (e: unknown) => status(e) === 409 && re.test((e as Error).message);
    await assert.rejects(k.importFmPeriods(db, null, file1, [{ kind: "week", start: "2026-09-28" }]), why(/проміжне/), "🔴 записано проміжне");
    await assert.rejects(k.importFmPeriods(db, null, file2, [{ kind: "week", start: "2026-09-28" }, { kind: "week", start: "2026-09-21" }]),
      why(/закрито/), "🔴 переписано закритий тиждень");
    await assert.rejects(k.importFmPeriods(db, null, file2, [{ kind: "week", start: "2026-09-28" }, { kind: "week", start: "2026-10-05" }]),
      why(/після старту автоматики/), "🔴 записано тиждень, який рахує CRM");
    await assert.rejects(k.importFmPeriods(db, null, file2, [{ kind: "month", start: "2026-10-01" }]), why(/після старту автоматики/), "🔴 записано жовтень");
    assert.equal(await val("week", "2026-09-28", "Гроші", "Надходження загальні"), 50, "🔴 відмова лишила перший період записаним");

    const out = await k.importFmPeriods(db, null, file2, [{ kind: "week", start: "2026-09-28" }, { kind: "month", start: "2026-09-01" }]);
    assert.equal(out.length, 2);
    assert.equal(await val("week", "2026-09-28", "Гроші", "Надходження загальні"), 1111, "🔴 тиждень 28.09 не взяв фінал із блоку 05.10");
    const stored = await s.c.query(`SELECT v.value::text AS v FROM fin_kpi_values v JOIN fin_kpis f ON f.id = v.kpi_id JOIN fin_kpi_sections x ON x.id = f.section_id
      WHERE x.name LIKE 'Поставлені%' AND f.name = 'Дохід' AND v.period_kind = 'week' AND v.period_start = '2026-09-28'`);
    assert.deepEqual(stored.rows.map((r: any) => r.v), ["5.00"], "🔴 таблиця перекрила рядок Kommo, який з вересня рахує CRM (лишилось проміжне 5 — його ніхто не чіпав)");
    assert.equal(await val("month", "2026-09-01", "Гроші", "Надходження загальні"), 30858596, "🔴 вересень не взяв фінал");
    const p = await k.loadPeriod(db, "week", "2026-09-28");
    assert.deepEqual([!!p.closed, p.importedInterim], [false, false], "🔴 перенесення закрило період (його закриває Тетяна) або лишило «проміжним»");
    // повтор — не помилка (період відкритий), а «нічого не змінилось»
    const again = await k.importFmPeriods(db, null, file2, [{ kind: "week", start: "2026-09-28" }]);
    assert.equal(again[0].changed.length, 0, "🔴 повтор переніс ще раз те саме");
  } finally { await s.dispose(); }
});

/** Статті «План/факт» для гейтів проходу 2в: дві групи, п'ять статей, факт жовтня. */
async function opexFixture(db: import("./finance.js").Db) {
  const fin = await import("./finance.js");
  const r = await fin.createResp(db, 901, { name: "Офіс-менеджер" });
  const g1 = await fin.createGroup(db, 901, { respId: r, name: "Оренда" });
  const g2 = await fin.createGroup(db, 901, { respId: r, name: "Реклама" });
  const id = { rent: await fin.createItem(db, 901, { groupId: g1, name: "Оренда офісу" }),
    power: await fin.createItem(db, 901, { groupId: g1, name: "Електроенергія" }),
    ads: await fin.createItem(db, 901, { groupId: g2, name: "Google Ads" }),
    seo: await fin.createItem(db, 901, { groupId: g2, name: "SEO" }),
    gone: await fin.createItem(db, 901, { groupId: g2, name: "Видалена" }) };
  const now = new Date("2026-10-20T10:00:00Z");
  await fin.saveValues(db, 901, "2026-10-01", [{ itemId: id.rent, field: "fact", value: "40000" }, { itemId: id.power, field: "fact", value: "3 500,50" },
    { itemId: id.ads, field: "fact", value: "12000" }, { itemId: id.seo, field: "fact", value: "700" }, { itemId: id.gone, field: "fact", value: "99999" }], now);
  await fin.deleteItem(db, 901, id.gone, true);
  return { fin, g1, g2, id, now };
}

/**
 * #991 — ЖИВИЙ SQL: РОЗДІЛ СТАТТІ (`setItemSections`). Лише чотири значення або «без розділу»; кілька статей —
 * усе або нічого (видалена в списку → 404 і НІЧОГО не змінено); відповідь несе «що було», і той самий виклик із цим
 * списком повертає як було («Повернути»); зміна — у журналі статті; `loadMonth` віддає розділ.
 * 🧨 Червоніє, якщо прийняти довільний текст, записати половину списку чи не віддати «що було».
 */
test("#991 ЖИВИЙ SQL: розділ статті — чотири значення, усе або нічого, «Повернути» тим самим викликом", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { db, c } = s;
  try {
    const { fin, id } = await opexFixture(db);
    await assert.rejects(fin.setItemSections(db, 901, [{ id: id.rent, section: "Комерційні" }]), (e: unknown) => status(e) === 400, "🔴 прийнято довільний розділ");
    await assert.rejects(fin.setItemSections(db, 901, [{ id: id.rent, section: "admin" }, { id: id.gone, section: "admin" }]),
      (e: unknown) => status(e) === 404, "🔴 видалена стаття прийнята");
    assert.equal((await c.query(`SELECT section FROM fin_items WHERE id = $1`, [id.rent])).rows[0].section, null, "🔴 відмова лишила половину списку записаною");
    const r1 = await fin.setItemSections(db, 901, [{ id: id.rent, section: "admin" }, { id: id.power, section: "admin" }]);
    assert.deepEqual(r1.previous, [{ id: id.rent, section: null }, { id: id.power, section: null }], "🔴 немає «що було» для «Повернути»");
    await fin.setItemSections(db, 901, [{ id: id.rent, section: "general" }]);
    const m = await fin.loadMonth(db, "2026-10-01");
    const items = m.tree.flatMap((r) => r.groups.flatMap((g) => g.items));
    assert.deepEqual([items.find((i) => i.id === id.rent)?.section, items.find((i) => i.id === id.power)?.section], ["general", "admin"], "🔴 екран не бачить розділу");
    await fin.setItemSections(db, 901, r1.previous);
    assert.deepEqual((await c.query(`SELECT section FROM fin_items WHERE id = ANY($1) ORDER BY id`, [[id.rent, id.power]])).rows.map((x) => x.section), [null, null],
      "🔴 «Повернути» не повернуло як було");
    const lg = await c.query(`SELECT what FROM fin_log WHERE kind = 'item' AND target_id = $1 ORDER BY id`, [id.rent]);
    assert.ok(lg.rows.some((x) => /Розділ «Оренда офісу»: без розділу → Адміністративні/.test(x.what)), "🔴 зміна розділу не в журналі");
  } finally { await s.dispose(); }
});

/**
 * #992 — ЖИВИЙ SQL: МІСЯЦЬ «ОПЕРАЦІЙНИХ» = Σ ФАКТУ СТАТЕЙ РОЗДІЛУ (`opexMonth` + `isAutoIn`). Видалені статті не
 * рахуються; статті без розділу — окремим числом (не губляться мовчки); розділ без жодної статті — ключа немає, і рядок
 * лишається ручним (ЗП); тиждень — завжди ручний (факт помісячний); вересень (до старту) — число з таблиці.
 * 🧨 Червоніє, якщо рахувати видалені, загубити безрозділові, почати рахувати тиждень чи заблокувати ручне «ЗП».
 */
test("#992 ЖИВИЙ SQL: місяць операційних — Σ факту розділу; без розділу видно; тиждень і порожній розділ — вручну", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db } = s;
  try {
    const { fin, id, now } = await opexFixture(db);
    await fin.setItemSections(db, 901, [{ id: id.rent, section: "general" }, { id: id.power, section: "general" }, { id: id.ads, section: "commercial" }]);
    const o = await k.opexMonth(db, "2026-10-01");
    assert.deepEqual(o.refs, { opex_general: 43500.5, opex_commercial: 12000 }, "🔴 Σ факту розділу хибна або порахована видалена стаття");
    assert.deepEqual(o.unassigned, { items: 1, fact: 700 }, "🔴 стаття без розділу загубилась мовчки");

    const sec = await k.createSection(db, 901, { name: "Операційні витрати" });
    const mk = async (name: string, ref: string) => { const x = await k.createKpi(db, 901, { sectionId: sec, name });
      await s.c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = $2 WHERE id = $1`, [x, ref]); return x; };
    const gen = await mk("Загальні витрати", "opex_general"), pay = await mk("ЗП + Податки на ЗП", "opex_payroll");
    const row = async (kind: "week" | "month", p: string, refs: Record<string, number | null>, kid: number) =>
      (await k.loadPeriod(db, kind, p, refs, now)).sections[0].kpis.find((x: any) => x.id === kid);
    const oct = await row("month", "2026-10-01", o.refs, gen);
    assert.deepEqual([oct.value, oct.kind, oct.autoState], [43500.5, "auto", "live"], "🔴 місяць не взяв Σ розділу");
    assert.equal((await row("month", "2026-10-01", o.refs, pay)).kind, "manual", "🔴 «ЗП» без статей заблоковано від ручного внесення");
    assert.deepEqual(await k.saveKpiValues(db, 901, "month", "2026-10-01", [{ kpiId: pay, value: "800000" }], o.refs), { changed: 1 }, "🔴 «ЗП» не вноситься");
    // Ручне число поверх «План/факт» — дозволене з 05.10.2026 (зустріч з Тетяною); доводить #1208.
    assert.equal((await row("week", "2026-10-12", o.refs, gen)).kind, "manual", "🔴 тиждень почав рахуватись із помісячного факту");
    assert.deepEqual(await k.saveKpiValues(db, 901, "week", "2026-10-12", [{ kpiId: gen, value: "9000" }], o.refs), { changed: 1 }, "🔴 тиждень не вноситься");
    assert.equal((await row("month", "2026-09-01", o.refs, gen)).kind, "manual", "🔴 вересень (до старту) порахувався з «План/факт»");
  } finally { await s.dispose(); }
});

/**
 * #993 — ЖИВИЙ SQL: ЗАКРИТТЯ МІСЯЦЯ ФІКСУЄ ОПЕРАЦІЙНІ (`setPeriodClosed` з `refs`). Нічна фіксація їх НЕ чіпає (факт
 * вносять після кінця місяця); закриття — фіксує, і правка «План/факт» після цього число не рухає; відкриття знову
 * робить їх живими, а рядки з Kommo лишаються зафіксованими. По обидва боки межі.
 * 🧨 Червоніє, якщо вночі зафіксувати недовнесений місяць, закритий місяць попливе за «План/факт» або відкриття
 * розморозить «Поставлені».
 */
test("#993 ЖИВИЙ SQL: закриття фіксує операційні, вночі — ні; відкриття оживляє лише їх", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const { fin, id, now } = await opexFixture(db);
    await fin.setItemSections(db, 901, [{ id: id.ads, section: "commercial" }]);
    const sec = await k.createSection(db, 901, { name: "Операційні витрати" });
    const com = await k.createKpi(db, 901, { sectionId: sec, name: "Комерційні витрати" });
    const del = await k.createKpi(db, 901, { sectionId: sec, name: "Поставлені · дохід" });
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'opex_commercial' WHERE id = $1`, [com]);
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'delivered_income' WHERE id = $1`, [del]);
    const refs = async () => ({ ...(await k.opexMonth(db, "2026-10-01")).refs, delivered_income: 5000 });
    const val = async (r: Record<string, number | null>) => Object.fromEntries((await k.loadPeriod(db, "month", "2026-10-01", r, now)).sections[0].kpis.map((x: any) => [x.id, [x.value, x.autoState]]));

    assert.equal((await k.freezeAutoKpis(db, "month", "2026-10-01", await refs())).frozen, 1, "🔴 нічна фіксація зачепила операційні (або не зафіксувала Kommo)");
    assert.deepEqual((await val(await refs()))[com], [12000, "live"], "🔴 операційні зафіксовано вночі");

    await k.setPeriodClosed(db, 901, "month", "2026-10-01", true, await refs());
    await fin.saveValues(db, 901, "2026-10-01", [{ itemId: id.ads, field: "fact", value: "15000" }], now);
    assert.deepEqual((await val(await refs()))[com], [12000, "frozen"], "🔴 закритий місяць поплив за «План/факт»");

    await k.setPeriodClosed(db, 901, "month", "2026-10-01", false);
    const after = await val({ ...(await refs()), delivered_income: 7777 });
    assert.deepEqual(after[com], [15000, "live"], "🔴 відкритий місяць не повернувся до «План/факт»");
    assert.deepEqual(after[del], [5000, "frozen"], "🔴 відкриття розморозило рядок із Kommo");
  } finally { await s.dispose(); }
});

/**
 * #994 — ВАЛЮТНА ДЕБІТОРКА З 1С (рахунок 362). `fxTotals`: Σ у гривні й у валюті в копійках, плюс друге число —
 * рахунки з боргом у валюті й нульовим гривневим еквівалентом. `receivablesFxAt` (живий SQL): період отримує
 * останній підсумок НЕ пізніше свого кінця; підсумок старший за добу — немає числа, а не старе. Адреса 362 ніколи не
 * збігається з 361. 🧨 Червоніє, якщо взяти сьогоднішній підсумок для минулого тижня, показати добове мовчання синку
 * старим числом або тягнути валютну з гривневого рахунку.
 */
test("#994 ВАЛЮТНА ДЕБІТОРКА: підсумок 1С (362) на кінець періоду, застаре — порожньо, адреса ≠ 361", async (t) => {
  const rc = await import("./receivables1c.js");
  const rows = rc.parse1cPayload([{ Contractor: "А ТОВ", DetailInfo: [{ Account: "Рахунок 1 від 01.09.2026", Sum: 100000.1, SumVal: 2400.5 }, { Sum: 0, SumVal: 15 }] },
    { Contractor: "Б ТОВ", DetailInfo: [{ Sum: 0.2, SumVal: 0 }] }]).rows;
  const tot = rc.fxTotals(rows);
  assert.deepEqual([tot.rows, tot.totalUah, tot.totalVal, tot.zeroUah], [3, 100000.3, 2415.5, 1], "🔴 підсумок валютної дебіторки хибний або загубив рахунок із нульовим ₴");
  const cfg = SRC("config.ts");
  assert.match(cfg, /receivables1cFxUrl:[\s\S]*?debit-balance-account-362"/, "🔴 валютна дебіторка не з рахунку 362");
  assert.match(cfg, /\/-361\$\/\.test\(process\.env\.RECEIVABLES_1C_URL/, "🔴 перевизначений URL 361 може потрапити у валютну без заміни");

  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const put = (at: string, uah: number) => c.query(`INSERT INTO receivables_fx_totals (synced_at, rows, total_uah, total_val) VALUES ($1, 1, $2, 1)`, [at, uah]);
    await put("2026-10-11T20:50:00Z", 111);   // нд 11.10 23:50 Київ — кінець тижня 05.10
    await put("2026-10-11T21:10:00Z", 222);   // пн 12.10 00:10 Київ — уже наступний тиждень
    await put("2026-10-14T09:00:00Z", 333);
    const now = new Date("2026-10-14T10:00:00Z");
    assert.equal((await k.receivablesFxAt(db, "2026-10-11", now))?.uah, 111, "🔴 минулий тиждень отримав пізніший підсумок");
    assert.equal((await k.receivablesFxAt(db, "2026-10-18", now))?.uah, 333, "🔴 поточний тиждень не взяв свіжий підсумок");
    assert.equal(await k.receivablesFxAt(db, "2026-10-18", new Date("2026-10-15T10:00:00Z")), null, "🔴 добове мовчання синку показане старим числом");
    assert.equal(await k.receivablesFxAt(db, "2026-10-04", now), null, "🔴 період до журналу отримав чуже число");
  } finally { await s.dispose(); }
});

/**
 * #995 — РАЗОВИЙ КРОК СХЕМИ ПРОХОДУ 2в і СИНК 362. На базі з рядками «ФМ» старого вигляду: три операційні стають
 * авто з розділом, «Загальновиробничі» → «Загальні витрати», зʼявляється рівно один «ЗП + Податки на ЗП», «Валютна
 * дебіторка» — з 1С; повторний прогін схеми нічого не міняє: свідомо повернутий у ручний рядок і видалений «ЗП» не відроджуються. Синк 362 — окремо
 * від 361: його збій не зупиняє гривневу дебіторку. 🧨 Червоніє, якщо крок повторюється, дублює «ЗП» або збій 362
 * валить синк 361.
 */
test("#995 ЖИВИЙ SQL: разовий крок 2в — авто-операційні, «Загальні», один «ЗП», валютна з 1С; синк 362 ізольований", async (t) => {
  const sync = SRC("jobs/syncReceivables.ts");
  const body = sync.slice(sync.indexOf("export async function syncReceivables(): Promise<void> {"));
  assert.match(body.split("\n")[1], /await syncReceivablesFx\(\)\.catch\(/, "🔴 збій 362 може зупинити синк 361 (або 362 не синкається)");
  assert.match(sync, /INSERT INTO receivables_fx_totals \(rows, total_uah, total_val, zero_uah[,)]/, "🔴 синк 362 не пише журнал підсумків");

  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    await c.query(`DELETE FROM fin_kpi_imports WHERE key = 'opex-fx-2026-10-05'`);
    const sec = (await c.query(`INSERT INTO fin_kpi_sections (name) VALUES ('Операційні витрати') RETURNING id`)).rows[0].id;
    const rest = (await c.query(`INSERT INTO fin_kpi_sections (name) VALUES ('Залишки на дату') RETURNING id`)).rows[0].id;
    for (const [n, i] of [["Разом", 0], ["Комерційні витрати", 1], ["Загальновиробничі витрати", 2], ["Адміністративні витрати", 3]] as const)
      await c.query(`INSERT INTO fin_kpis (section_id, name, kind, sort) VALUES ($1, $2, $3, $4)`, [sec, n, n === "Разом" ? "sum" : "manual", i]);
    await c.query(`INSERT INTO fin_kpis (section_id, name, kind) VALUES ($1, 'Валютна дебіторка', 'manual')`, [rest]);
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await c.query(schema);
    const rows = async () => (await c.query(`SELECT name, kind, ref_source FROM fin_kpis WHERE deleted_at IS NULL ORDER BY section_id, sort, id`)).rows.map((x) => `${x.name}|${x.kind}|${x.ref_source ?? ""}`);
    const once = await rows();
    assert.deepEqual(once, ["Разом|sum|", "Комерційні витрати|auto|opex_commercial", "Загальні витрати|auto|opex_general", "Адміністративні витрати|auto|opex_admin",
      "ЗП + Податки на ЗП|auto|opex_payroll", "Валютна дебіторка|auto|receivables_fx"], "🔴 разовий крок 2в зробив не те");
    // Свідомі правки після кроку: «Комерційні» знову ручні, «ЗП» видалено. Повторний прогін схеми не має їх відродити.
    await c.query(`UPDATE fin_kpis SET kind = 'manual', ref_source = NULL WHERE name = 'Комерційні витрати'`);
    await c.query(`UPDATE fin_kpis SET deleted_at = now() WHERE name = 'ЗП + Податки на ЗП'`);
    const edited = await rows();
    await c.query(schema);
    assert.deepEqual(await rows(), edited, "🔴 повторний прогін схеми повторив крок — свідомі правки відкочено або «ЗП» відроджено");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM fin_kpis WHERE name = 'ЗП + Податки на ЗП'`)).rows[0].n, 1, "🔴 «ЗП» продубльовано");
  } finally { await s.dispose(); }
});

/**
 * #996 — ФРОНТ РОЗДІЛІВ: вибір — рівно чотири розділи сервера (ключі й назви збігаються з `ITEM_SECTIONS`) і «без
 * розділу»; «всім у групі» і «Повернути» йдуть одним викликом зі списком; безрозділові статті видно числом і на
 * «Статтях», і в «Тиждень і місяць». 🧨 Червоніє, якщо фронт і сервер розійдуться в розділах, «Повернути» загубиться
 * чи попередження про статті без розділу зникне.
 */
test("#996 ФРОНТ РОЗДІЛІВ: чотири розділи як на сервері, «всім у групі» з «Повернути», безрозділові видно", async () => {
  const { ITEM_SECTIONS } = await import("./finance.js");
  const api = FE("api.ts");
  const fe = api.slice(api.indexOf("export const FIN_SECTIONS"), api.indexOf("};", api.indexOf("export const FIN_SECTIONS")) + 2);
  const parsed = Object.fromEntries([...fe.matchAll(/(\w+): "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(parsed, { ...ITEM_SECTIONS }, "🔴 розділи фронту розійшлися з сервером");
  const sec = FE("pages/dashboard/sections/FinanceSection.tsx");
  assert.match(sec, /setFinItemSections\(r\.previous\)/, "🔴 немає «Повернути» для розділу");
  assert.match(sec, /g\.items\.map\(\(i\) => \(\{ id: i\.id, section: v \}\)\)/, "🔴 немає «всім у групі»");
  assert.match(sec, /Без розділу: <b>\{loose\.length\}<\/b>/, "🔴 на «Статтях» не видно статей без розділу");
  assert.match(FE("pages/dashboard/sections/FinanceWeekTab.tsx"), /data\.opexUnassigned && data\.opexUnassigned\.items > 0/, "🔴 «Тиждень і місяць» мовчить про статті без розділу");
});

/** Рахунки «Виписки» для гейтів проходу 2г: банк ЮТС (iban), картка «лише фінанси», Сейф. */
async function bankFixture(c: import("pg").Client) {
  const ins = async (company: string, bank: string, label: string, financeOnly: boolean, iban: string | null = null) =>
    (await c.query(`INSERT INTO bank_accounts (company, bank, label, currency, finance_only, iban) VALUES ($1, $2, $3, 'UAH', $4, $5) RETURNING id`,
      [company, bank, label, financeOnly, iban])).rows[0].id as number;
  const uts = await ins("uts", "privat", "ТОВ ЮТС · тест", false, "UA000000000000000000000000001");
  const am = await ins("automuv", "privat", "ТОВ Автомув · тест", false, "UA000000000000000000000000002");
  const card = await ins("fop_mono", "mono", "Картка black · тест", true);
  const safe = (await c.query(`SELECT id FROM bank_accounts WHERE bank = 'manual' AND label = 'Сейф'`)).rows[0]?.id
    ?? await ins("uts", "manual", "Сейф", true);
  let n = 0;
  const tx = (acc: number, amount: number, at: string, x: { iban?: string; fee?: boolean; name?: string } = {}) =>
    c.query(`INSERT INTO bank_transactions (account_id, direction, external_tx_id, booked_at, counterparty_name, counterparty_iban, amount, currency, fx_rate, amount_uah, is_bank_fee)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'UAH', 1, $7, $8)`, [acc, amount >= 0 ? "in" : "out", `t:${++n}`, at, x.name ?? "Контрагент", x.iban ?? null, amount, x.fee ?? false]);
  return { uts, am, card, safe, tx };
}

/**
 * #997 — ЖИВИЙ SQL: СЕЙФ — РУЧНИЙ РАХУНОК (`core/bankManual.ts`). Тиждень — АБО операції, АБО один підсумок (інакше
 * тиждень порахувався б двічі), межа — Пн–Нд за Києвом, по обидва боки; у банківський рахунок руками не пишемо;
 * видалення → «Повернути» повертає той самий рядок, і повернення знову перевіряє правило.
 * 🧨 Червоніє, якщо дозволити підсумок поверх операцій (чи навпаки), другий підсумок тижня або запис у банк.
 */
test("#997 ЖИВИЙ SQL: Сейф — тиждень або операції, або один підсумок; банк руками не пишеться; «Повернути»", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const bm = await import("./bankManual.js");
  const { db, c } = s;
  try {
    const { uts, safe } = await bankFixture(c);
    const err = (re: RegExp) => (e: unknown) => status(e) === 409 && re.test((e as Error).message);
    await assert.rejects(bm.addManual(db, 901, { accountId: uts, kind: "op", date: "2026-10-06", direction: "in", amount: "1" }), (e: unknown) => status(e) === 400,
      "🔴 у банківський рахунок записано руками");
    const op = await bm.addManual(db, 901, { accountId: safe, kind: "op", date: "2026-10-11", direction: "out", amount: "1 500,50", purpose: "Пальне" }); // нд — тиждень 05.10
    assert.equal(op.monday, "2026-10-05");
    await assert.rejects(bm.addManual(db, 901, { accountId: safe, kind: "week", date: "2026-10-07", inAmount: "1000" }), err(/уже є операції/),
      "🔴 підсумок тижня поверх операцій — тиждень порахується двічі");
    const wk = await bm.addManual(db, 901, { accountId: safe, kind: "week", date: "2026-10-12", inAmount: "1000", outAmount: "400" }); // пн — наступний тиждень
    assert.equal(wk.ids.length, 2, "🔴 підсумок тижня не дав двох рядків (прийшло / пішло)");
    await assert.rejects(bm.addManual(db, 901, { accountId: safe, kind: "op", date: "2026-10-18", direction: "in", amount: "5" }), err(/уже внесено підсумок/),
      "🔴 операція поверх підсумку тижня");
    await assert.rejects(bm.addManual(db, 901, { accountId: safe, kind: "week", date: "2026-10-14", outAmount: "1" }), err(/уже є/), "🔴 другий підсумок того самого тижня");
    await assert.rejects(bm.addManual(db, 901, { accountId: safe, kind: "op", date: "2026-10-06", direction: "in", amount: "-5" }), (e: unknown) => status(e) === 400);

    const before = (await c.query(`SELECT id, amount::text, booked_at FROM bank_transactions WHERE id = $1`, [op.ids[0]])).rows[0];
    await bm.setManualDeleted(db, 901, op.ids[0], true);
    // тиждень 05.10 тепер порожній — підсумок можна; тоді повернення операції мусить відмовити
    const wk2 = await bm.addManual(db, 901, { accountId: safe, kind: "week", date: "2026-10-05", inAmount: "1" });
    await assert.rejects(bm.setManualDeleted(db, 901, op.ids[0], false), err(/уже внесено підсумок/), "🔴 «Повернути» обійшло правило тижня");
    await bm.setManualDeleted(db, 901, wk2.ids[0], true);
    await bm.setManualDeleted(db, 901, op.ids[0], false);
    assert.deepEqual((await c.query(`SELECT id, amount::text, booked_at FROM bank_transactions WHERE id = $1 AND deleted_at IS NULL`, [op.ids[0]])).rows[0], before,
      "🔴 «Повернути» повернуло не той рядок");
    assert.equal((await bm.listManual(db, safe, "2026-10-01", "2026-10-31")).rows.filter((r: any) => !r.deleted).length, 3);
  } finally { await s.dispose(); }
});

/**
 * #998 — «ЛИШЕ ФІНАНСИ»: особисті картки власника ФОП і Сейф (`finance_only`) — стрічка «Виписки» відкрита ВСІМ
 * ролям, тож без права їх рядків немає (і з правом — є: дзеркало); видалених ручних записів немає ні для кого; в
 * зіставлення оплат з рахунками вони не йдуть; AI їх не бачить (сира таблиця відібрана, вью — без них); реквізити й
 * CSV-виписка їх не віддають. 🧨 Червоніє, якщо менеджер побачить картку, AI — сиру таблицю чи готівка закриє рахунок.
 */
test("#998 ЛИШЕ ФІНАНСИ: картки й Сейф — лише з правом, не в зіставленні оплат, не в AI, не в реквізитах", async (t) => {
  const route = SRC("routes/bank.ts");
  for (const r of ["incoming", "outgoing"]) {
    const body = route.slice(route.indexOf(`bankRouter.get("/${r}"`), route.indexOf("});", route.indexOf(`bankRouter.get("/${r}"`)));
    assert.match(body, /canSeePrivate: roleHasPerm\(req\.auth!\.roleKey, "view_cashflow"\)/, `🔴 /${r}: право на картки не з view_cashflow`);
  }
  assert.match(route, /FROM bank_accounts WHERE is_active = true AND NOT finance_only ORDER BY id, currency/, "🔴 реквізити віддають картки / Сейф");
  assert.match(route, /statementData\(account, from, to, await getHiddenPayees\(\), canSeeHidden, roleHasPerm\(req\.auth!\.roleKey, "view_cashflow"\)\)/,
    "🔴 CSV-виписка картки — без перевірки права");
  const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
  const rev = schema.lastIndexOf("REVOKE ALL ON bank_transactions FROM ai_readonly;");
  assert.ok(rev > schema.lastIndexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;"), "🔴 AI бачить сиру таблицю банку (REVOKE вище за GRANT)");
  const view = schema.slice(schema.indexOf("CREATE OR REPLACE VIEW ai_bank_transactions"), schema.indexOf(";", schema.indexOf("CREATE OR REPLACE VIEW ai_bank_transactions")));
  assert.match(view, /WHERE NOT a\.finance_only AND t\.deleted_at IS NULL/, "🔴 вью для AI віддає картки / Сейф");

  const s = await scratchDb(t);
  if (!s) return;
  process.env.DATABASE_URL ??= s.url; process.env.JWT_SECRET ??= "test"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
  const { c } = s;
  try {
    const { uts, card, safe, tx } = await bankFixture(c);
    await tx(uts, 1000, "2026-10-06T10:00:00Z"); await tx(card, 70, "2026-10-06T11:00:00Z"); await tx(safe, 500, "2026-10-06T12:00:00Z");
    await tx(safe, 999, "2026-10-06T13:00:00Z");
    await c.query(`UPDATE bank_transactions SET deleted_at = now(), manual_kind = 'op' WHERE amount = 999`);
    const pm = await import("./paymentMatch.js");
    const paid = (await c.query(pm.invoicePaymentsSql(1), [3650])).rows.map((r: any) => Number(r.amount)).sort((a: number, b: number) => a - b);
    assert.deepEqual(paid, [1000], "🔴 картка / Сейф / видалений запис потрапили в зіставлення оплат з рахунками");
    // та сама умова стрічки, що в `bankReport.whereClause` — над scratch-базою (модуль бере пул прода, тож — текстом)
    const report = SRC("core/bankReport.ts");
    assert.match(report, /const c = \[`t\.direction = '\$\{dir\}'`, `a\.is_active = true`, `t\.deleted_at IS NULL`\];\s*if \(!f\.canSeePrivate\) c\.push\(`NOT a\.finance_only`\);/,
      "🔴 стрічка «Виписки» не ховає картки / видалене");
    const feed = async (priv: boolean) => (await c.query(`SELECT t.amount::int AS a FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
      WHERE t.direction = 'in' AND a.is_active = true AND t.deleted_at IS NULL ${priv ? "" : "AND NOT a.finance_only"} ORDER BY 1`)).rows.map((r: any) => r.a);
    assert.deepEqual([await feed(false), await feed(true)], [[1000], [70, 500, 1000]], "🔴 право на картки не розрізняє ролі");
  } finally { await s.dispose(); }
});

/**
 * #1200 — КАРТКИ МОНО (`pickAccount`): рядок без `mono_type` — ФОП, як було (без нього пропала б ФОП-виписка); з
 * типом — саме ця картка; банки-jars і чужі типи — ніколи; синк банку не чіпає ручний рахунок. По обидва боки.
 * 🧨 Червоніє, якщо картку взяти замість ФОП, або навпаки, або синк піде у Сейф.
 */
test("#1200 КАРТКИ МОНО: без типу — ФОП, з типом — рівно ця картка; Сейф синк не чіпає", async () => {
  process.env.DATABASE_URL ??= "postgres://x@localhost/x"; process.env.JWT_SECRET ??= "test"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
  const { pickAccount } = await import("../bankSources/mono.js");
  const info = { accounts: [{ id: "b", type: "black", currencyCode: 980 }, { id: "f", type: "fop", currencyCode: 980 }, { id: "w", type: "white", currencyCode: 980 },
    { id: "fu", type: "fop", currencyCode: 840 }], jars: [{ id: "j" }] };
  assert.equal(pickAccount(info, "UAH")?.id, "f", "🔴 рядок ФОП узяв картку");
  assert.equal(pickAccount(info, "USD")?.id, "fu", "🔴 валютний ФОП узяв гривневий");
  assert.equal(pickAccount(info, "UAH", "black")?.id, "b", "🔴 картка black не знайдена");
  assert.equal(pickAccount(info, "UAH", "white")?.id, "w");
  assert.equal(pickAccount(info, "UAH", "platinum"), null, "🔴 неіснуючий тип підмінено іншим рахунком");
  assert.match(SRC("jobs/syncBank.ts"), /FROM bank_accounts WHERE is_active = true AND bank <> 'manual'/, "🔴 синк банку пішов у ручний рахунок");
  assert.match(SRC("bankSources/mono.ts"), /const res = await paced\(token, \(\) => fetch\(`\$\{BASE\}\/personal\/statement/, "🔴 виписка моно без паузи токена — під одним токеном кілька рахунків");
});

/**
 * #1221 — ЖИВИЙ SQL: «НАДХОДЖЕННЯ / ВИТРАТИ ЗАГАЛЬНІ» З «ВИПИСКИ» (`bankTotals`), рішення Романа 07.10.2026 «усі, без
 * виключення» + «комісії теж включай». Усі активні рахунки разом із картками й Сейфом, без видалених записів; витрати —
 * РАЗОМ із комісіями банку; дати — за Києвом, обидва кінці; перекази між нашими рахунками входять у суму, а окремим
 * числом — лише довідкою. Рядок «Гроші» — авто й тиждень, і місяць; вночі НЕ фіксується, фіксує закриття.
 * 🧨 Червоніє, якщо загубити Сейф, знову відкинути комісію, вирахувати свої перекази, зрізати день на межі чи
 * зафіксувати тиждень уночі.
 */
test("#1221 ЖИВИЙ SQL: надходження / витрати загальні — уся «Виписка» з комісіями за Києвом, свої перекази в сумі й довідкою, фіксує лише закриття", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const { uts, am, card, safe, tx } = await bankFixture(c);
    await tx(uts, 1000, "2026-10-04T21:30:00Z");                                   // пн 05.10 00:30 Київ — у тижні
    await tx(am, 200, "2026-10-11T20:30:00Z", { iban: "UA000000000000000000000000001" }); // нд 23:30 Київ, переказ від ЮТС — свій
    await tx(card, -70, "2026-10-08T10:00:00Z"); await tx(safe, -30, "2026-10-08T10:00:00Z");
    await tx(uts, -5, "2026-10-08T10:00:00Z", { fee: true });                       // комісія — теж витрата (07.10.2026)
    await tx(uts, -200, "2026-10-08T10:00:00Z", { iban: "UA000000000000000000000000002" }); // переказ на Автомув — свій
    await tx(uts, 777, "2026-10-04T20:30:00Z");                                    // нд 04.10 23:30 Київ — минулий тиждень
    await tx(safe, 9999, "2026-10-06T10:00:00Z");
    await c.query(`UPDATE bank_transactions SET deleted_at = now(), manual_kind = 'op' WHERE amount = 9999`);
    const b = await k.bankTotals(db, "2026-10-05", "2026-10-11");
    assert.deepEqual(b, { in: 1200, out: 305, ownIn: 200, ownOut: 200, rows: 6 }, "🔴 надходження / витрати з «Виписки» пораховано хибно (комісія чи свій переказ випали)");

    const sec = await k.createSection(db, 901, { name: "Гроші" });
    const inc = await k.createKpi(db, 901, { sectionId: sec, name: "Надходження загальні" });
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'bank_in' WHERE id = $1`, [inc]);
    const refs = { bank_in: b.in, bank_out: b.out };
    const row = async (kind: "week" | "month", p: string) => (await k.loadPeriod(db, kind, p, refs, new Date("2026-10-14T10:00:00Z"))).sections[0].kpis[0];
    assert.deepEqual([(await row("week", "2026-10-05")).kind, (await row("month", "2026-10-01")).kind], ["auto", "auto"], "🔴 «Гроші» не рахуються з «Виписки»");
    assert.equal((await row("week", "2026-09-28")).kind, "manual", "🔴 тиждень до старту порахувався з «Виписки»");
    assert.equal((await k.freezeAutoKpis(db, "week", "2026-10-05", refs)).frozen, 0, "🔴 тиждень зафіксовано вночі — Сейф ще не внесено");
    await k.setPeriodClosed(db, 901, "week", "2026-10-05", true, refs);
    assert.deepEqual([(await row("week", "2026-10-05")).value, (await row("week", "2026-10-05")).autoState], [1200, "frozen"], "🔴 закриття не зафіксувало");
  } finally { await s.dispose(); }
});

/**
 * #1222 — КАРТКА ПРАЦІВНИКА ЗА ЦИФРАМИ (`accountFor` / `pickAccount`, картка Олександра 07.10.2026). Останні 4 цифри
 * обирають рівно ту картку, навіть коли під токеном дві одного типу; картка працівника (`staff`) без цифр — НЕ
 * привʼязується (вгадувати під чужим токеном не можна); ФОП-рядок без цифр — як був. `normLast4` — рівно 4 цифри.
 * 🧨 Червоніє, якщо цифри ігнорувати (взяти першу black), привʼязати картку працівника без цифр або пустити «12345».
 */
test("#1222 КАРТКА ЗА ЦИФРАМИ: дві black — береться та, що з цифрами; працівник без цифр — не привʼязується; ФОП як був", async () => {
  const m = await import("../bankSources/mono.js");
  const info = { accounts: [
    { id: "f", type: "fop", currencyCode: 980, maskedPan: ["537541******0001"] },
    { id: "b1", type: "black", currencyCode: 980, maskedPan: ["537541******1111"] },
    { id: "b2", type: "black", currencyCode: 980, maskedPan: ["444111******2222"] },
    { id: "w", type: "white", currencyCode: 980, maskedPan: ["537541******3333"] },
  ] };
  const row = (x: Record<string, unknown>) => ({ id: 1, bank: "mono" as const, label: "т", currency: "UAH", external_account_id: null, iban: null, env_key_name: "T", company: "fop_mono", ...x });
  assert.equal(m.accountFor(info, row({ company: "staff", mono_pan_last4: "2222" }))?.id, "b2", "🔴 цифри проігноровано — узято першу black");
  assert.equal(m.accountFor(info, row({ company: "staff", mono_pan_last4: null })), null, "🔴 картку працівника привʼязано без цифр");
  assert.equal(m.accountFor(info, row({ company: "staff", mono_pan_last4: "9999" })), null, "🔴 неіснуючі цифри підмінено іншою карткою");
  assert.equal(m.accountFor(info, row({ company: "fop_mono" }))?.id, "f", "🔴 ФОП-рядок без цифр більше не бере ФОП");
  assert.equal(m.accountFor(info, row({ company: "fop_mono", mono_type: "black" }))?.id, "b1", "🔴 вибір за типом зламано");
  assert.deepEqual(["1234", " 1234 ", "12345", "**** 1234", "", null, "12a4"].map(m.normLast4), ["1234", "1234", null, null, null, null, null],
    "🔴 «останні 4 цифри» пускають не 4 цифри");
});

/**
 * #1223 — ЖИВИЙ SQL: КАРТКИ У СХЕМІ. База пускає «картку працівника» (`staff`) і рівно 4 цифри (не «12a4»); самих карток
 * схема НЕ створює (їх додає людина кнопкою, #1224); вимкнена картка у «Надходження / Витрати» не йде, увімкнена — йде.
 * 🧨 Червоніє, якщо схема знову зашиє картку, база пустить не цифри або вимкнена картка потрапить у суми.
 */
test("#1223 ЖИВИЙ SQL: картки — схема пускає staff і рівно 4 цифри, сама карток не створює; вимкнена — не в сумах", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM bank_accounts WHERE company = 'staff'`)).rows[0].n, 0, "🔴 схема сама створила картку");
    const id = (await c.query(`INSERT INTO bank_accounts (company, bank, label, currency, env_key_name, finance_only, is_active, mono_pan_last4)
      VALUES ('staff', 'mono', 'Картка · тест', 'UAH', 'MONO_TOKEN_T', true, false, '1234') RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO bank_transactions (account_id, direction, external_tx_id, booked_at, counterparty_name, amount, currency, fx_rate, amount_uah)
      VALUES ($1, 'out', 'card:1', '2026-10-08T10:00:00Z', 'АЗС', -400, 'UAH', 1, -400)`, [id]);
    assert.equal((await k.bankTotals(db, "2026-10-05", "2026-10-11")).out, 0, "🔴 вимкнена картка потрапила у «Витрати загальні»");
    await c.query(`UPDATE bank_accounts SET is_active = true WHERE id = $1`, [id]);
    assert.equal((await k.bankTotals(db, "2026-10-05", "2026-10-11")).out, 400, "🔴 увімкнена картка не потрапила у «Витрати загальні»");
    await assert.rejects(c.query(`UPDATE bank_accounts SET mono_pan_last4 = '12a4' WHERE id = $1`, [id]), "🔴 база пустила не цифри");
    await assert.rejects(c.query(`UPDATE bank_accounts SET company = 'nobody' WHERE id = $1`, [id]), "🔴 база пустила невідому компанію");
  } finally { await s.dispose(); }
});

/**
 * #1223b — ПРОВОДКА КАРТКИ: цифри пише лише роут керування рахунками (рівно 4 цифри, зміна скидає привʼязку); синк читає
 * цифри і дописує IBAN лише в порожнє поле; адаптер моно обирає рахунок через `accountFor` скрізь (привʼязка, баланс);
 * панель показує поле цифр для моно; «Витрати загальні» на екрані підписані «включно з комісіями».
 * 🧨 Червоніє, якщо синк не передає цифри, IBAN перетирає правку адміна, баланс бере рахунок повз цифри чи підказка бреше.
 */
test("#1223b ПРОВОДКА КАРТКИ: роут, синк, адаптер і панель — цифри скрізь, IBAN лише в порожнє, підказка з комісіями", () => {
  const route = SRC("routes/bank.ts"), sync = SRC("jobs/syncBank.ts"), mono = SRC("bankSources/mono.ts");
  assert.match(route, /const last4 = normLast4\(raw\);\n\s+if \(raw && !last4\) return res\.status\(400\)/, "🔴 роут пускає не 4 цифри");
  assert.match(route, /external_account_id = CASE WHEN mono_pan_last4 IS DISTINCT FROM/, "🔴 зміна цифр не скидає привʼязку — синк тягне стару картку");
  assert.match(sync, /env_key_name, mono_type, mono_pan_last4\n/, "🔴 синк не читає цифри картки");
  assert.match(sync, /UPDATE bank_accounts SET iban=\$1 WHERE id=\$2 AND iban IS NULL/, "🔴 IBAN перетирає правку адміна");
  assert.equal((mono.match(/accountFor\(await fetchClientInfo\(token\), account\)/g) ?? []).length, 3, "🔴 привʼязка, IBAN і баланс обирають рахунок не через accountFor");
  assert.doesNotMatch(mono, /pickAccount\(await fetchClientInfo/, "🔴 десь лишився вибір рахунку повз цифри");
  const fe = FE("pages/dashboard/sections/BankSection.tsx");
  assert.match(fe, /\{a\.bank === "mono" && <label style=\{\{ fontSize: 12 \}\}>Останні 4 цифри картки \(моно\)/, "🔴 у панелі немає поля цифр картки");
  assert.match(FE("pages/dashboard/sections/FinanceWeekTab.tsx"), /bank_out: "«Виписка»: усі рахунки разом із картками й Сейфом, включно з банківськими комісіями/, "🔴 підказка «Витрат загальних» каже не те, що рахує ядро");
});

/**
 * #1224 — ПОЛЯ РАХУНКУ, ЯКІ ПИШЕ ЛЮДИНА (`core/bankAccounts.ts`, «+ Картка» без програміста). Назва змінної ключа —
 * лише шаблон СВОГО банку: `JWT_SECRET`, `KOMMO_API_TOKEN`, `PRIVAT_TOKEN_X` для моно — відмова (інакше сервер сам
 * відправив би чужий секрет у банк); картка працівника — лише моно і лише з 4 цифрами; новий рахунок — ЗАВЖДИ вимкнений;
 * «лише фінанси» для картки працівника — за замовчуванням так. По обидва боки межі.
 * 🧨 Червоніє, якщо пустити чужу назву, картку без цифр чи створити рахунок увімкненим.
 */
test("#1224 ПОЛЯ РАХУНКУ: ключ лише свого банку, картка працівника — моно з 4 цифрами, новий рахунок вимкнений", async () => {
  const v = await import("./bankAccounts.js");
  const bad = (f: () => unknown, why: string) => assert.throws(f, (e: unknown) => (e as { status?: number }).status === 400, why);
  const card = { company: "staff", bank: "mono", label: "Картка Олександра", currency: "UAH", envKeyName: "MONO_TOKEN_SASHA", monoPanLast4: "1234" };
  assert.deepEqual(v.validateNewAccount(card), { company: "staff", bank: "mono", label: "Картка Олександра", currency: "UAH", envKeyName: "MONO_TOKEN_SASHA",
    monoPanLast4: "1234", financeOnly: true, isActive: false }, "🔴 правильну картку не прийнято або створено увімкненою / видимою всім");
  for (const name of ["JWT_SECRET", "KOMMO_API_TOKEN", "DATABASE_URL", "PRIVAT_TOKEN_UTS", "mono_token_x", "MONO_TOKEN_", "MONO_TOKEN_A-B"])
    bad(() => v.validateNewAccount({ ...card, envKeyName: name }), `🔴 «${name}» прийнято як ключ monobank — сервер відправив би його в банк`);
  bad(() => v.checkEnvKeyName("privat", "MONO_TOKEN_FOP"), "🔴 ключ моно прийнято для Привату");
  bad(() => v.checkEnvKeyName("manual", "MONO_TOKEN_X"), "🔴 ключ дописано рахунку без банку");
  assert.equal(v.checkEnvKeyName("privat", "PRIVAT_TOKEN_UTS"), "PRIVAT_TOKEN_UTS", "🔴 наявну назву Привату відкинуто — зламало б редагування");
  assert.equal(v.checkEnvKeyName("mono", "  "), null, "🔴 порожня назва — не «без ключа»");
  bad(() => v.validateNewAccount({ ...card, monoPanLast4: "" }), "🔴 картку працівника прийнято без цифр");
  bad(() => v.validateNewAccount({ ...card, monoPanLast4: "12345" }), "🔴 прийнято не 4 цифри");
  bad(() => v.validateNewAccount({ ...card, bank: "privat", envKeyName: "PRIVAT_TOKEN_X" }), "🔴 картку працівника прийнято в Приват (API для фізосіб немає)");
  bad(() => v.validateNewAccount({ ...card, company: "nobody" }), "🔴 прийнято невідому компанію");
  bad(() => v.validateNewAccount({ ...card, currency: "PLN" }), "🔴 прийнято невідому валюту");
  assert.equal(v.validateNewAccount({ ...card, isActive: true }).isActive, false, "🔴 рахунок створено увімкненим на прохання клієнта");
  assert.equal(v.validateNewAccount({ ...card, company: "fop_mono", monoPanLast4: "" }).financeOnly, false, "🔴 рахунок компанії сховано від усіх без прохання");
});

/**
 * #1225 — ТОКЕН БЕЗ РЕСТАРТУ І ЛИШЕ БАНКІВСЬКИЙ (`bankSources/token.ts`). Дописаний у .env `MONO_TOKEN_…` видно одразу,
 * заміна в файлі діє без перезапуску; `JWT_SECRET` / `KOMMO_API_TOKEN` з того ж файлу й навіть з `process.env` —
 * НЕ ключ банку; `PRIVAT_TOKEN_…_ID` (merchant id Привату) — ключ. 🧨 Червоніє, якщо читати весь .env або кешувати назавжди.
 */
test("#1225 ТОКЕН: .env перечитується без рестарту, з нього береться лише MONO_/PRIVAT_TOKEN_", async () => {
  const { tokenFor } = await import("../bankSources/token.js");
  const { mkdtempSync, writeFileSync, utimesSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "uts-env-"));
  const f = path.join(dir, ".env");
  try {
    writeFileSync(f, "JWT_SECRET=секрет\nKOMMO_API_TOKEN=kommo\nPRIVAT_TOKEN_UTS_ID=42\n");
    assert.equal(tokenFor("MONO_TOKEN_T1225", f), undefined, "🔴 ключ знайдено там, де його немає");
    writeFileSync(f, "JWT_SECRET=секрет\nKOMMO_API_TOKEN=kommo\nPRIVAT_TOKEN_UTS_ID=42\nMONO_TOKEN_T1225=перший\n");
    utimesSync(f, new Date(), new Date(Date.now() + 5_000));
    assert.equal(tokenFor("MONO_TOKEN_T1225", f), "перший", "🔴 дописаний у .env токен не видно без рестарту");
    writeFileSync(f, "MONO_TOKEN_T1225=другий\n");
    utimesSync(f, new Date(), new Date(Date.now() + 10_000));
    assert.equal(tokenFor("MONO_TOKEN_T1225", f), "другий", "🔴 заміну токена в .env не видно без рестарту");
    assert.equal(tokenFor("PRIVAT_TOKEN_UTS_ID", path.join(dir, "немає")), process.env.PRIVAT_TOKEN_UTS_ID, "🔴 без файлу не впали на process.env");
    writeFileSync(f, "JWT_SECRET=секрет\nKOMMO_API_TOKEN=kommo\nPRIVAT_TOKEN_UTS_ID=42\n");
    utimesSync(f, new Date(), new Date(Date.now() + 15_000));
    assert.equal(tokenFor("PRIVAT_TOKEN_UTS_ID", f), "42", "🔴 merchant id Привату не прочитано");
    for (const name of ["JWT_SECRET", "KOMMO_API_TOKEN"]) assert.equal(tokenFor(name, f), undefined, `🔴 «${name}» віддано як ключ банку`);
    const prev = process.env.JWT_SECRET; process.env.JWT_SECRET = prev ?? "x";
    assert.equal(tokenFor("JWT_SECRET", f), undefined, "🔴 JWT_SECRET із process.env віддано як ключ банку");
    if (prev === undefined) delete process.env.JWT_SECRET;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * #1226 — КЛЮЧ БАНКУ ЧИТАЄТЬСЯ ЛИШЕ ЧЕРЕЗ `tokenFor`. Перелік від ПРЕДМЕТА (правило 12): усі файли `backend/src`, де ключ
 * береться за `env_key_name`, — жоден не звертається до `process.env[…env_key_name…]` напряму; адаптери, синк і роут
 * кличуть `tokenFor`. 🧨 Червоніє, якщо будь-де повернути прямий `process.env[account.env_key_name]` — обхід білого списку.
 */
test("#1226 КЛЮЧ БАНКУ: жодного прямого process.env[…env_key_name…] у коді; адаптери, синк і роут — через tokenFor", async () => {
  const { readdirSync, statSync: st } = await import("node:fs");
  const root = path.join(import.meta.dirname, "..", "..", "src");
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (st(p).isDirectory()) walk(p); else if (n.endsWith(".ts") && !n.endsWith(".test.ts")) files.push(p); } };
  walk(root);
  assert.ok(files.length > 100, `🔴 обхід знайшов лише ${files.length} файлів — гейту нічого перевіряти`);
  const direct = files.filter((f) => /process\.env\[\s*[`$\{\w.]*env_key_name/.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  assert.deepEqual(direct, [], "🔴 ключ банку читається повз tokenFor (білий список обійдено)");
  for (const f of ["bankSources/mono.ts", "bankSources/privat.ts", "jobs/syncBank.ts", "routes/bank.ts", "tools/rekeyPrivat.ts"])
    assert.match(SRC(f), /tokenFor\((account|acc|a)\.env_key_name\)/, `🔴 ${f} не бере ключ через tokenFor`);
});

/**
 * #1227 — «+ КАРТКА» У ПАНЕЛІ. Форма живе в блоці керування рахунками (його бачить лише `manage_bank_accounts`), шле
 * моно + назву змінної + 4 цифри + «лише фінанси»; у картці рахунку без ключа — пояснення «рядок у .env, рестарт не
 * потрібен». 🧨 Червоніє, якщо форму винести з блоку керування, перестати слати цифри чи прибрати пояснення.
 */
test("#1227 «+ КАРТКА»: форма лише в керуванні рахунками, шле моно з цифрами й змінною; без ключа — пояснення", () => {
  const fe = FE("pages/dashboard/sections/BankSection.tsx");
  const block = fe.slice(fe.indexOf("function AccountsBlock("), fe.indexOf("function HiddenBlock("));
  assert.ok(block.length > 0, "🔴 блок керування рахунками не знайдено");
  assert.match(block, /<AddCardForm onAdded=/, "🔴 «+ Картка» не в блоці керування рахунками");
  assert.equal((fe.match(/<AddCardForm /g) ?? []).length, 1, "🔴 «+ Картка» рендериться ще десь — поза правом керування");
  assert.match(fe, /\{canAccounts && <AccountsBlock /, "🔴 блок керування рахунками не за правом");
  assert.match(fe, /saveBankAccount\(null, \{ company: f\.company, bank: "mono", label: f\.label, currency: f\.currency, envKeyName: f\.env, monoPanLast4: f\.last4, financeOnly: f\.financeOnly \}/,
    "🔴 форма не шле моно, змінну, цифри чи «лише фінанси»");
  assert.match(block, /у серверному \.env ще немає — додайте рядок/, "🔴 картка без ключа мовчить, що робити");
});

/**
 * #1202 — ВАЛЮТА ВАЛЮТНОЇ ДЕБІТОРКИ ЗА КУРСОМ (`fxByRate`): 1С валюти не віддає, тож вона ВИВОДИТЬСЯ з курсу рядка —
 * найближчий курс НБУ при відхиленні ≤ 10%; без курсу чи з далеким — «не визначено», окремим числом, а не в USD.
 * Числа — заміряні 05.10.2026 рядки 42,39 / 49,86 / 51,77. 🧨 Червоніє, якщо далекий курс віднести до найближчої
 * валюти, рядок без гривні — до USD, або загубити невизначене.
 */
test("#1202 ВАЛЮТА ЗА КУРСОМ: 42→USD, 50→EUR, далекий чи без курсу — «не визначено» окремо", async () => {
  const rc = await import("./receivables1c.js");
  const nbu = { USD: 41.2, EUR: 48.1 };
  assert.equal(rc.fxByRate(4239, 100, nbu), "USD");
  assert.equal(rc.fxByRate(4986, 100, nbu), "EUR");
  assert.equal(rc.fxByRate(5177, 100, nbu), "EUR");
  assert.equal(rc.fxByRate(6000, 100, nbu), null, "🔴 далекий курс віднесено до найближчої валюти");
  assert.equal(rc.fxByRate(0, 15, nbu), null, "🔴 рядок без гривні віднесено до валюти");
  assert.equal(rc.fxByRate(4239, 100, {}), null, "🔴 без курсів НБУ валюту вгадано");
  const rows = rc.parse1cPayload([{ Contractor: "А", DetailInfo: [{ Sum: 4239, SumVal: 100 }, { Sum: 4986, SumVal: 100 }, { Sum: 0, SumVal: 15 }] }]).rows;
  const t = rc.fxTotals(rows, nbu);
  assert.deepEqual([t.usd, t.eur, t.unknownVal, t.totalVal], [100, 100, 15, 215], "🔴 USD / EUR / невизначене не сходяться з сумою у валюті");
});

/**
 * #1203 — РАЗОВИЙ КРОК 2г і ФРОНТ. Схема: Сейф і три картки моно (з токеном рядка ФОП, «лише фінанси») — один раз;
 * видалений чи вимкнений рахунок повторний прогін не відроджує; «Надходження / Витрати загальні» — з «Виписки».
 * Фронт: «Сейф» — лише з `view_cashflow`, запис — лише з `edit_finance`; чип компанії не бере назву картки чи Сейфу.
 * 🧨 Червоніє, якщо крок повторюється, картка не «лише фінанси» або кнопка Сейфу видна всім.
 */
test("#1203 ЖИВИЙ SQL: разовий крок 2г — Сейф і картки один раз, «лише фінанси»; фронт Сейфу — за правами", async (t) => {
  const fe = FE("pages/dashboard/sections/BankSection.tsx");
  assert.match(fe, /\{canViewCashflow && active\.some\(\(a\) => a\.bank === "manual"\) && \(/, "🔴 кнопка «Сейф» не за view_cashflow");
  assert.match(fe, /\{safeOpen && canViewCashflow && <SafeModal accounts=\{active\.filter\(\(a\) => a\.bank === "manual"\)\} canEdit=\{canEditFinance\}/, "🔴 запис у Сейф не за edit_finance");
  assert.match(fe, /if \(a\.finance_only && m\.has\(a\.company\)\) continue;/, "🔴 чип компанії може назватись «Сейф» / «Картка»");

  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    await c.query(`DELETE FROM fin_kpi_imports WHERE key IN ('bank-safe-cards-2026-10-05', 'bank-fm-2026-10-05')`);
    await c.query(`DELETE FROM bank_accounts`);
    await c.query(`INSERT INTO bank_accounts (company, bank, label, currency, env_key_name) VALUES ('fop_mono', 'mono', 'ФОП Моно', 'UAH', 'MONO_TOKEN_FOP')`);
    const sec = (await c.query(`INSERT INTO fin_kpi_sections (name) VALUES ('Гроші') RETURNING id`)).rows[0].id;
    for (const n of ["Надходження загальні", "Витрати загальні"]) await c.query(`INSERT INTO fin_kpis (section_id, name, kind) VALUES ($1, $2, 'manual')`, [sec, n]);
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await c.query(schema);
    const accs = async () => (await c.query(`SELECT label, bank, finance_only, mono_type, env_key_name FROM bank_accounts ORDER BY id`)).rows
      .map((x) => `${x.label}|${x.bank}|${x.finance_only}|${x.mono_type ?? ""}|${x.env_key_name ?? ""}`);
    assert.deepEqual(await accs(), ["ФОП Моно|mono|false||MONO_TOKEN_FOP", "Сейф|manual|true||", "Картка black|mono|true|black|MONO_TOKEN_FOP",
      "Картка white|mono|true|white|MONO_TOKEN_FOP", "Картка «Зроблено в Україні»|mono|true|madeInUkraine|MONO_TOKEN_FOP"], "🔴 разовий крок створив не те");
    assert.deepEqual((await c.query(`SELECT name, kind, ref_source FROM fin_kpis ORDER BY id`)).rows.map((x) => `${x.name}|${x.kind}|${x.ref_source}`),
      ["Надходження загальні|auto|bank_in", "Витрати загальні|auto|bank_out"], "🔴 «Гроші» не переведено на «Виписку»");
    await c.query(`DELETE FROM bank_accounts WHERE label = 'Картка white'`);
    await c.query(`UPDATE bank_accounts SET is_active = false WHERE label = 'Сейф'`);
    await c.query(`UPDATE fin_kpis SET kind = 'manual', ref_source = NULL WHERE name = 'Витрати загальні'`);
    const edited = await accs();
    await c.query(schema);
    assert.deepEqual(await accs(), edited, "🔴 повторний прогін схеми відродив видалений рахунок");
    assert.equal((await c.query(`SELECT kind FROM fin_kpis WHERE name = 'Витрати загальні'`)).rows[0].kind, "manual", "🔴 повторний прогін переписав свідому правку");
  } finally { await s.dispose(); }
});

/**
 * #1207 — ЖИВИЙ SQL: СТОВПЕЦЬ «МИНУЛИЙ» — З ДЖЕРЕЛА. Тижні не фіксуються (#1205), тож минулий незафіксований
 * авто-рядок мусить показувати число джерела за ТОЙ період (`prevRefs`), а не збережене проміжне з таблиці. Спіймано на
 * проді 05.10.2026: «минулий тиждень» 2 973 228 (таблиця) замість 4 821 254 (CRM). По обидва боки: без `prevRefs` —
 * збережене (як було), з ними — джерело; зафіксоване закриттям — завжди зафіксоване. Роут передає `prevRefs`.
 * 🧨 Червоніє, якщо «минулий» знову бере таблицю чи перекриває зафіксоване живим.
 */
test("#1207 ЖИВИЙ SQL: «минулий» — число джерела за той період, зафіксоване — як є, роут передає prevRefs", async (t) => {
  assert.match(SRC("routes/finance.ts"), /const prevRefs = await refsFor\(cur\.kind, shiftPeriod\(cur\.kind, cur\.start, -1\)\);\s*const p = await loadPeriod\(pool as unknown as Db, req\.query\.kind, req\.query\.p, refs, new Date\(\), prevRefs\);/,
    "🔴 роут не дає «минулому» чисел джерела");
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const sec = await k.createSection(db, 901, { name: "Поставлені авто" });
    const inc = await k.createKpi(db, 901, { sectionId: sec, name: "Дохід" });
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'delivered_income' WHERE id = $1`, [inc]);
    await c.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value) VALUES ($1, 'week', '2026-09-28', 2973228)`, [inc]);
    const now = new Date("2026-10-06T10:00:00Z");
    const row = async (prev: Record<string, number> | null) => (await k.loadPeriod(db, "week", "2026-10-05", { delivered_income: 654010 }, now, prev)).sections[0].kpis[0];
    assert.equal((await row(null)).prevValue, 2973228, "🔴 без чисел джерела «минулий» загубив збережене");
    assert.equal((await row({ delivered_income: 4821254 })).prevValue, 4821254, "🔴 «минулий» узяв проміжне з таблиці замість CRM");
    await k.setPeriodClosed(db, 901, "week", "2026-09-28", true, { delivered_income: 4800000 });
    assert.equal((await row({ delivered_income: 4821254 })).prevValue, 4800000, "🔴 зафіксоване закриттям перекрито живим");
  } finally { await s.dispose(); }
});

/**
 * #1208 — ЖИВИЙ SQL: ОПЕРАЦІЙНІ — РУЧНЕ ЧИСЛО ПОВЕРХ «ПЛАН/ФАКТ» (зустріч з Тетяною 05.10.2026: «дай можливість
 * коригувати і для місяця, і для тижня; решта нічого не треба редагувати»). Число людини — головне («вручну»); порожнє
 * повертає «План/факт»; закриття фіксує РУЧНЕ, а не джерело; рядок із Kommo руками як і раніше не вноситься.
 * 🧨 Червоніє, якщо ручне не перекриває джерело, очищення не повертає «План/факт», закриття фіксує джерело чи
 * Kommo-рядок стане редагованим.
 */
test("#1208 ЖИВИЙ SQL: операційні — ручне поверх «План/факт», порожнє повертає, закриття фіксує ручне; Kommo — ні", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const sec = await k.createSection(db, 901, { name: "Операційні витрати" });
    const gen = await k.createKpi(db, 901, { sectionId: sec, name: "Загальні витрати" });
    const del = await k.createKpi(db, 901, { sectionId: sec, name: "Поставлені · дохід" });
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'opex_general' WHERE id = $1`, [gen]);
    await c.query(`UPDATE fin_kpis SET kind = 'auto', ref_source = 'delivered_income' WHERE id = $1`, [del]);
    const refs = { opex_general: 43500.5, delivered_income: 9 };
    const now = new Date("2026-10-20T10:00:00Z");
    const row = async (r: Record<string, number> = refs) => (await k.loadPeriod(db, "month", "2026-10-01", r, now)).sections[0].kpis.find((x: any) => x.id === gen);
    assert.deepEqual([(await row()).value, (await row()).autoState, (await row()).editable], [43500.5, "live", true], "🔴 операційні не редагуються поверх «План/факт»");
    assert.equal((await k.loadPeriod(db, "month", "2026-10-01", refs, now)).sections[0].kpis.find((x: any) => x.id === del).editable, false, "🔴 рядок Kommo став редагованим");
    assert.deepEqual(await k.saveKpiValues(db, 901, "month", "2026-10-01", [{ kpiId: gen, value: "50 000" }], refs), { changed: 1 });
    assert.deepEqual([(await row()).value, (await row()).autoState], [50000, "override"], "🔴 ручне число не перекрило «План/факт»");
    await assert.rejects(k.saveKpiValues(db, 901, "month", "2026-10-01", [{ kpiId: del, value: "1" }], refs), (e: unknown) => status(e) === 400, "🔴 рядок Kommo вноситься руками");
    await k.saveKpiValues(db, 901, "month", "2026-10-01", [{ kpiId: gen, value: "" }], refs);
    assert.deepEqual([(await row()).value, (await row()).autoState], [43500.5, "live"], "🔴 очищення не повернуло «План/факт»");
    await k.saveKpiValues(db, 901, "month", "2026-10-01", [{ kpiId: gen, value: "61 000" }], refs);
    await k.setPeriodClosed(db, 901, "month", "2026-10-01", true, refs);
    assert.deepEqual([(await row({ opex_general: 1, delivered_income: 9 })).value, (await row()).autoState], [61000, "frozen"], "🔴 закриття зафіксувало джерело замість ручного");
    await k.setPeriodClosed(db, 901, "month", "2026-10-01", false);
    assert.deepEqual([(await row()).value, (await row()).autoState], [61000, "override"], "🔴 відкриття загубило ручне число");
  } finally { await s.dispose(); }
});

/**
 * #1209 — ЖИВИЙ SQL: СЕЙФ У ВАЛЮТІ Й З КАТЕГОРІЄЮ (зустріч 05.10.2026: «дата, сума, валюта — їх три … важливо, щоб
 * була категорія»). Сума — у своїй валюті, гривня — за курсом на дату (`rateOf`), і саме гривня йде в суми; валюта
 * лише UAH/USD/EUR; категорія — лише жива стаття «План/факт». 🧨 Червоніє, якщо USD піде в суми як гривня, прийметься
 * чужа валюта або видалена стаття.
 */
test("#1209 ЖИВИЙ SQL: Сейф — валюта з курсом на дату, гривня в суми; категорія — лише жива стаття", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const bm = await import("./bankManual.js");
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const { safe } = await bankFixture(c);
    const fin = await import("./finance.js");
    const r = await fin.createResp(db, 901, { name: "Опер" });
    const g = await fin.createGroup(db, 901, { respId: r, name: "Пальне" });
    const item = await fin.createItem(db, 901, { groupId: g, name: "Бензин" });
    const gone = await fin.createItem(db, 901, { groupId: g, name: "Стара" });
    await fin.deleteItem(db, 901, gone, true);
    const days: string[] = [];
    const rateOf = async (ccy: string, day: string) => { days.push(`${ccy}@${day}`); return ccy === "USD" ? 41.5 : 48; };
    await bm.addManual(db, 901, { accountId: safe, kind: "op", date: "2026-10-06", direction: "out", amount: "100", currency: "usd", itemId: item }, rateOf);
    assert.deepEqual(days, ["USD@2026-10-06"], "🔴 курс узято не на дату запису");
    const row = (await c.query(`SELECT amount::text AS a, currency, amount_uah::text AS u, fin_item_id FROM bank_transactions WHERE account_id = $1`, [safe])).rows[0];
    assert.deepEqual([Number(row.a), row.currency, Number(row.u), row.fin_item_id], [-100, "USD", -4150, item], "🔴 запис у валюті збережено хибно");
    assert.deepEqual(await k.bankTotals(db, "2026-10-05", "2026-10-11"), { in: 0, out: 4150, ownIn: 0, ownOut: 0, rows: 1 }, "🔴 у «Витрати загальні» пішли долари, а не гривня");
    await assert.rejects(bm.addManual(db, 901, { accountId: safe, kind: "op", date: "2026-10-07", direction: "in", amount: "1", currency: "PLN" }, rateOf), (e: unknown) => status(e) === 400, "🔴 прийнято чужу валюту");
    await assert.rejects(bm.addManual(db, 901, { accountId: safe, kind: "op", date: "2026-10-07", direction: "in", amount: "1", itemId: gone }, rateOf), (e: unknown) => status(e) === 404, "🔴 прийнято видалену статтю");
    const listed = (await bm.listManual(db, safe, "2026-10-01", "2026-10-31")).rows[0];
    assert.deepEqual([listed.item, listed.currency, listed.amount_uah], ["Бензин", "USD", -4150], "🔴 список не показує категорію / валюту");
  } finally { await s.dispose(); }
});

/**
 * #1216 — ЖИВИЙ SQL: ОСОБИСТІ КАРТКИ ФОП ВИМКНЕНО — РАЗОВО. Тетяна мала на увазі робочу картку Саші; три особисті
 * картки вимикаються (НЕ видаляються — операції лишаються, вмикаються в налаштуваннях), і свідомо ввімкнена назад
 * повторним прогоном схеми не вимикається; рахунок ФОП не чіпається. 🧨 Червоніє, якщо картку видалити, вимкнути ФОП
 * чи вимикати щоразу.
 */
test("#1216 ЖИВИЙ SQL: особисті картки ФОП вимкнено разово — ФОП не зачеплено, ввімкнену назад не вимикає", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    await c.query(`DELETE FROM fin_kpi_imports WHERE key = 'cards-off-2026-10-05'`);
    await c.query(`DELETE FROM bank_accounts`);
    await c.query(`INSERT INTO bank_accounts (company, bank, label, currency, finance_only, mono_type, is_active) VALUES
      ('fop_mono', 'mono', 'ФОП Моно', 'UAH', false, NULL, true), ('fop_mono', 'mono', 'Картка white', 'UAH', true, 'white', true),
      ('fop_mono', 'mono', 'Картка black', 'UAH', true, 'black', true)`);
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await c.query(schema);
    const st = async () => (await c.query(`SELECT label, is_active FROM bank_accounts ORDER BY id`)).rows.map((x) => `${x.label}:${x.is_active}`);
    assert.deepEqual(await st(), ["ФОП Моно:true", "Картка white:false", "Картка black:false"], "🔴 картки не вимкнено або зачеплено ФОП / видалено");
    await c.query(`UPDATE bank_accounts SET is_active = true WHERE label = 'Картка black'`);
    await c.query(schema);
    assert.deepEqual(await st(), ["ФОП Моно:true", "Картка white:false", "Картка black:true"], "🔴 повторний прогін знову вимкнув свідомо ввімкнену картку");
  } finally { await s.dispose(); }
});

/**
 * #1219 — ПЕРЕНЕСЕННЯ ТАБЛИЦІ «СЕЙФ» (`parseSafeCsv` + `importSafe`, Роман 05.10.2026 «переносимо як є»). Пропускаються
 * залишки, нулі й рядки до `from`; гривня — зі стовпця таблиці, але ЗНАК — від суми (продаж валюти з додатною гривнею
 * в таблиці); без гривні й курсу — НБУ на дату; два однакові рядки — дві операції; повторний прогін — 0 нових;
 * тиждень із підсумком — відмова цілком. 🧨 Червоніє, якщо залишок стане операцією, знак гривні піде з таблиці,
 * однакові рядки злиплись або повтор задвоїв Сейф.
 */
test("#1219 ЖИВИЙ SQL: перенесення Сейфу — без залишків, знак від суми, дублі — дві операції, повтор — 0 нових", async (t) => {
  const bm = await import("./bankManual.js");
  const csv: string[][] = [
    ["9", "", "", "", "02.10.2026"], ["", "UAH", "278278"],
    ["Дата", "Сумма", "Валюта", "Текущий курс", "Сумма в грн", "На що", "Кому (ID)", "Категория"],
    ["31.12.2025", "-500", "UAH", "", "", "Минулий рік", "", "Офіс"],
    ["01.02.2026", "102550", "UAH", "", "", "Текущий остаток грн", "", ""],
    ["24.03.2026", "900", "USD", "", "39555", "Привезли в офіс", "61893927", "Транспортні послуги"],
    ["05.06.2026", "-1620", "EUR", "50,6", "81972", "Продаж валюти", "", "Обмін валют"],
    ["16.07.2026", "50", "USD", "", "", "Привезли", "62467001", "Транспортні послуги"],
    ["17.07.2026", "-750", "UAH", "", "", "Аванс Шабурова", "", "ЗП"],
    ["17.07.2026", "-750", "UAH", "", "", "Аванс Шабурова", "", "ЗП"],
    ["18.07.2026", "0", "UAH", "", "", "Нуль", "", ""],
  ];
  const p = bm.parseSafeCsv(csv, "2026-01-01");
  assert.deepEqual(p.skipped, { balance: 1, zero: 1, before: 1, bad: 0 }, "🔴 залишок / нуль / минулий рік не пропущено");
  assert.deepEqual(p.rows.map((r) => [r.day, r.currency, r.uah]), [["2026-03-24", "USD", 39555], ["2026-06-05", "EUR", -81972], ["2026-07-16", "USD", null],
    ["2026-07-17", "UAH", -750], ["2026-07-17", "UAH", -750]], "🔴 гривня чи її знак узяті хибно");
  assert.notEqual(p.rows[3].key, p.rows[4].key, "🔴 два однакові рядки злиплись в одну операцію");
  assert.equal(bm.parseSafeCsv(csv, "2026-01-01").rows[3].key, p.rows[3].key, "🔴 ключ не детермінований — повтор задвоїть");

  const s = await scratchDb(t);
  if (!s) return;
  const k = await import("./financeKpi.js");
  const { db, c } = s;
  try {
    const { safe } = await bankFixture(c);
    const rate = async () => 41;
    assert.deepEqual(await bm.importSafe(db, safe, p.rows, rate), { inserted: 5, existing: 0, conflicts: [] });
    assert.deepEqual(await bm.importSafe(db, safe, p.rows, rate), { inserted: 0, existing: 5, conflicts: [] }, "🔴 повтор задвоїв Сейф");
    const jul = await k.bankTotals(db, "2026-07-13", "2026-07-19");
    assert.deepEqual([jul.in, jul.out], [2050, 1500], "🔴 USD без курсу не перераховано за НБУ або дублі злиплись");
    const listed = (await bm.listManual(db, safe, "2026-07-01", "2026-07-31")).rows.map((r: any) => r.item);
    assert.ok(listed.includes("ЗП"), "🔴 категорія таблиці не видна в Сейфі");
    await bm.addManual(db, 901, { accountId: safe, kind: "week", date: "2026-08-03", inAmount: "1" });
    const aug = bm.parseSafeCsv([csv[2], ["04.08.2026", "-5", "UAH", "", "", "x", "", "ЗП"]], "2026-01-01").rows;
    await assert.rejects(bm.importSafe(db, safe, aug, rate), (e: unknown) => status(e) === 409, "🔴 операції лягли в тиждень із підсумком");
  } finally { await s.dispose(); }
});

/**
 * #1220 — «ХТО ВНІС» У СЕЙФІ СЛОВАМИ (Роман 07.10.2026: «зроби більш читабельним»). `listManual` позначає перенесене з
 * таблиці (`imported`) рівно за ключем перенесення: внесене в дашборді — ні, навіть з тією ж категорією й сумою. Рядок
 * таблиці без категорії — «без категорії», а не «Сейф» (так `importSafe` заповнює контрагента).
 * 🧨 Червоніє, якщо ознаку рахувати не за ключем (усім, нікому чи за порожнім «хто») або порожню категорію назвати «Сейф».
 */
test("#1220 ЖИВИЙ SQL: Сейф — «з таблиці» лише на перенесених записах, внесене в дашборді — ні", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const bm = await import("./bankManual.js");
  const { db, c } = s;
  try {
    const { safe } = await bankFixture(c);
    const csv = [["Дата", "Сумма", "Валюта", "Текущий курс", "Сумма в грн", "На що", "Кому (ID)", "Категория"],
      ["02.10.2026", "-750", "UAH", "", "", "Аванс", "", "ЗП"], ["03.10.2026", "100", "UAH", "", "", "Без категорії", "", ""]];
    await bm.importSafe(db, safe, bm.parseSafeCsv(csv, "2026-01-01").rows, async () => 41);
    await bm.addManual(db, 901, { accountId: safe, kind: "op", date: "2026-10-02", direction: "out", amount: "750", purpose: "Аванс" });
    const rows = (await bm.listManual(db, safe, "2026-10-01", "2026-10-31")).rows as { imported: boolean; item: string | null; purpose: string | null }[];
    assert.equal(rows.length, 3, "🔴 фікстура: мало бути три записи — два перенесені й один внесений");
    assert.deepEqual(rows.map((r) => r.imported).sort(), [false, true, true], "🔴 «з таблиці» стоїть не рівно на перенесених");
    assert.deepEqual(rows.map((r) => [r.purpose, r.item]).sort(), [["Аванс", null], ["Аванс", "ЗП"], ["Без категорії", null]],
      "🔴 категорія таблиці загубилась або порожня показана як «Сейф»");
    assert.ok(rows.every((r) => typeof r.imported === "boolean"), "🔴 ознака не булева — «невідомо» читатиметься як «ні»");
  } finally { await s.dispose(); }
});

/**
 * #1220b — ВІКНО СЕЙФУ ЧИТАЄ ОЗНАКУ І НЕ ОБІЦЯЄ ЗАЙВОГО. Перенесене підписане «з таблиці Сейфу», невідоме — словами;
 * підзаголовок не каже «лише адміну й фінансисту» (заміряно 07.10: Сейф бачать 10 людей, разом із КВП і бухгалтерією).
 * 🧨 Червоніє, якщо повернути старий підпис або «хто» знову стане «—».
 */
test("#1220b ФРОНТ СЕЙФУ: «з таблиці Сейфу» за ознакою, невідоме словами, підзаголовок без «лише адміну й фінансисту»", () => {
  const fe = FE("pages/dashboard/sections/BankSection.tsx");
  const modal = fe.slice(fe.indexOf("function SafeModal("), fe.indexOf("function SafeRow("));
  const row = fe.slice(fe.indexOf("function SafeRow("));
  assert.ok(modal.length > 0 && row.length > 0, "🔴 вікно чи рядок Сейфу не знайдено — гейту нічого перевіряти");
  assert.match(row, /const who = r\.imported \? "з таблиці Сейфу" : r\.entered_by \?\? "невідомо хто";/, "🔴 «хто» не за ознакою перенесення");
  assert.match(row, /\{title \?\? "без категорії"\}/, "🔴 запис без категорії знову порожній");
  assert.doesNotMatch(modal, /лише адміну й фінансисту/, "🔴 підзаголовок знову обіцяє «лише адміну й фінансисту»");
  assert.match(modal, /менеджери й тімліди Сейфу не бачать/, "🔴 підзаголовок не каже, хто НЕ бачить");
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
