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
  assert.ok(text[0].includes(`${n.qualifyLifetimeMin}+ оплат`) && text[0].includes(`${n.qualifyRhythmDays} днів`), "🔴 правило «постійного» не з констант qualifiesAsRepeat");
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
