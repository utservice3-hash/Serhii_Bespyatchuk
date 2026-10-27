import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFeedback, feedbackDue, feedbackStats, snapshotOf, RateFeedbackError, type FeedbackRow } from "./rateFeedback.js";
import { PERMISSION_CATALOG } from "../auth/permGrant.js";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";

/**
 * 🧮 #2770–#2775 — ВІДГУК НА РОЗРАХУНОК СТАВКИ (Роман 27.10.2026): «наскільки допоміг», зведення — адмін, СЕО, ОД, КВП.
 * Чисті: функції ядра + джерела (`schema.sql`, `routes/rates.ts`, екран). Жива проба — у прийманні.
 */
const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCHEMA = SRC("../db/schema.sql");
const RATES = SRC("../../src/routes/rates.ts");
/** Список FORBIDDEN_TABLES — текстом: модуль `ai/metricTools` тягне базу, а тест мусить бігти без неї. */
const FORBIDDEN = (() => { const t = SRC("../../src/ai/metricTools.ts"); const at = t.indexOf("export const FORBIDDEN_TABLES = ["); return at < 0 ? "" : t.slice(at, t.indexOf("\n];", at)); })();
const SCREEN = SRC("../../../frontend/src/pages/dashboard/sections/RatesSimple.tsx");
/** Склад — рішення Романа 27.10.2026, дослівно: «бачать адмін, СЕО, ОД і КВП». */
const GRANTED = ["admin", "ceo", "opdir", "kvp"];
/** Тіло обробника від його оголошення до наступного `ratesRouter.` — межа змістова, не за довжиною. */
const handler = (decl: string) => {
  const at = RATES.indexOf(decl);
  assert.ok(at >= 0, `🔴 у routes/rates.ts немає «${decl}»`);
  const end = RATES.indexOf("\nratesRouter.", at + decl.length);
  return RATES.slice(at, end < 0 ? undefined : end);
};
const rejects = (b: Record<string, unknown>, status: number) => {
  assert.throws(() => parseFeedback(b), (e) => e instanceof RateFeedbackError && e.status === status, `🔴 прийнято ${JSON.stringify(b)}`);
};

test("#2770 ВІДГУК: невідома оцінка, нульова ставка й чужий формат — відмова; кожна з чотирьох оцінок і «44 000 ₴» — приймаються", () => {
  rejects({ usageId: 5, rating: "good" }, 400);
  rejects({ usageId: 5 }, 400);
  rejects({ rating: "ok" }, 400);
  rejects({ usageId: 5, rating: "ok", agreed: "0" }, 400);
  rejects({ usageId: 5, rating: "ok", agreed: "дорого" }, 400);
  for (const rating of ["ok", "high", "low", "no"]) assert.equal(parseFeedback({ usageId: 5, rating }).rating, rating);
  const f = parseFeedback({ usageId: "7", rating: "low", agreed: "44 000 ₴", comment: "  клієнт торгувався  " });
  assert.deepEqual(f, { usageId: 7, rating: "low", agreed: 44000, comment: "клієнт торгувався" });
  assert.equal(parseFeedback({ usageId: 7, rating: "ok", agreed: "44000,50" }).agreed, 44000.5);
  assert.equal(parseFeedback({ usageId: 7, rating: "ok", agreed: "", comment: "   " }).comment, null, "🔴 порожній коментар став текстом");
});

const row = (rating: FeedbackRow["rating"], agreed: number | null, tonnage: string | null, zone: string | null, extra: Partial<FeedbackRow> = {}): FeedbackRow => ({
  rating, agreed, comment: null, at: new Date("2026-10-27T10:00:00Z"), author: "Тест", frm: "Київ", tox: "Львів",
  calc: tonnage ? { client_min: 40000, client_max: 44000, tonnage, zone } : null, ...extra,
});

test("#2771 ЗВЕДЕННЯ: частка «Точно», відхилення від середини діапазону зі знаком, розбивка за авто й зоною, покриття", () => {
  const rows = [
    row("ok", 46200, "20 т (фура)", "green"),            // середина 42 000 → +10%
    row("low", 37800, "20 т (фура)", "green", { comment: "нижче", at: new Date("2026-10-26T10:00:00Z") }), // −10%
    row("high", null, "до 5 т", "red", { comment: "останній", at: new Date("2026-10-27T12:00:00Z") }),
    row("no", 50000, null, null),                          // без знімка — у відхилення не йде
  ];
  const s = feedbackStats(rows, 40);
  assert.equal(s.total, 4);
  assert.equal(s.calculations, 40);
  assert.equal(s.coverage, 10, "🔴 покриття = відгуки ÷ розрахунки");
  assert.deepEqual(s.byRating, { ok: 1, high: 1, low: 1, no: 1 });
  assert.equal(s.okShare, 25);
  assert.deepEqual(s.deviation, { avg: 0, n: 2 }, "🔴 +10% і −10% мусять дати 0 по двох — знак або середина порахована не так");
  const one = feedbackStats([rows[0]], 1);
  assert.deepEqual(one.deviation, { avg: 10, n: 1 }, "🔴 погодили дорожче за розрахунок — відхилення мусить бути «+»");
  assert.deepEqual(s.byTonnage.map((b) => [b.key, b.n, b.ok]), [["20 т (фура)", 2, 1], ["до 5 т", 1, 0], ["невідомо", 1, 0]]);
  assert.deepEqual(s.byZone.find((b) => b.key === "green"), { key: "green", n: 2, ok: 1 });
  assert.deepEqual(s.comments.map((c) => c.comment), ["останній", "нижче"], "🔴 коментарі — найновіші першими");
  assert.equal(feedbackStats([], 0).okShare, null, "🔴 без відгуків частка — невідомо, а не 0%");
  assert.equal(feedbackStats([], 0).coverage, null);
});

test("#2772 «РАЗ НА МАРШРУТ НА ДЕНЬ» РАХУЄТЬСЯ ПО-КИЇВСЬКИ: 23:59 і 00:01 — різні дні, інший маршрут — питати", () => {
  const evening = new Date("2026-10-27T21:59:00Z");   // 23:59 у Києві (UTC+2)
  const sameEvening = new Date("2026-10-27T21:59:30Z");
  const nextDay = new Date("2026-10-27T22:01:00Z");    // 00:01 28.10 у Києві, але ще 27.10 за UTC
  const prev = [{ frm: "Київ", tox: "Львів", at: evening }];
  assert.equal(feedbackDue(prev, "Київ", "Львів", sameEvening), false, "🔴 сьогодні вже відповідав на цей маршрут — питати вдруге не можна");
  assert.equal(feedbackDue(prev, "Київ", "Одеса", sameEvening), true, "🔴 інший маршрут — питати");
  assert.equal(feedbackDue(prev, "Львів", "Київ", sameEvening), true, "🔴 зворотний напрямок — інший маршрут");
  assert.equal(feedbackDue(prev, "Київ", "Львів", nextDay), true, "🔴 після київської півночі — новий день (день рахується за UTC?)");
  assert.equal(feedbackDue([], "Київ", "Львів", nextDay), true);
});

test("#2773 ПРАВО `view_rate_feedback`: у каталозі, видане рівно адмін/СЕО/ОД/КВП, зведення закрите ним і в матриці", () => {
  assert.ok((PERMISSION_CATALOG as readonly string[]).includes("view_rate_feedback"), "🔴 права немає в каталозі");
  const give = SCHEMA.match(/permissions \|\| '\{"view_rate_feedback": true\}'::jsonb\s*\n\s*WHERE key IN \(([^)]+)\)/);
  assert.ok(give, "🔴 у schema.sql немає видачі права");
  const got = give![1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  assert.deepEqual(got, [...GRANTED].sort(), "🔴 склад ролей із правом не той, що вирішив Роман");
  assert.match(SCHEMA, /permissions - 'view_rate_feedback'\s*\n\s*WHERE key NOT IN \('admin', 'ceo', 'opdir', 'kvp'\)/,
    "🔴 немає пари «зняти з решти» — право, видане вручну іншій ролі, лишиться назавжди");
  assert.match(handler('ratesRouter.get("/feedback/stats"'), /requirePerm\("view_rate_feedback"\)/, "🔴 зведення відгуків без межі права");
  const m = ACCESS_MATRIX.find((r) => r.method === "GET" && r.path === "/api/rates/feedback/stats");
  assert.ok(m, "🔴 зведення відгуків не в матриці доступу");
  assert.deepEqual([...m!.allow].sort(), [...GRANTED].sort());
  for (const no of ["financier", "manager", "team_lead", "hr"]) assert.ok(m!.deny.includes(no), `🔴 «${no}» не в deny зведення`);
  assert.ok(ACCESS_MATRIX.some((r) => r.method === "POST" && r.path === "/api/rates/feedback"), "🔴 запис відгуку не в матриці");
});

test("#2774 ВІДГУК ЛИШЕ НА СВІЙ РОЗРАХУНОК, ЧИСЛА — ЗІ ЗНІМКА СЕРВЕРА; таблиця закрита для AI", () => {
  const post = handler('ratesRouter.post("/feedback"');
  assert.match(post, /FROM lardi_usage WHERE id = \$1 AND user_id = \$2`, \[f\.usageId, req\.auth!\.userId\]/,
    "🔴 відгук можна причепити до чужого розрахунку");
  assert.doesNotMatch(post, /req\.body[^;]*\b(client_min|calc|zone)\b/, "🔴 числа розрахунку беруться з браузера, а не зі знімка");
  assert.match(handler('ratesRouter.post("/analyze"'), /UPDATE lardi_usage SET calc = \$2 WHERE id = \$1/, "🔴 розрахунок не зберігає показані числа");
  const zone = { zone: "green", options: [
    { tonnage: "до 5 т", selected: false, client_min: 1, client_max: 2, total_min: 1, total_max: 1, margin: 3000, per_km_min: 40, per_km_max: 45 },
    { tonnage: "20 т (фура)", selected: true, client_min: 42590, client_max: 45275, total_min: 37590, total_max: 40275, margin: 5000, per_km_min: 70, per_km_max: 75 },
  ] };
  const snap = snapshotOf({ mass_min: 18, mass_max: 22, body_type_ids: [] }, 537, zone);
  assert.deepEqual([snap.tonnage, snap.client_min, snap.client_max, snap.carrier_max, snap.margin, snap.zone, snap.distance_km],
    ["20 т (фура)", 42590, 45275, 40275, 5000, "green", 537], "🔴 знімок узяв не обраний рядок зонної карти");
  assert.equal(snapshotOf({ mass_min: null, mass_max: null, body_type_ids: [] }, null, null).client_min, null, "🔴 без зонної карти — невідомо, а не 0");
  assert.match(FORBIDDEN, /"rate_feedback",/, "🔴 відгуки не в FORBIDDEN_TABLES");
  assert.match(SCHEMA, /REVOKE ALL ON rate_feedback FROM ai_readonly;/, "🔴 відгуки не відібрані в ai_readonly");
});

test("#2775 ЕКРАН: відгук виїжджає через 15 с і лише коли сервер каже «питати»", () => {
  assert.match(SCREEN, /const FEEDBACK_DELAY_MS = 15_000;/, "🔴 затримка відгуку не 15 с");
  assert.match(SCREEN, /if \(!data\?\.feedback_due\) return;\s*\n\s*const t = setTimeout\(\(\) => setFbOpen\(true\), FEEDBACK_DELAY_MS\);/,
    "🔴 відгук виїжджає без «питати» від сервера — раз на маршрут на день не тримається");
  assert.match(SCREEN, /sendRateFeedback\(\{ usageId: data\.usage_id/, "🔴 відгук не надсилається на сервер");
});

test("#2777 ЕКРАН: форма з полями міст — вище за сусідні картки, підказки не ховаються під «Нещодавні» й результатом", () => {
  const at = SCREEN.indexOf("<TownField label=\"Звідки\"");
  assert.ok(at > 0, "🔴 поля «Звідки» на екрані немає");
  const open = SCREEN.lastIndexOf("<div ", at);
  const tag = SCREEN.slice(open, SCREEN.indexOf(">", open) + 1);
  assert.match(tag, /position: "relative", zIndex: 5/, "🔴 форма не піднята над сусідами — підказки міст знову під «Нещодавні»");
});
