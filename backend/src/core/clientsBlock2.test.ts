import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { ALIAS_NAMES_SQL, groupAliasRows } from "./clientAliasNames.js";
import { ruleNumbers, segmentTip, stateTips, rulesText, categoryRulesPayload, type CategoryRuleNumbers } from "./categoryRules.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SECTIONS = "frontend/src/pages/dashboard/sections";

/**
 * 🔗ⓘ #719–#720b — ТЗ Юлі 22.09.2026, блок 2, прохід 1 (задача 4311): п.2.3 «обʼєднані
 * одним рядком» і п.2.4 «підказка з правилом на категорії». Обидва — ЛИШЕ показ: жодне
 * число на екрані не змінюється, тож гейти стережуть, щоб показ не розійшовся з тим,
 * що рахує ядро.
 */

test("#719 ПРИЄДНАНІ: групуються по канонічному ключу, рядок і картка показують їх із поля сервера", () => {
  const m = groupAliasRows([
    { canonical_key: "смартекс", alias_key: "курєрукраїни", name: "кур'єр україни", paid: 85 },
    { canonical_key: "смартекс", alias_key: "смар", name: "смар", paid: 81 },
    { canonical_key: "паркторг", alias_key: "паркторгтов", name: "ТОВ ПАРКТОРГ", paid: 0 },
  ]);
  assert.deepEqual(m.get("смартекс")?.map((a) => a.key), ["курєрукраїни", "смар"], "🔴 приєднані одного клієнта розсипались або змішались");
  assert.equal(m.get("паркторг")?.[0].paid, 0, "🔴 приєднаний без оплат зник — нуль теж відповідь");
  assert.equal(m.has("енерджигруп"), false, "🔴 клієнт без обʼєднань отримав вигаданих приєднаних");
  // SQL: лише активні обʼєднання і назва з угод САМОГО приєднаного.
  assert.match(ALIAS_NAMES_SQL, /a\.revoked_at IS NULL/, "🔴 відкликані обʼєднання показуватимуться як «обʼєднано»");
  assert.match(ALIAS_NAMES_SQL, /d\.client_key_raw = a\.alias_key/, "🔴 назва береться не з угод приєднаного — усі рядки звались би однаково");
  // Показ: рядок списку і картка беруть приєднаних із відповіді сервера.
  const list = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.match(list, /<div style=\{\{ fontWeight: 700 \}\}>\{c\.clientName\}<\/div>\s*<MergedLine merged=\{c\.merged\} \/>/,
    "🔴 під назвою клієнта в списку немає рядка «обʼєднано»");
  const card = read(`${SECTIONS}/ClientCardPanel.tsx`);
  assert.match(card, /card\.merged && card\.merged\.length > 0 && \(/, "🔴 картка не показує, хто обʼєднаний");
  const dash = read("backend/src/routes/dashboard.ts");
  assert.match(dash, /merged: aliasByKey\.get\(c\.client_key\) \?\? \[\],/, "🔴 рядок /client-plans не несе приєднаних");
  assert.match(dash, /merged: \(await clientAliasNames\.aliasNamesFor\(\[clientKey\]\)\)\.get\(clientKey\) \?\? \[\],/, "🔴 /client-card не несе приєднаних");
});

/**
 * #719b — ЖИВИЙ SQL на порожньому кластері: активне обʼєднання видно з назвою з угод
 * приєднаного і числом оплат; відкликане — ні; приєднаний без угод — сирим ключем.
 */
test("#719b ЖИВИЙ SQL: активний приєднаний — з назвою й оплатами, відкликаний — ні, без угод — сирим ключем", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    await c.query(`INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES (8921932, 142, 'paid') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO deals (kommo_id, pipeline_id, status_id, price, client_name, client_key, client_key_raw, created_at_kommo) VALUES
      (1, 8921932, 142, 100, 'Кур''єр України', 'смартекс', 'курєрукраїни', '2026-09-01'),
      (2, 8921932, 142, 100, 'Кур''єр України', 'смартекс', 'курєрукраїни', '2026-09-02'),
      (3, 8921932, 142, 100, 'Смар', 'смартекс', 'смар', '2026-09-03'),
      (4, 8921932, 142, 100, 'СМАР ТЕКС', 'смартекс', 'смартекс', '2026-09-04')`);
    await c.query(`INSERT INTO client_key_alias (alias_key, canonical_key, reason, revoked_at) VALUES
      ('курєрукраїни', 'смартекс', 'гейт #719b', NULL),
      ('смар', 'смартекс', 'гейт #719b', now()),
      ('тексгруп', 'смартекс', 'гейт #719b', NULL)`);
    const r = await c.query<{ canonical_key: string; alias_key: string; name: string; paid: number }>(ALIAS_NAMES_SQL, [["смартекс", "інший"]]);
    const got = r.rows.map((x) => `${x.alias_key}|${x.name}|${x.paid}`);
    assert.deepEqual(got, ["курєрукраїни|Кур'єр України|2", "тексгруп|тексгруп|0"],
      "🔴 показано відкликане обʼєднання, назва не з угод приєднаного, неправильні оплати або немає фолбеку на сирий ключ");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

test("#720 ПРАВИЛА КАТЕГОРІЙ: текст складається з чисел ядра і змінюється разом із порогом", () => {
  const n = ruleNumbers();
  const vip = segmentTip(n, "vip");
  assert.ok(vip.includes(`до ${n.vipMaxGapDays} днів`) && vip.includes(`після ${n.sleepingDays.vip} днів`) && vip.includes(`втрачений після ${n.lostDays}`),
    `🔴 підказка ВІП не несе порогів ядра: «${vip}»`);
  // По обидва боки: інші числа на вході → інший текст. Зашитий текст цього не пройде.
  const other: CategoryRuleNumbers = { ...n, vipMaxGapDays: 7, sleepingDays: { ...n.sleepingDays, vip: 21 }, lostDays: 240 };
  const vip2 = segmentTip(other, "vip");
  assert.ok(vip2.includes("до 7 днів") && vip2.includes("після 21 днів") && vip2.includes("втрачений після 240"),
    `🔴 текст не пішов за зміненим порогом — поріг зашито в рядок: «${vip2}»`);
  assert.ok(segmentTip(n, "regular").includes(`${n.vipMaxGapDays + 1}–${n.regularMaxGapDays} днів`), "🔴 межі регулярного розійшлись із segmentOf");
  assert.ok(stateTips(n).sleeping.includes(`${n.sleepingDays.episodic} в епізодичного`), "🔴 поріг сплячого для епізодичного не з ядра");
  assert.ok(stateTips(n).lost.includes(`${n.longLapsedDays} днів`), "🔴 «давно втрачений» без порогу ядра");
  const text = rulesText(n);
  assert.equal(text.length, 4, "🔴 довідка втратила частину правил (постійний · сегмент · сплячий · втрачений)");
  assert.ok(text[0].includes(`${n.qualifyMinPayments}+ успішні угоди`), "🔴 правило «постійного» не з константи qualifiesAsRepeat");
  const p = categoryRulesPayload();
  assert.deepEqual(Object.keys(p.segmentTips).sort(), ["episodic", "regular", "unknown", "vip"], "🔴 не для кожного сегмента є підказка");
});

test("#720b ФРОНТ ПОКАЗУЄ ТЕКСТ СЕРВЕРА: бейдж, чипи стану й довідка беруть categoryRules, порогів у фронті немає", () => {
  const list = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.match(list, /<SegmentBadge segment=\{c\.segment\} tip=\{data\?\.categoryRules\?\.segmentTips\[c\.segment\]\} \/>/,
    "🔴 бейдж сегмента в рядку не отримує підказку з ядра");
  assert.match(list, /<StateChip state=\{c\.state\} rule=\{c\.state === "sleeping" \? data\?\.categoryRules\?\.stateTips\.sleeping/,
    "🔴 чип стану не отримує правило з ядра");
  assert.match(list, /data\.categoryRules\.text\.map\(/, "🔴 довідка «Як рахуються категорії» не з тексту сервера");
  const badge = read(`${SECTIONS}/SegmentBadge.tsx`);
  assert.match(badge, /const base = tip \?\? m\.title;/, "🔴 бейдж ігнорує підказку сервера");
  const dash = read("backend/src/routes/dashboard.ts");
  assert.match(dash, /categoryRules: categoryRules\.categoryRulesPayload\(\),/, "🔴 /client-plans не віддає правил категорій");
  // Поріг у фронті = друга редакція правила. «14 днів» / «180» у тексті фронту заборонені.
  for (const [f, src] of [["ClientPlansSection", list], ["SegmentBadge", badge]] as const) {
    assert.doesNotMatch(src, /після 1[48]0? днів|сплячий після \d/, `🔴 ${f}: поріг стану зашито текстом у фронт`);
  }
});

/**
 * #717 — ФАКТ «З РАХУНКУ І ДАЛІ» (ТЗ 22.09, п.2.1) на справжніх функціях ядра проти порожнього
 * кластера. Фікстура по ОБИДВА боки кожної межі, бо на живих даних вони не трапляються разом:
 *  A безнал: етап 4 05.09 → далі            → рахується 05.09 (перший вхід)
 *  B готівка: БЕЗ етапу 4, «Авто працює» 10.09 → рахується 10.09 (буквальне ТЗ дало б 0)
 *  C програна після рахунку                  → НЕ рахується
 *  D 142 без жодної події, закрита 15.09     → рахується 15.09 (успіх не губиться)
 *  E лише ранні етапи                        → НЕ рахується
 *  F етап 4 28.08, успіх 12.09               → серпень, НЕ вересень (перший вхід)
 *  G етап 4 двічі (02.09 і 09.09)            → один раз, 02.09
 *
 * ⚠️ `DATABASE_URL` ставиться ДО імпорту ядра: пул — модульний синглтон. У цьому файлі пул
 * бере лише цей тест (#719b ходить власним клієнтом), тож чужої бази він не забере.
 */
test("#717 ФАКТ З РАХУНКУ: готівка з наступного етапу, програні — ні, перший вхід один раз, 142 без подій — за закриттям", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  process.env.DATABASE_URL = scratch.url;
  // Решта обовʼязкових змінних — заглушки, той самий прийом, що в #25: `config.js` вимагає їх на імпорті.
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  try {
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'М',1,true) ON CONFLICT DO NOTHING`);
    const deal = (id: number, ck: string, status: number, price: number, closed: string | null) => c.query(
      `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo,created_at_kommo)
       VALUES ($1,'d',10,8921932,$2,$3,$4,$4,$4,$5,'2026-08-01')`, [id, status, price, ck, closed]);
    const ev = (id: number, status: number, at: string) => c.query(
      `INSERT INTO deal_stage_events (kommo_id,status_id,pipeline_id,changed_at) VALUES ($1,$2,8921932,$3)`, [id, status, at]);
    await deal(1, "ka", 69716312, 1000, null); await ev(1, 100274340, "2026-09-05T09:00:00Z"); await ev(1, 69716300, "2026-09-08T09:00:00Z");
    await deal(2, "kb", 142, 2000, "2026-09-20T09:00:00Z"); await ev(2, 69716300, "2026-09-10T09:00:00Z"); await ev(2, 142, "2026-09-20T09:00:00Z");
    await deal(3, "kc", 143, 3000, "2026-09-07T09:00:00Z"); await ev(3, 100274340, "2026-09-06T09:00:00Z");
    await deal(4, "kd", 142, 4000, "2026-09-15T09:00:00Z");
    await deal(5, "ke", 69716252, 5000, null); await ev(5, 69693668, "2026-09-03T09:00:00Z");
    await deal(6, "kf", 142, 6000, "2026-09-12T09:00:00Z"); await ev(6, 100274340, "2026-08-28T09:00:00Z"); await ev(6, 142, "2026-09-12T09:00:00Z");
    await deal(7, "kg", 69716300, 7000, null); await ev(7, 100274340, "2026-09-02T09:00:00Z"); await ev(7, 100274340, "2026-09-09T09:00:00Z");

    const M = await import("./money.js");
    const sep = { from: "2026-09-01", to: "2026-09-30" };
    const byClient = new Map((await M.fromInvoiceByClientKey(sep)).map((r) => [r.key, r.revenue]));
    assert.deepEqual([...byClient.entries()].sort(), [["ka", 1000], ["kb", 2000], ["kd", 4000], ["kg", 7000]],
      "🔴 склад вересневого факту неправильний: готівка без рахунку, програна, ранній етап, перший вхід або 142 без подій");
    const aug = new Map((await M.fromInvoiceByClientKey({ from: "2026-08-01", to: "2026-08-31" })).map((r) => [r.key, r.revenue]));
    assert.equal(aug.get("kf"), 6000, "🔴 угода з рахунком у серпні не віднесена до серпня — анкер не за першим входом");
    const tot = await M.fromInvoiceTotal(sep);
    assert.equal(tot.revenue, 14000, "🔴 Σ ядра ≠ Σ по клієнтах");
    // Дзеркало: «успішно реалізовано» за той самий вересень — ІНША множина (саме тому підпис).
    const succ = new Map((await M.successByClientKey(sep)).map((r) => [r.key, r.revenue]));
    assert.deepEqual([...succ.keys()].sort(), ["kb", "kd", "kf"], "контроль: ① рахує інакше — інакше порівнювати нема з чим");
    // Тижні сходяться з місяцем по кожному клієнту.
    const wk = new Map<string, number>();
    for (const w of await M.fromInvoiceByClientWeek(sep)) wk.set(w.clientKey, (wk.get(w.clientKey) ?? 0) + w.revenue);
    for (const [k, v] of byClient) assert.equal(wk.get(k) ?? 0, v, `🔴 тижні ${k} не сходяться з місяцем`);
  } finally {
    const { pool } = await import("../db/pool.js").catch(() => ({ pool: null as null | { end: () => Promise<void> } }));
    await pool?.end().catch(() => {});
    await c.end();
    scratch.dispose();
  }
});

test("#717b ФАКТ З РАХУНКУ ЖИВЕ РІВНО НА ЕКРАНІ КЛІЄНТІВ і підписаний; Звіт і КВП його не беруть", () => {
  const dash = read("backend/src/routes/dashboard.ts");
  const start = dash.indexOf('dashboardRouter.get("/client-plans"');
  assert.ok(start > 0, "🔴 обробник /client-plans не впізнано");
  const body = dash.slice(start, dash.indexOf("\ndashboardRouter.", start + 10));
  assert.match(body, /money\.fromInvoiceByClientKey\(scope\),\s*money\.fromInvoiceByClientWeek\(scope\),/,
    "🔴 факт і тижні списку клієнтів не з «рахунку і далі»");
  assert.match(body, /factBasis: "fromInvoice" as const,/, "🔴 відповідь не каже, з чого факт — підпис на фронті вгадуватиме");
  // Третій вид НЕ розповзається: у роутах він трапляється лише в цьому обробнику.
  const outside = dash.slice(0, start) + dash.slice(start + body.length);
  assert.doesNotMatch(outside, /fromInvoiceBy|fromInvoiceTotal/, "🔴 факт «з рахунку» потрапив на інший екран без рішення");
  const list = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.match(list, /t\.factBasis === "fromInvoice" \? "Факт · з виставлення рахунку"/, "🔴 плитка факту не підписана «з виставлення рахунку»");
  assert.match(list, />Факт з рахунку<\/th>/, "🔴 колонка факту не підписана «з рахунку»");
});
