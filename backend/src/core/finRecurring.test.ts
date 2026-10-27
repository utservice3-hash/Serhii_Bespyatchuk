import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { addPeriod, occurrences, shiftYm, buildMonths, remindersFor, undoable, type RecItem, type PaidRow } from "./finRecurring.js";

/**
 * 📅 «Календар оплат» (задача Тетяни #6369, 27.10.2026; макет «Г» — Роман). Гейти `#1291`–`#1291f` (вільні в `main` і в
 * усіх гілках на 27.10.2026).
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const item = (o: Partial<RecItem>): RecItem => ({ id: 1, name: "Оренда", amount: 45000, period: "month", anchorDay: 5, next: "2026-11-05", payerId: 8, payer: "Тетяна", note: null, active: true, ...o });
const paid = (o: Partial<PaidRow>): PaidRow => ({ id: 1, recurringId: 1, name: "Оренда", due: "2026-10-05", amount: 45000, planned: 45000, by: "Тетяна", at: "2026-10-05T09:00:00Z", cancelledBy: null, cancelledAt: null, ...o });

/**
 * #1291 — «ДЕНЬ ОПЛАТИ» НЕ ЗʼЇЖДЖАЄ. Наступна дата рахується від ЯКОРЯ, а не від попередньої: 31.01 → 28.02 → 31.03;
 * квартал з 30.11 → 28.02 → 30.05; рік з 29.02 → 28.02 → … → знову 29.02 у високосний. Місяць смуги — від 1-го числа
 * (31.08 + 1 = вересень, а не жовтень — борг 19, `monthKeys`). Вікно дат — включно з обох кінців.
 * 🧨 Червоніє, якщо дата піде від попередньої (лютий назавжди зробить 31-ше 28-м) чи місяць перескочить через переповнення.
 */
test("#1291 ДЕНЬ ОПЛАТИ НЕ ЗʼЇЖДЖАЄ: 31.01 → 28.02 → 31.03, квартал і рік від якоря, місяць смуги від 1-го, вікно включно", () => {
  assert.equal(addPeriod("2026-01-31", "month", 31), "2026-02-28", "🔴 31.01 + місяць");
  assert.equal(addPeriod("2026-02-28", "month", 31), "2026-03-31", "🔴 після лютого день зʼїхав");
  assert.equal(addPeriod("2026-03-31", "month", 31), "2026-04-30", "🔴 31.03 + місяць");
  assert.equal(addPeriod("2026-12-05", "month", 5), "2027-01-05", "🔴 перехід року");
  assert.deepEqual([addPeriod("2026-11-30", "quarter", 30), addPeriod("2027-02-28", "quarter", 30)], ["2027-02-28", "2027-05-30"], "🔴 квартал від якоря");
  assert.deepEqual([addPeriod("2028-02-29", "year", 29), addPeriod("2031-02-28", "year", 29)], ["2029-02-28", "2032-02-29"], "🔴 рік від якоря");
  assert.deepEqual([shiftYm("2026-08", 1), shiftYm("2026-01", -1), shiftYm("2026-10", 18)], ["2026-09", "2025-12", "2028-04"], "🔴 місяць смуги перескочив");
  assert.deepEqual(occurrences("2026-01-31", "month", 31, "2026-01-31", "2026-03-31"), ["2026-01-31", "2026-02-28", "2026-03-31"], "🔴 вікно не включно");
  assert.deepEqual(occurrences("2026-01-31", "month", 31, "2026-02-01", "2026-03-30"), ["2026-02-28"], "🔴 дата поза вікном потрапила");
});

/**
 * #1291b — СМУГА МІСЯЦІВ. Ліворуч — минуле аж до першої живої оплати (не менше 6 міс.), праворуч — 18 міс. Минуле — лише
 * реально оплачене (графік у минуле не малюється), майбутнє — з графіка увімкнених оплат; скасована позначка в смугу не
 * йде; вимкнена оплата — не планується, але її оплати лишаються; прострочене — «overdue»; «Оплачено» — лише на поточній
 * даті; «Скасувати» — лише на останній позначці.
 * 🧨 Червоніє, якщо смуга обріже історію, намалює графік у минуле, покаже скасоване чи дасть скасувати не останню.
 */
test("#1291b СМУГА: минуле — лише оплачене аж до першої оплати, майбутнє — графік, скасоване й вимкнене — не плануються", () => {
  const items = [item({ id: 1, next: "2026-11-05" }), item({ id: 2, name: "Хостинг", amount: 1200, anchorDay: 20, next: "2026-10-20" }), item({ id: 3, name: "Старе", active: false, next: "2026-08-01", anchorDay: 1 })];
  const p = [paid({ id: 1, due: "2025-12-05" }), paid({ id: 2, due: "2026-10-05" }), paid({ id: 3, recurringId: 2, name: "Хостинг", due: "2026-09-20", amount: 1200, planned: 1200, cancelledAt: "2026-09-21T10:00:00Z", cancelledBy: "Роман" }),
    paid({ id: 4, recurringId: 3, name: "Старе", due: "2026-07-01", amount: 700, planned: 700 })];
  const m = buildMonths(items, p, "2026-10-27");
  assert.deepEqual([m[0].ym, m[0].offset, m.at(-1)!.ym], ["2025-12", -10, "2028-04"], "🔴 смуга не від першої оплати чи не на 18 міс.");
  assert.equal(buildMonths(items, [], "2026-10-27")[0].ym, "2026-04", "🔴 без історії — не 6 міс. назад");
  const oct = m.find((x) => x.ym === "2026-10")!;
  assert.deepEqual(oct.events.map((e) => [e.recurringId, e.date, e.kind, e.due]), [[1, "2026-10-05", "paid", false], [2, "2026-10-20", "overdue", true]], "🔴 жовтень");
  assert.deepEqual([oct.sum, oct.paid, oct.overdue], [46200, 45000, 1200], "🔴 суми жовтня");
  assert.deepEqual(m.find((x) => x.ym === "2026-09")!.events, [], "🔴 скасоване чи графік у минуле потрапили у вересень");
  assert.deepEqual(m.find((x) => x.ym === "2026-07")!.events.map((e) => e.recurringId), [3], "🔴 оплата вимкненої зникла з історії");
  assert.ok(m.every((x) => x.events.every((e) => e.recurringId !== 3 || e.kind === "paid")), "🔴 вимкнена оплата планується");
  const nov = m.find((x) => x.ym === "2026-11")!.events;
  assert.deepEqual(nov.map((e) => [e.recurringId, e.kind, e.due]), [[1, "plan", true], [2, "plan", false]], "🔴 листопад: «Оплачено» не лише на поточній даті");
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.deepEqual([undoable(p[1], byId), undoable(p[0], byId), undoable(p[2], byId)], [true, false, false], "🔴 скасувати можна не лише останню живу");
});

/**
 * #1291c — КОМУ Й КОЛИ НАГАДУВАТИ. Лише тому, хто платить; за 3 дні (3 — так, 4 — ні), у день оплати і щодня після;
 * вимкнена оплата й оплата без платника — нікому.
 * 🧨 Червоніє, якщо межу зсунуть, нагадають чужому чи про вимкнене.
 */
test("#1291c НАГАДУВАННЯ: лише платнику, за 3 дні (4 — ні), у день оплати і щодня після, вимкнене — нікому", () => {
  const today = "2026-10-27";
  const items = [item({ id: 1, next: "2026-10-30" }), item({ id: 2, next: "2026-10-31" }), item({ id: 3, next: "2026-10-27" }), item({ id: 4, next: "2026-10-20" }),
    item({ id: 5, next: "2026-10-27", payerId: 50 }), item({ id: 6, next: "2026-10-27", active: false }), item({ id: 7, next: "2026-10-27", payerId: null })];
  assert.deepEqual(remindersFor(items, 8, today).map((r) => [r.id, r.days]), [[4, -7], [3, 0], [1, 3]], "🔴 межа 3 днів, сьогодні чи прострочене");
  assert.deepEqual(remindersFor(items, 50, today).map((r) => r.id), [5], "🔴 нагадало не тому, хто платить");
  assert.deepEqual(remindersFor(items, 8, today, 4).map((r) => r.id), [4, 3, 1, 2], "🔴 lead не діє");
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
 * #1291d — ЖИВИЙ SQL: ЗАПИС І ІСТОРІЯ. Створити — лише з платником, що має право (інакше 400, нічого не пишеться);
 * «Оплачено» — лише поточна дата (інша / повторно — 409 без запису), фактична сума окремо від планової, дата зсувається на
 * період; «Скасувати» — лише останню, рядок лишається «скасовано», дата повертається; після скасування можна оплатити
 * знову; вимкнути — оплатити не можна, історія ціла. Рядків історії ніколи не меншає.
 * 🧨 Червоніє, якщо подвійне натискання дасть дві оплати, скасування зітре рядок чи чужий платник пройде.
 */
test("#1291d ЖИВИЙ SQL: оплата лише поточної дати, скасування лишає рядок, історія не меншає, платник — лише з правом", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { createRecurring, payRecurring, undoPaid, updateRecurring, loadCalendar } = await import("./finRecurring.js");
  const db = c as unknown as import("./finance.js").Db;
  const rows = async () => (await c.query(`SELECT count(*)::int AS n FROM fin_recurring_paid`)).rows[0].n as number;
  try {
    await c.query(`INSERT INTO users (id, email, password_hash, role, is_active, full_name) VALUES (8, 'fin@test', 'x', 'admin', true, 'Тетяна'), (50, 'adm@test', 'x', 'admin', true, 'Роман'), (60, 'm@test', 'x', 'manager', true, 'Менеджер')`);
    await c.query(`UPDATE users SET role_override = 'financier' WHERE id = 8`);
    await c.query(`UPDATE roles SET permissions = permissions || '{"view_private_finance": true}'::jsonb WHERE key IN ('admin', 'financier')`);
    const body = { name: "Оренда офісу", amount: "45 000", period: "month", date: "2026-01-31", payerId: 8, note: "до 1-го" };
    await assert.rejects(createRecurring(db, 50, { ...body, payerId: 60 }), (e: any) => e?.status === 400, "🔴 платник без права пройшов");
    await assert.rejects(createRecurring(db, 50, { ...body, amount: "0" }), (e: any) => e?.status === 400, "🔴 нульова сума пройшла");
    await assert.rejects(createRecurring(db, 50, { ...body, date: "2026-02-30" }), (e: any) => e?.status === 400, "🔴 неіснуюча дата пройшла");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM fin_recurring`)).rows[0].n, 0, "🔴 відмова щось записала");
    const id = await createRecurring(db, 50, body);
    await assert.rejects(payRecurring(db, 8, id, { due: "2026-02-28" }), (e: any) => e?.status === 409, "🔴 оплачено не поточну дату");
    const p1 = await payRecurring(db, 8, id, { due: "2026-01-31", amount: "45 500" });
    assert.equal(p1.next, "2026-02-28", "🔴 дата не зсунулась на місяць");
    await assert.rejects(payRecurring(db, 8, id, { due: "2026-01-31" }), (e: any) => e?.status === 409, "🔴 подвійне натискання дало другу оплату");
    const p2 = await payRecurring(db, 50, id, { due: "2026-02-28" });
    assert.equal(p2.next, "2026-03-31", "🔴 день оплати зʼїхав після лютого");
    assert.equal(await rows(), 2, "🔴 оплат не дві");
    await assert.rejects(undoPaid(db, 50, p1.paidId), (e: any) => e?.status === 409, "🔴 скасовано не останню");
    assert.equal((await undoPaid(db, 50, p2.paidId)).next, "2026-02-28", "🔴 дата не повернулась");
    await assert.rejects(undoPaid(db, 50, p2.paidId), (e: any) => e?.status === 409, "🔴 скасовано двічі");
    assert.equal(await rows(), 2, "🔴 скасування стерло рядок");
    await payRecurring(db, 8, id, { due: "2026-02-28", amount: "44 000" });
    assert.equal(await rows(), 3, "🔴 після скасування не можна оплатити знову");
    await updateRecurring(db, 50, id, { active: false });
    await assert.rejects(payRecurring(db, 8, id, { due: "2026-03-31" }), (e: any) => e?.status === 400, "🔴 оплачено вимкнене");
    const cal = await loadCalendar(db, "2026-04-10");
    assert.deepEqual(cal.history.map((h) => [h.due, h.amount, h.planned, h.by, !!h.cancelledAt]),
      [["2026-02-28", 44000, 45000, "Тетяна", false], ["2026-02-28", 45000, 45000, "Роман", true], ["2026-01-31", 45500, 45000, "Тетяна", false]], "🔴 історія");
    assert.deepEqual(cal.payers.map((p) => p.name), ["Роман", "Тетяна"], "🔴 платники — не рівно ті, хто має право");
    assert.equal(cal.items[0].active, false, "🔴 вимкнення не записалось");
  } finally { await s.dispose(); }
});

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

/**
 * #1291e — ОКРЕМО ВІД ПЛАНУ/ФАКТУ І БЕЗ ВИДАЛЕННЯ. SQL по таблицях календаря (`FROM` / `JOIN` / `INTO` / `UPDATE`) є лише в `core/finRecurring.ts` (жоден
 * модуль Плану/факту, Результату, KPI, Каси їх не бачить); видалення з них (`DELETE` / `TRUNCATE`) немає ніде в коді.
 * Сама перевірка обходить УСІ файли `backend/src` (не лише ті, де є слово), і для доказу, що їй є що знаходити, звіряє:
 * файлів більше сотні, а ядро календаря таблиці справді згадує.
 * 🧨 Червоніє, якщо хтось підключить календар до Плану/факту чи додасть видалення історії.
 */
test("#1291e ІЗОЛЯЦІЯ: таблиці календаря — лише в ядрі календаря, видалення з них немає ніде", () => {
  const root = path.join(import.meta.dirname, "..", "..", "src");
  const files = walk(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length > 100, `🔴 обійдено лише ${files.length} файлів — простір пошуку неповний`);
  const users = files.filter((f) => /(FROM|JOIN|INTO|UPDATE)\s+fin_recurring/i.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  assert.deepEqual(users, [path.join("core", "finRecurring.ts")], "🔴 таблиці календаря читає чи пише ще хтось");
  for (const f of [...walk(root).filter((x) => x.endsWith(".ts")), path.join(root, "db", "schema.sql")])
    assert.doesNotMatch(readFileSync(f, "utf8"), /(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+fin_recurring/i, `🔴 видалення історії в ${path.relative(root, f)}`);
});

/**
 * #1291f — МЕЖА Й ПРОВОДКА. Сім роутів, кожен — `view_private_finance` ПЕРШИМ middleware; роутер змонтовано ДО загального
 * `/api/finance`; у матриці перегляд — Адмін і фінансист, СЕО / ОД / КВП — заборона (дзеркало), запис — deny-only; таблиці
 * закриті від AI; вкладка «Календар оплат» без права — напис і без запиту; нагадування в меню — лише з правом, раз на день.
 * 🧨 Червоніє, якщо зняти право з роута, відкрити календар СЕО/ОД/КВП чи вмикати опитування всім.
 */
test("#1291f МЕЖА: сім роутів під view_private_finance, матриця, AI закрито, вкладка й нагадування — лише з правом", async () => {
  const r = SRC("routes/financeCalendar.ts");
  const handlers = [...r.matchAll(/financeCalendarRouter\.(get|post|put|patch|delete)\("([^"]+)",\s*([^,]+),/g)];
  assert.equal(handlers.length, 7, "🔴 обробників не рівно сім — гейт не бачить нового роута");
  for (const [, m, p, first] of handlers) assert.equal(first.trim(), `requirePerm("view_private_finance")`, `🔴 ${m.toUpperCase()} ${p}: першим стоїть «${first.trim()}»`);
  const idx = SRC("index.ts");
  assert.ok(idx.indexOf(`app.use("/api/finance/calendar", financeCalendarRouter);`) > 0 && idx.indexOf(`app.use("/api/finance/calendar", financeCalendarRouter);`) < idx.indexOf(`app.use("/api/finance", financeRouter);`), "🔴 роутер не змонтовано до /api/finance");
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js");
  const row = (method: string, p: string) => ACCESS_MATRIX.find((x) => x.method === method && x.path === p);
  for (const p of ["/api/finance/calendar", "/api/finance/calendar/due", "/api/finance/calendar/history.xlsx"]) {
    assert.deepEqual([...(row("GET", p)?.allow ?? [])].sort(), ["admin", "financier"], `🔴 ${p}: дозвіл не рівно Адмін і фінансист`);
    for (const role of ["ceo", "opdir", "kvp", "manager"]) assert.ok(row("GET", p)!.deny.includes(role), `🔴 ${p}: ${role} не в забороні`);
  }
  for (const [m, p] of [["POST", "/api/finance/calendar"], ["PATCH", "/api/finance/calendar/:id"], ["POST", "/api/finance/calendar/:id/pay"], ["POST", "/api/finance/calendar/paid/:id/undo"]])
    assert.deepEqual([row(m, p)?.cls, row(m, p)?.deny], ["deny-only", ["ceo", "opdir", "kvp", "hr", "team_lead", "manager"]], `🔴 ${m} ${p} не в матриці`);
  for (const t of ["fin_recurring", "fin_recurring_paid"]) {
    assert.match(SRC("db/schema.sql"), new RegExp(`REVOKE ALL ON ${t} FROM ai_readonly;`), `🔴 ${t} відкрита для AI`);
    assert.match(SRC("ai/metricTools.ts"), new RegExp(`"${t}"`), `🔴 ${t} не в заборонених AI`);
  }
  const sec = FE("pages/dashboard/sections/FinanceSection.tsx"), tab = FE("pages/dashboard/sections/FinanceCalendarTab.tsx");
  assert.match(sec, /\{tab === "calendar" && <FinanceCalendarTab \/>\}/, "🔴 вкладка не рендерить календар");
  assert.match(sec, /\["calendar", "Календар оплат", false\]/, "🔴 вкладки немає в «Фінансах»");
  assert.match(tab, /const canView = \(getAuthPayload\(\)\?\.perms \?\? \[\]\)\.includes\("view_private_finance"\);/, "🔴 вкладка не за view_private_finance");
  assert.match(tab, /if \(!canView\) return;\n\s*fetchFinCalendar\(\)/, "🔴 без права вкладка все одно просить дані");
  assert.ok(tab.indexOf("if (!canView) return <div") < tab.indexOf("<section"), "🔴 вміст рендериться до перевірки права");
  assert.match(FE("components/Layout.tsx"), /useFinanceReminders\(\(!screens \|\| screens\.includes\("finance"\)\) && \(getAuthPayload\(\)\?\.perms \?\? \[\]\)\.includes\("view_private_finance"\)/, "🔴 нагадування опитує без права");
  const hook = FE("components/useFinanceReminders.ts");
  assert.match(hook, /const fresh = d\.items\.filter\(\(r\) => !was\.includes\(`\$\{r\.id\}@\$\{r\.next\}`\)\);\n\s*if \(!fresh\.length\) return;/, "🔴 повідомлення не раз на день");
});
