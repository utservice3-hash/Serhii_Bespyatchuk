import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAmount, parseMonth, rowState, monthTotals, offFromFor, isActiveIn, addMonths, kyivMonth, FinError } from "./finance.js";

/**
 * 💰 ФІНАНСИ, прохід 1 (29.09.2026) — гейти `#930`–`#936`.
 * Номери — з вільного діапазону над `#918` (найвищий у `main` і в усіх гілках 29.09.2026 — `#918`);
 * `#919`–`#929` лишено сусіднім чатам, щоб не зіткнутись до мержу (борг 17).
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
const FE = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const status = (e: unknown) => (e as { status?: number }).status;

/**
 * #930 — ПІДСУМОК = СУМА РЯДКІВ, ПОРОЖНЄ ≠ НУЛЬ. Сума з клітинки розбирається як у таблиці
 * («1 000,50»), текст — помилка, а не нуль; підсумок складає лише ДІЮЧІ рядки й у копійках.
 * 🧨 Червоніє, якщо текст стане нулем, вимкнений рядок потрапить у підсумок або гроші складатимуться
 * з плаваючою похибкою.
 */
test("#930 ПІДСУМОК: лише сума діючих рядків у копійках; «1 000,50» — число, текст — 400, порожнє — не нуль", () => {
  assert.equal(parseAmount("1 000,50"), 1000.5);
  assert.equal(parseAmount("1 234 567,8"), 1234567.8, "🔴 нерозривні пробіли з Excel не прибрано");
  assert.equal(parseAmount("−12 000"), -12000, "🔴 мінус із таблиці (U+2212) не розпізнано");
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(149839.1), 149839.1);
  for (const bad of ["abc", "1.000,50", "12 грн", "1e5", "--5"])
    assert.throws(() => parseAmount(bad), (e: unknown) => e instanceof FinError && status(e) === 400, `🔴 «${bad}» прийнято як число`);
  const rows = [
    { plan: 0.1, fact: 0.2, active: true }, { plan: 0.2, fact: 0.1, active: true },
    { plan: null, fact: 500, active: true }, { plan: 1000, fact: null, active: true },
    { plan: 99999, fact: 99999, active: false },
  ];
  const t = monthTotals(rows);
  assert.equal(t.plan, 1000.3, "🔴 план складено з плаваючою похибкою або з вимкненим рядком");
  assert.equal(t.fact, 500.3, "🔴 факт складено з плаваючою похибкою або з вимкненим рядком");
  assert.equal(t.items, 4, "🔴 вимкнений рядок пораховано");
  assert.deepEqual([t.over, t.noplan, t.overSum], [1, 1, 0.1], "🔴 «понад план» / «без плану» пораховано не так");
  assert.equal(parseMonth("2026-09"), "2026-09-01");
  assert.equal(parseMonth("2026-09-17"), "2026-09-01");
  assert.throws(() => parseMonth("2026-13"), /РРРР-ММ/);
  assert.throws(() => parseMonth("вересень"), /РРРР-ММ/);
});

/**
 * #930b — СТАН РЯДКА ПО ОБИДВА БОКИ МЕЖІ. «Понад план» — строго факт > план: факт = план — ще «ок»,
 * на копійку більше — вже «понад». План 0 чи порожній при факті — «без плану», а не «ок».
 * 🧨 Червоніє, якщо межу зробити `>=` або рахувати план 0 як план.
 */
test("#930b СТАН РЯДКА: f = p — ок, f = p + 0.01 — понад; без плану, без факту, порожньо", () => {
  assert.equal(rowState(1000, 1000), "ok", "🔴 факт рівно в план позначено перевитратою");
  assert.equal(rowState(1000, 1000.01), "over", "🔴 перевитрату на копійку не видно");
  assert.equal(rowState(1000, 0), "ok");
  assert.equal(rowState(1000, null), "nofact");
  assert.equal(rowState(null, 500), "noplan");
  assert.equal(rowState(0, 500), "noplan", "🔴 план 0 при факті — це «без плану», а не «понад»");
  assert.equal(rowState(null, null), "empty");
  assert.equal(rowState(0, 0), "empty");
  assert.equal(rowState(null, 0), "empty");
});

/**
 * #932b — ВИМКНЕННЯ НЕ ЧІПАЄ МИНУЛОГО (чисте правило). Стаття вимикається з місяця ПІСЛЯ останньої
 * цифри, але не раніше поточного; у місяці вимкнення вона вже не діє, у попередньому — ще діє.
 * 🧨 Червоніє, якщо вимикати з поточного місяця попри цифри в ньому або рахувати межу включно.
 */
test("#932b ВИМКНЕННЯ (правило): з місяця після останньої цифри, не раніше поточного; межа — строго", () => {
  assert.equal(offFromFor("2026-09-01", "2026-09-01"), "2026-10-01", "🔴 вимкнення прибрало цифри поточного місяця");
  assert.equal(offFromFor("2026-09-01", "2026-03-01"), "2026-09-01", "🔴 вимкнення поїхало в минуле");
  assert.equal(offFromFor("2026-09-01", "2026-12-01"), "2027-01-01", "🔴 план наперед зник із підсумків");
  assert.equal(offFromFor("2026-09-01", null), "2026-09-01");
  assert.equal(isActiveIn("2026-10-01", "2026-09-01"), true);
  assert.equal(isActiveIn("2026-10-01", "2026-10-01"), false, "🔴 стаття діє в місяці, з якого вимкнена");
  assert.equal(isActiveIn(null, "2030-01-01"), true);
  assert.equal(addMonths("2026-12-01", 1), "2027-01-01");
  assert.equal(addMonths("2026-01-01", -1), "2025-12-01");
  assert.equal(kyivMonth(new Date("2026-09-30T21:30:00Z")), "2026-10-01", "🔴 місяць узято за UTC, а не за Києвом");
  assert.equal(kyivMonth(new Date("2026-09-30T20:30:00Z")), "2026-09-01");
});

/** Спільна фікстура: схема з нуля + один користувач-автор. */
async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  await c.query(`INSERT INTO users (id, email, password_hash, role, is_active) VALUES (901, 'fin@test', 'x', 'admin', true)`);
  return { c, db: c as unknown as import("./finance.js").Db, dispose: async () => { await c.end(); scratch.dispose(); } };
}

/** Дерево з двох статей і їхні id — для живих гейтів. */
async function seedTree(fin: typeof import("./finance.js"), db: import("./finance.js").Db) {
  const r = await fin.createResp(db, 901, { name: "Офіс-менеджер" });
  const g = await fin.createGroup(db, 901, { respId: r, name: "Витрати на персонал" });
  const a = await fin.createItem(db, 901, { groupId: g, name: "Team Building" });
  const b = await fin.createItem(db, 901, { groupId: g, name: "Приведи друга" });
  return { r, g, a, b };
}

/**
 * #931 — ЖИВИЙ SQL: ЗБЕРЕЖЕННЯ «ВСЕ АБО НІЧОГО» І ПІДСУМОК ІЗ РЯДКІВ. Одна клітинка «не число» — жодна
 * не записана; успішне збереження пише історію «було → стало»; незмінене не пишеться; факт майбутнього
 * місяця — 400. Підсумок екрана = незалежна сума `fin_values` по діючих статтях.
 * 🧨 Червоніє, якщо писати клітинки до перевірки всіх, прибрати запис в історію або підсумок рахувати
 * не з рядків.
 */
test("#931 ЖИВИЙ SQL: збереження все-або-нічого, історія було→стало, підсумок = сума рядків", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const fin = await import("./finance.js");
  const { c, db } = s;
  const now = new Date("2026-09-20T10:00:00Z");
  try {
    const { a, b } = await seedTree(fin, db);
    await assert.rejects(fin.saveValues(db, 901, "2026-09", [
      { itemId: a, field: "plan", value: "3 000" }, { itemId: b, field: "fact", value: "дві тисячі" }], now),
    (e: unknown) => status(e) === 400 && JSON.stringify((e as FinError).extra).includes(String(b)), "🔴 погана клітинка не зупинила збереження");
    assert.equal(Number((await c.query(`SELECT count(*) n FROM fin_values`)).rows[0].n), 0, "🔴 записано частину клітинок");

    assert.deepEqual(await fin.saveValues(db, 901, "2026-09", [
      { itemId: a, field: "plan", value: "3 000" }, { itemId: a, field: "fact", value: "11 585" },
      { itemId: b, field: "plan", value: 1000 }, { itemId: b, field: "fact", value: "1 000" }], now), { changed: 4 });
    assert.deepEqual(await fin.saveValues(db, 901, "2026-09", [{ itemId: a, field: "plan", value: "3000,00" }], now), { changed: 0 },
      "🔴 незмінене значення записано як зміну");
    await fin.saveValues(db, 901, "2026-09", [{ itemId: a, field: "plan", value: "5 000" }], now);
    const lg = (await c.query(`SELECT old_value::float8 AS o, new_value::float8 AS v, actor_id FROM fin_log WHERE target_id = $1 AND field = 'plan' ORDER BY id`, [a])).rows;
    assert.deepEqual(lg.map((x) => [x.o, x.v, x.actor_id]), [[null, 3000, 901], [3000, 5000, 901]], "🔴 історія не каже «було → стало» з автором");

    await assert.rejects(fin.saveValues(db, 901, "2026-10", [{ itemId: a, field: "fact", value: 1 }], now),
      (e: unknown) => status(e) === 400, "🔴 прийнято факт майбутнього місяця");
    await fin.saveValues(db, 901, "2026-10", [{ itemId: a, field: "plan", value: 7000 }], now);

    const m = await fin.loadMonth(db, "2026-09", now);
    const direct = (await c.query(`SELECT sum(plan)::float8 AS p, sum(fact)::float8 AS f FROM fin_values WHERE month = '2026-09-01'`)).rows[0];
    assert.deepEqual([m.totals.plan, m.totals.fact], [direct.p, direct.f], "🔴 підсумок екрана ≠ сумі рядків");
    assert.deepEqual([m.totals.plan, m.totals.fact, m.totals.over], [6000, 12585, 1]);
    const it = m.tree[0].groups[0].items.find((x) => x.id === a)!;
    assert.deepEqual([it.state, it.dataMonths], ["over", 2], "🔴 стан або кількість місяців із цифрами неправильні");

    await fin.setNote(db, 901, a, "2026-09", "  корпоратив перенесли з серпня ");
    assert.equal((await fin.loadMonth(db, "2026-09", now)).tree[0].groups[0].items.find((x) => x.id === a)!.note, "корпоратив перенесли з серпня");
    await fin.setNote(db, 901, a, "2026-09", "");
    assert.equal((await fin.loadMonth(db, "2026-09", now)).tree[0].groups[0].items.find((x) => x.id === a)!.note, null, "🔴 коментар не прибирається");

    await fin.setApproval(db, 901, "2026-10", true);
    await assert.rejects(fin.setApproval(db, 901, "2026-10", true), (e: unknown) => status(e) === 409);
    await fin.saveValues(db, 901, "2026-10", [{ itemId: b, field: "plan", value: 500 }], now);
    assert.equal((await fin.loadMonth(db, "2026-10", now)).approval?.changedAfter, 1, "🔴 зміну плану після погодження не видно");
    await fin.setApproval(db, 901, "2026-10", false);
    assert.equal((await fin.loadMonth(db, "2026-10", now)).approval, null, "🔴 погодження не знімається тією ж кнопкою");
  } finally { await s.dispose(); }
});

/**
 * #932 — ЖИВИЙ SQL: ВИМКНУТИ ≠ ВИДАЛИТИ, І ВИДАЛЕННЯ ПОВЕРТАЄТЬСЯ. Вимкнення не рухає ЖОДНОГО підсумку
 * жодного місяця; у вимкнений місяць писати не можна; стаття з цифрами без підтвердження не видаляється
 * (409), з підтвердженням — зникає з підсумків, «Повернути» повертає підсумки до копійки. Група
 * повертається рівно з тими статтями, що пішли з нею. Відповідальний із групами — 409.
 * 🧨 Червоніє, якщо вимикати з поточного місяця попри цифри, видаляти з цифрами без `confirm`, або
 * «Повернути» групи підніме й статтю, видалену раніше окремо.
 */
test("#932 ЖИВИЙ SQL: вимкнення не рухає підсумків, видалення з цифрами — 409, «Повернути» — до копійки", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const fin = await import("./finance.js");
  const { db } = s;
  const now = new Date("2026-09-20T10:00:00Z");
  // Гроші кожного місяця (кількість статей у майбутньому місяці від вимкнення законно меншає).
  const totals = async () => Promise.all(["2026-08", "2026-09", "2026-10"].map(async (m) => {
    const { plan, fact } = (await fin.loadMonth(db, m, now)).totals; return { plan, fact };
  }));
  try {
    const { r, g, a, b } = await seedTree(fin, db);
    await fin.saveValues(db, 901, "2026-08", [{ itemId: a, field: "plan", value: 100 }, { itemId: a, field: "fact", value: 120 }, { itemId: b, field: "fact", value: 7 }], now);
    await fin.saveValues(db, 901, "2026-09", [{ itemId: a, field: "plan", value: 200 }, { itemId: b, field: "plan", value: 50 }], now);
    const before = await totals();

    const off = await fin.setItemOff(db, 901, a, true, now);
    assert.equal(off.offFrom, "2026-10-01", "🔴 вимкнення прибрало цифри поточного місяця");
    assert.deepEqual(await totals(), before, "🔴 вимкнення зрушило підсумок місяця");
    await assert.rejects(fin.saveValues(db, 901, "2026-10", [{ itemId: a, field: "plan", value: 1 }], now),
      (e: unknown) => status(e) === 409, "🔴 у вимкнений місяць записано цифру");
    assert.equal((await fin.loadMonth(db, "2026-10", now)).tree[0].groups[0].items.find((x) => x.id === a)!.active, false);
    await fin.setItemOff(db, 901, a, false, now);
    await fin.saveValues(db, 901, "2026-10", [{ itemId: a, field: "plan", value: 1 }], now);

    await assert.rejects(fin.deleteItem(db, 901, a, false), (e: unknown) => status(e) === 409 && (e as FinError).extra?.months === 3,
      "🔴 стаття з цифрами видалилась без підтвердження");
    const withA = await totals();
    await fin.deleteItem(db, 901, a, true);
    assert.equal((await totals())[1].plan, 50, "🔴 видалена стаття лишилась у підсумку");
    await fin.restore(db, 901, "item", a);
    assert.deepEqual(await totals(), withA, "🔴 «Повернути» не повернуло підсумки до копійки");

    const empty = await fin.createItem(db, 901, { groupId: g, name: "Порожня" });
    await fin.deleteItem(db, 901, empty, false); // без цифр — без підтвердження
    await assert.rejects(fin.deleteGroup(db, 901, g, false), (e: unknown) => status(e) === 409 && (e as FinError).extra?.items === 2);
    await assert.rejects(fin.deleteResp(db, 901, r), (e: unknown) => status(e) === 409, "🔴 відповідальний із групами видалився");
    await fin.deleteGroup(db, 901, g, true);
    assert.equal((await fin.loadMonth(db, "2026-09", now)).totals.plan, 0);
    await fin.restore(db, 901, "group", g);
    const ids = (await fin.loadMonth(db, "2026-09", now)).tree[0].groups[0].items.map((x) => x.id).sort();
    assert.deepEqual(ids, [a, b].sort(), "🔴 «Повернути» групу підняло не ті статті");
    assert.deepEqual(await totals(), withA);

    const r2 = await fin.createResp(db, 901, { name: "Операційний директор" });
    await fin.updateGroup(db, 901, g, { respId: r2 });
    await fin.deleteResp(db, 901, r);
    await assert.rejects(fin.createResp(db, 901, { name: " операційний  директор " }), (e: unknown) => status(e) === 409, "🔴 дубль назви прийнято");
    await fin.updateItem(db, 901, b, { name: "Приведи друга (бонус)" });
    const card = await fin.itemCard(db, b, 2026);
    assert.equal(card.resp.name, "Операційний директор");
    assert.equal(card.months[7].fact, 7, "🔴 цифри не поїхали разом зі статтею");
    assert.ok(card.log.some((l) => /Перейменовано/.test(l.what)), "🔴 перейменування не в історії");
  } finally { await s.dispose(); }
});

/**
 * #933 — ДОСТУП: сид вкладки, матриця й права — один список. Вкладка й `edit_finance` — admin, СЕО, ОД,
 * КВП, фінансист (рішення 28.09.2026: «вона і все керівництво»); `approve_finance_plan` — admin, СЕО, ОД.
 * 🧨 Червоніє, якщо дописати роль лише в матрицю чи лише в сид, дати вкладку бухгалтерії чи HR,
 * або прибрати пару «видати / зняття».
 */
test("#933 ДОСТУП ФІНАНСІВ: вкладка, edit_finance і approve_finance_plan — у сиді, матриці й каталозі одним списком", () => {
  const sql = SRC("db/schema.sql");
  const list = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const row = /path: "\/api\/finance\/month\?m=2026-09", cls: "GET",\s*\n\s*allow: \[([^\]]*)\]/.exec(SRC("auth/accessMatrix.ts"));
  assert.ok(row, "🔴 рядок матриці для /api/finance/month не знайдено");
  const inMatrix = [...row[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const seed = /screen_access \|\| '\{"finance":true\}'::jsonb\s*\n\s*WHERE key IN \(([^)]*)\)/.exec(sql);
  assert.ok(seed, "🔴 сид вкладки `finance` не знайдено");
  assert.deepEqual(inMatrix, list(seed[1]), "🔴 матриця й сид вкладки розійшлись");
  const LEAD = ["admin", "ceo", "financier", "kvp", "opdir"];
  assert.deepEqual(list(seed[1]), LEAD, "🔴 склад вкладки розійшовся з рішенням (бухгалтерія й HR — ні)");
  for (const [perm, want] of [["edit_finance", LEAD], ["approve_finance_plan", ["admin", "ceo", "opdir"]]] as const) {
    const g = new RegExp(`permissions \\|\\| '\\{"${perm}": true\\}'::jsonb\\s*\\n\\s*WHERE key IN \\(([^)]*)\\)`).exec(sql);
    const st = new RegExp(`permissions - '${perm}'\\s*\\n\\s*WHERE key NOT IN \\(([^)]*)\\)`).exec(sql);
    assert.ok(g && st, `🔴 видача або зняття ${perm} не знайдені`);
    assert.deepEqual(list(g[1]), [...want], `🔴 ${perm} отримав не той склад`);
    assert.deepEqual(list(st[1]), list(g[1]), `🔴 видача й зняття ${perm} розійшлись`);
    assert.match(SRC("auth/permGrant.ts"), new RegExp(`"${perm}"`), `🔴 ${perm} не в каталозі — адмін не зможе ним керувати`);
    assert.ok(sql.lastIndexOf(`permissions - '${perm}'`) > sql.lastIndexOf("screen_access = (SELECT screen_access FROM roles WHERE key='admin')"),
      `🔴 зняття ${perm} стоїть ВИЩЕ за синк фінансиста — право розтечеться`);
  }
  assert.match(SRC("auth/routeTab.ts"), /pre\("\/api\/finance"\), tabs: \["finance"\]/, "🔴 /api/finance не під вкладкою finance");
});

/**
 * #933b — МЕЖА ПЕРШИМ ОПЕРАТОРОМ. На ній стоїть безпека проб `deny-only`: роль без права мусить
 * отримати 403 ДО запису. Читання — `onlyFinance(req)`, запис — `canEdit(req)`, погодження — `canApprove(req)`.
 * 🧨 Червоніє, якщо переставити межу нижче, пустити запис під `onlyFinance` або погодження під `canEdit`.
 */
test("#933b ДОСТУП ФІНАНСІВ: межа — перший оператор; запис — за правом, погодження — за окремим правом", () => {
  const src = SRC("routes/finance.ts");
  const all = [...src.matchAll(/financeRouter\.(get|post|patch|put|delete)\(/g)];
  const parsed = [...src.matchAll(/financeRouter\.(get|post|patch|put|delete)\("([^"]+)", async \(req, res\) => \{\s*try \{\s*([^\n;]+);/g)];
  assert.equal(parsed.length, all.length, `🔴 розпізнано ${parsed.length} із ${all.length} обробників`);
  assert.ok(all.length >= 15, `🔴 знайдено лише ${all.length} обробників — гейт нічого не перевіряє`);
  for (const [, m, p, first] of parsed) {
    const want = m === "get" ? "onlyFinance(req)" : p === "/approval" ? "canApprove(req)" : "canEdit(req)";
    assert.equal(first.trim(), want, `🔴 ${m.toUpperCase()} ${p}: першим стоїть «${first.trim()}»`);
  }
  assert.match(src, /function canEdit\(req: Request\): void \{\s*onlyFinance\(req\);\s*if \(!roleHasPerm\(req\.auth!\.roleKey, "edit_finance"\)\)/, "🔴 canEdit не перевіряє вкладку або право");
  assert.match(src, /function canApprove\(req: Request\): void \{\s*onlyFinance\(req\);\s*if \(!roleHasPerm\(req\.auth!\.roleKey, "approve_finance_plan"\)\)/, "🔴 canApprove не перевіряє вкладку або право");
});

/**
 * #933c — ЖИВИЙ SQL: ПІСЛЯ СХЕМИ З НУЛЯ фінансист МАЄ вкладку й право вносити, але НЕ погоджує
 * (синк «фінансист = права адміна» стоїть вище й копіює `approve_finance_plan`; зняття — нижче).
 * Бухгалтерія й HR вкладки не мають. Повторний прогін схеми нічого не змінює.
 * 🧨 Червоніє, якщо підняти зняття вище синку фінансиста або дати вкладку бухгалтерії.
 */
test("#933c ЖИВИЙ SQL: фінансист вносить, але не погоджує; бухгалтерія й HR — без вкладки; повторний прогін стабільний", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const q = async () => (await c.query(`SELECT key, (screen_access->>'finance')::boolean AS tab,
      permissions ? 'edit_finance' AS edit, permissions ? 'approve_finance_plan' AS appr FROM roles ORDER BY key`)).rows;
  try {
    const rows = await q();
    const by = Object.fromEntries(rows.map((r) => [r.key, [r.tab ?? false, r.edit, r.appr]]));
    assert.deepEqual(by.financier, [true, true, false], "🔴 фінансист не вносить або погоджує");
    assert.deepEqual(by.admin, [true, true, true]);
    assert.deepEqual(by.kvp, [true, true, false]);
    for (const k of ["hr", "manager", "team_lead", "____________"])
      if (by[k]) assert.deepEqual(by[k], [false, false, false], `🔴 роль ${k} отримала «Фінанси»`);
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    assert.deepEqual(await q(), rows, "🔴 повторний прогін схеми змінив права");
  } finally { await s.dispose(); }
});

/**
 * #934 — ТАБЛИЦІ ФІНАНСІВ ЗАКРИТІ ДЛЯ AI-ЗАПИТІВ. Кожна `fin_*` таблиця схеми — у REVOKE після свого
 * CREATE і у `FORBIDDEN_TABLES`. Перелік береться зі СХЕМИ, тож нова таблиця без REVOKE червоніє.
 * 🧨 Червоніє, якщо прибрати таблицю з REVOKE чи з `FORBIDDEN_TABLES`, або поставити REVOKE вище CREATE.
 */
test("#934 ФІНАНСИ: кожна fin_* таблиця відібрана в ai_readonly після CREATE і є у FORBIDDEN_TABLES", () => {
  const sql = SRC("db/schema.sql");
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (fin_[a-z_]+)/g)].map((m) => m[1]);
  assert.ok(tables.length >= 7, `🔴 знайдено лише ${tables.length} таблиць fin_* — гейт нічого не перевіряє`);
  const rev = /REVOKE ALL ON ((?:fin_[a-z_]+(?:, )?)+) FROM ai_readonly;/.exec(sql);
  assert.ok(rev, "🔴 REVOKE для таблиць фінансів не знайдено");
  const revoked = rev[1].split(", ");
  const forbidden = SRC("ai/metricTools.ts");
  for (const tb of tables) {
    assert.ok(revoked.includes(tb), `🔴 ${tb} не відібрана в ai_readonly`);
    assert.ok(sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tb}`) < rev.index, `🔴 REVOKE стоїть вище CREATE ${tb} — з нуля схема впаде`);
    assert.match(forbidden, new RegExp(`"${tb}"`), `🔴 ${tb} немає у FORBIDDEN_TABLES`);
  }
});

/**
 * #935 — ЖИВИЙ SQL: ПЕРЕНЕСЕННЯ З EXCEL. Підсумок кожного місяця після перенесення = сума РЯДКІВ файлу
 * (порахована тут незалежно), а підсумок файлу зберігається поруч — там, де вони розійшлись (як лютий
 * у справжньому файлі), екран бачить обидва. Порядок статей — як у файлі. Повторне перенесення — 409.
 * 🧨 Червоніє, якщо брати підсумок файлу замість суми рядків, губити нулі чи порядок, або дозволити
 * повторний запуск.
 */
test("#935 ЖИВИЙ SQL: перенесення — підсумок = сума рядків, файловий підсумок поруч, повтор — 409", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const fin = await import("./finance.js");
  const { db } = s;
  const file: import("./finance.js").ImportFile = {
    rows: [
      { k: "r", n: "Офіс-менеджер" }, { k: "g", n: "Витрати на персонал" },
      { k: "i", n: "Team Building", v: [[0, null], [3000, 11585]] },
      { k: "i", n: "Приведи друга", v: [[null, null], [1000, 1000]] },
      { k: "g", n: "Поштові послуги" },
      { k: "i", n: "Нова пошта", v: [[1234.56, 999.99], [null, 100.01]] },
      { k: "r", n: "Операційний директор" }, { k: "g", n: "Податки" },
      { k: "i", n: "ЄСВ", v: [[50000, 50000], [50000, null]] },
    ],
    // Лютий у файлі розходиться з сумою рядків на 100 000 — так було і в справжній таблиці.
    tot: [[51234.56, 50999.99], [-45999.99, 12685.01]],
  };
  const sums = [0, 1].map((m) => file.rows.filter((r) => r.k === "i").reduce((acc, r) => {
    const [p, f] = r.v![m]; return [acc[0] + Math.round((p ?? 0) * 100), acc[1] + Math.round((f ?? 0) * 100)];
  }, [0, 0]).map((x) => x / 100));
  try {
    const out = await fin.importHistory(db, null, file, 2026, "Витрати План/Факт 2026");
    assert.equal(out.items, 4);
    for (const m of [0, 1]) {
      const got = await fin.loadMonth(db, `2026-0${m + 1}`, new Date("2026-09-20T10:00:00Z"));
      assert.deepEqual([got.totals.plan, got.totals.fact], sums[m], `🔴 місяць ${m + 1}: підсумок ≠ сумі рядків файлу`);
      assert.deepEqual([got.imported?.filePlan, got.imported?.fileFact], file.tot![m], "🔴 підсумок файлу не збережено поруч");
      assert.deepEqual([got.imported?.rowsPlan, got.imported?.rowsFact], sums[m]);
    }
    const jan = await fin.loadMonth(db, "2026-01", new Date("2026-09-20T10:00:00Z"));
    assert.deepEqual(jan.tree.map((r) => r.name), ["Офіс-менеджер", "Операційний директор"], "🔴 порядок відповідальних не як у файлі");
    assert.deepEqual(jan.tree[0].groups[0].items.map((i) => [i.name, i.plan]), [["Team Building", 0], ["Приведи друга", null]],
      "🔴 нуль і «не внесено» злились або порядок статей не як у файлі");
    await assert.rejects(fin.importHistory(db, null, file, 2026, "повтор"), (e: unknown) => status(e) === 409, "🔴 повторне перенесення дозволено");
  } finally { await s.dispose(); }
});

/**
 * #936 — ФРОНТ: пункт «Фінанси» в «Аналітиці» після «Статистик (відділи)», розділ — статичним імпортом
 * (гейт #225: один чанк), кнопки редагування — за `canEdit`/`canApprove` із ВІДПОВІДІ СЕРВЕРА, а не за
 * роллю на клієнті; видалення має «Повернути».
 * 🧨 Червоніє, якщо вгадувати права з ролі, підвантажити розділ ліниво або прибрати «Повернути».
 */
test("#936 ФРОНТ ФІНАНСІВ: меню після «Статистик (відділи)», статичний імпорт, права — з відповіді сервера, є «Повернути»", () => {
  const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const layout = codeOnly(FE("components/Layout.tsx"));
  const dep = layout.indexOf(`{ key: "depstats"`), fin = layout.indexOf(`{ key: "finance", label: "Фінанси"`);
  assert.ok(fin > 0, "🔴 пункту «Фінанси» немає в меню (і в тумблерах Налаштувань)");
  assert.ok(dep > 0 && fin > dep && fin < layout.indexOf(`{ key: "missed-calls"`), "🔴 «Фінанси» стоять не після «Статистик (відділи)»");
  const dash = FE("pages/Dashboard.tsx");
  assert.match(dash, /^import \{ FinanceSection \} from "\.\/dashboard\/sections\/FinanceSection";$/m, "🔴 розділ імпортовано не статично");
  assert.match(dash, /section === "finance" && \(/, "🔴 розділ не рендериться на /finance");
  const sec = codeOnly(FE("pages/dashboard/sections/FinanceSection.tsx"));
  assert.doesNotMatch(sec, /roleKey|auth\.role|"financier"|"admin"/, "🔴 права вгадуються з ролі на клієнті, а не з відповіді сервера");
  assert.match(sec, /\{data\.canEdit && !edit && <button className="hr-btn p" onClick=\{\(\) => setEdit\(true\)\}>Вносити план і факт/,
    "🔴 кнопка внесення не прив'язана до canEdit з сервера");
  assert.match(sec, /\{data\.canApprove && <button className="hr-btn xs" onClick=\{\(\) => approve\(/, "🔴 погодження не прив'язане до canApprove з сервера");
  assert.match(sec, /\{data\.canEdit && <button className="hr-btn p" onClick=\{act\.addResp\}>/, "🔴 «+ Відповідальний» не прив'язаний до canEdit");
  assert.match(sec, /restoreFin\(kind, id\)/, "🔴 «Повернути» не кличе сервер");
  for (const k of ["resp", "group", "item"])
    assert.match(sec, new RegExp(`await deleteFin\\("${k}", [a-z]+\\.id(?:, confirm)?\\); reload\\(\\); undo\\("${k}", `), `🔴 видалення «${k}» без «Повернути»`);
});
