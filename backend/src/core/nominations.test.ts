/**
 * 🏆 НОМІНАЦІЇ ТИЖНЯ — гейти правил і джерела чисел (21.09.2026).
 * Прогін роутів і незмінність знімка проти бази з нуля — `routes/nominations.test.ts` (#602).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsApi, API_BASE } from "../testMode.js";
import {
  rankNominees, applyReview, fingerprint, canReview, validateReview, weekOf, lastWeek, isFreezeDue, kyivDate, deptWinners,
  NOMINATIONS, type Ranked,
} from "./nominationRules.js";

const SRC = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url).href.replace("/dist/", "/src/"));

/* ─────────────────────────── #598 джерело чисел ─────────────────────────── */

/**
 * #598 — ЧИСЛА НОМІНАЦІЙ == ЗВІТ за той самий тиждень (зовнішня звірка через HTTP).
 * «Результат» кожної команди мусить дорівнювати найбільшому «Факту» `/report-plan` серед її
 * менеджерів, «авто» — найбільшій колонці «Авто», і переможці — саме ті люди. Червоніє, якщо
 * номінацію перевести на інше джерело (① замість «Факту», свій SQL, інший ростер).
 */
test("#598 результат і авто номінацій == «Факт» і «Авто» Звіту за той самий тиждень", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const { from, to } = lastWeek(new Date());
  const H = { headers: { Authorization: `Bearer ${token}` } };
  const [nr, rr] = await Promise.all([
    fetch(`${API_BASE}/api/nominations/week?weekFrom=${from}`, H),
    fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, H),
  ]);
  assert.equal(nr.status, 200, `🔴 /nominations/week віддав ${nr.status}`);
  assert.equal(rr.status, 200, `🔴 /report-plan віддав ${rr.status}`);
  type Cell = { nomination: string; crm: Ranked };
  const nom = await nr.json() as { teams: { teamId: number; members: { id: number }[]; cells: Cell[] }[] };
  const rep = await rr.json() as { managers: { managerId: number; fact: number; kpi: { dispatch: { fact: number } } }[] };
  const byId = new Map(rep.managers.map((m) => [m.managerId, m]));
  assert.ok(nom.teams.length >= 2, "🔴 у заліку менше двох команд — звіряти нічого");
  const off: string[] = [];
  let compared = 0;
  for (const t of nom.teams) {
    for (const m of t.members) if (!byId.has(m.id)) off.push(`менеджер ${m.id} у заліку, але не в ростері Звіту`);
    for (const [key, pick] of [["revenue", (id: number) => byId.get(id)?.fact ?? 0], ["cars", (id: number) => byId.get(id)?.kpi.dispatch.fact ?? 0]] as const) {
      const cell = t.cells.find((c) => c.nomination === key)!;
      const vals = t.members.map((m) => ({ id: m.id, v: pick(m.id) })).filter((x) => x.v > 0);
      if (vals.length === 0) { if (cell.crm.state !== "empty") off.push(`${t.teamId}/${key}: Звіт порожній, номінація — ні`); continue; }
      const best = Math.max(...vals.map((x) => x.v));
      const winners = vals.filter((x) => x.v === best).map((x) => x.id).sort((a, b) => a - b);
      compared++;
      if (cell.crm.state !== "ok") { off.push(`${t.teamId}/${key}: номінація порожня, Звіт дає ${best}`); continue; }
      if (Math.round(cell.crm.value) !== best) off.push(`${t.teamId}/${key}: ${cell.crm.value} ≠ Звіт ${best}`);
      // «Факт» Звіту округлений до гривні: нічия там може бути, де в копійках її немає — тоді
      // переможці номінації ⊆ переможців Звіту, а не рівні.
      if (!cell.crm.winners.every((w) => winners.includes(w))) off.push(`${t.teamId}/${key}: переможці ${cell.crm.winners} ≠ Звіт ${winners}`);
    }
  }
  assert.ok(compared > 0, "🔴 жодна номінація не мала з чим звірятись — перевірка вироджена");
  assert.deepEqual(off, [], "🔴 номінації розійшлись зі Звітом за той самий тиждень");
});

/**
 * #599 — У `core/nominations.ts` НЕМАЄ SQL ПО УГОДАХ І ГРОШАХ. Числа — лише з ядра. Читає вміст
 * шаблонних рядків (там живе SQL) і червоніє на `deals`, `price`, `deal_stage_events`.
 */
test("#599 номінації не мають власного SQL по угодах і грошах — лише ядро", () => {
  const src = readFileSync(SRC("core/nominations.ts"), "utf8");
  const sql = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]).filter((s) => /\b(SELECT|INSERT|FROM)\b/.test(s));
  assert.ok(sql.length >= 3, "🔴 не знайдено SQL-рядків у файлі — гейт втратив предмет (ростер, знімок)");
  const bad = sql.filter((s) => /\bdeals\b|\bprice\b|deal_stage_events/.test(s));
  assert.deepEqual(bad, [], "🔴 у номінаціях зʼявився свій SQL по угодах/грошах — брати ЛИШЕ з core/money.ts і core/metrics.ts");
  for (const fn of ["money.receivedDealStatsByMgr", "metrics.dispatchedByManager"]) {
    assert.ok(src.includes(fn), `🔴 номінації більше не кличуть ${fn} — звідки тоді число?`);
  }
});

/* ─────────────────────────── #600 переможець ─────────────────────────── */

test("#600 переможець: нічия — усі; нулі й сторно — не перемога; порожньо — чесний стан", () => {
  // Нічия — УСІ (рішення 21.09.2026), навіть у копійках, що різняться лише шумом float.
  assert.deepEqual(rankNominees([{ managerId: 5, value: 0.1 + 0.2 }, { managerId: 3, value: 0.3 }, { managerId: 9, value: 0.2 }]),
    { state: "ok", value: 0.3, winners: [3, 5] });
  // 🪞 Дзеркало нічиєї: різні значення — один переможець.
  assert.deepEqual(rankNominees([{ managerId: 1, value: 7 }, { managerId: 2, value: 6 }]), { state: "ok", value: 7, winners: [1] });
  // Нуль — «не набрав»: усі нулі = порожньо, а не «переможець із нулем».
  assert.deepEqual(rankNominees([{ managerId: 1, value: 0 }, { managerId: 2, value: null }]), { state: "empty" });
  // Від'ємна маржа (сторно) не перемагає, навіть коли вона єдина…
  assert.deepEqual(rankNominees([{ managerId: 1, value: -5320 }]), { state: "empty" });
  // …а поруч із позитивним програє йому.
  assert.deepEqual(rankNominees([{ managerId: 1, value: -5320 }, { managerId: 2, value: 1 }]), { state: "ok", value: 1, winners: [2] });
  assert.deepEqual(rankNominees([]), { state: "empty" });
});

test("#600b рішення тімліда: підтвердження тримається, доки CRM той самий; виправлення — завжди з причиною", () => {
  const crm: Ranked = { state: "ok", value: 18, winners: [7] };
  const confirm = { action: "confirm" as const, crmFingerprint: fingerprint(crm), overrideManagerIds: null, overrideValue: null, reason: null };
  assert.equal(applyReview(crm, confirm).status, "confirmed");
  assert.equal(applyReview(crm, null).status, "unconfirmed", "🔴 без рішення рядок мусить бути «не підтверджено»");
  // CRM змінився після підтвердження → знову не підтверджено, і видно чому.
  const moved = applyReview({ state: "ok", value: 19, winners: [7] }, confirm);
  assert.equal(moved.status, "unconfirmed");
  assert.equal(moved.stale, true, "🔴 протухле підтвердження мусить бути позначене");
  const ov = { action: "override" as const, crmFingerprint: fingerprint(crm), overrideManagerIds: [9], overrideValue: 37, reason: "завантажили в неділю" };
  const f = applyReview(crm, ov);
  assert.equal(f.status, "overridden");
  assert.deepEqual([f.winners, f.value], [[9], 37]);
  assert.equal(applyReview({ state: "empty" }, null).status, "empty", "🔴 порожня номінація не стає «0» і не отримує переможця");
});

test("#600c переможець відділу — найкращий серед переможців команд, нічия між командами — усі", () => {
  const rows = [
    { teamId: 13, dept: "rnk" as const, winners: [1], value: 24580 },
    { teamId: 15, dept: "rnk" as const, winners: [2, 3], value: 24580 },
    { teamId: 5, dept: "rpk" as const, winners: [4], value: 99999 },
  ];
  assert.deepEqual(deptWinners(rows, "rnk"), { state: "ok", value: 24580, winners: [1, 2, 3], teams: [13, 15] });
  assert.deepEqual(deptWinners(rows, "rpk"), { state: "ok", value: 99999, winners: [4], teams: [5] });
  assert.deepEqual(deptWinners([{ teamId: 5, dept: "rpk", winners: [], value: null }], "rpk"), { state: "empty" });
});

/* ─────────────────────────── #601 тиждень за Києвом ─────────────────────────── */

test("#601 тиждень Пн–Нд і фіксація вівторок 08:00 — за Києвом, обидва боки межі", () => {
  // Нд 20.09 23:30 Києва = 20:30 UTC — ще цей тиждень; Пн 21.09 00:30 Києва = Нд 21:30 UTC — уже наступний.
  assert.deepEqual(weekOf(kyivDate(new Date("2026-09-20T20:30:00Z"))), { from: "2026-09-14", to: "2026-09-20" });
  assert.deepEqual(weekOf(kyivDate(new Date("2026-09-20T21:30:00Z"))), { from: "2026-09-21", to: "2026-09-27" });
  assert.deepEqual(lastWeek(new Date("2026-09-22T06:00:00Z")), { from: "2026-09-14", to: "2026-09-20" });
  // Фіксація: вт 22.09 07:59 Києва — ще ні, 08:00 — так; понеділок — ні, середа — так.
  assert.equal(isFreezeDue("2026-09-14", new Date("2026-09-22T04:59:00Z")), false);
  assert.equal(isFreezeDue("2026-09-14", new Date("2026-09-22T05:00:00Z")), true);
  assert.equal(isFreezeDue("2026-09-14", new Date("2026-09-21T09:00:00Z")), false);
  assert.equal(isFreezeDue("2026-09-14", new Date("2026-09-23T01:00:00Z")), true);
  // Зимовий час (UTC+2): Нд 25.10 після переходу — межа та сама, за Києвом.
  assert.deepEqual(weekOf(kyivDate(new Date("2026-10-25T21:59:00Z"))), { from: "2026-10-19", to: "2026-10-25" });
  assert.deepEqual(weekOf(kyivDate(new Date("2026-10-25T22:00:00Z"))), { from: "2026-10-26", to: "2026-11-01" });
});

/* ─────────────────────────── #603 права й тіло запиту ─────────────────────────── */

test("#603 хто може підтвердити: тімлід — свою команду і не про себе; керівництво — усе", () => {
  const lead = { role: "team_lead", teamId: 13, managerId: 103 };
  assert.equal(canReview(lead, { teamId: 13, crmWinners: [101] }).ok, true, "🔴 тімлід не може підтвердити свою команду");
  assert.equal(canReview(lead, { teamId: 15, crmWinners: [201] }).ok, false, "🔴 тімлід підтверджує чужу команду");
  assert.equal(canReview(lead, { teamId: 13, crmWinners: [103] }).ok, false, "🔴 тімлід підтверджує рядок про себе");
  assert.equal(canReview(lead, { teamId: 13, crmWinners: [101], overrideManagerIds: [103] }).ok, false, "🔴 тімлід виправляє переможця на себе");
  // 🪞 Дзеркало: керівництво може і про тімліда, і будь-яку команду.
  assert.equal(canReview({ role: "admin", teamId: null, managerId: null }, { teamId: 13, crmWinners: [103] }).ok, true);
  assert.equal(canReview({ role: "manager", teamId: 13, managerId: 101 }, { teamId: 13, crmWinners: [201] }).ok, false);
});

test("#603b виправлення без причини, переможця або числа — відмова; підтвердження — без них", () => {
  const base = { weekFrom: "2026-09-14", teamId: 13, nomination: "cars" };
  assert.equal(validateReview({ ...base, action: "confirm" }).ok, true);
  assert.equal(validateReview({ ...base, action: "override", overrideManagerIds: [101], overrideValue: 37 }).ok, false, "🔴 виправлення без причини пройшло");
  assert.equal(validateReview({ ...base, action: "override", overrideManagerIds: [101], overrideValue: 37, reason: "  " }).ok, false, "🔴 причина з пробілів пройшла");
  assert.equal(validateReview({ ...base, action: "override", overrideManagerIds: [], overrideValue: 37, reason: "бо так" }).ok, false);
  assert.equal(validateReview({ ...base, action: "override", overrideManagerIds: [101], overrideValue: 0, reason: "бо так" }).ok, false);
  assert.equal(validateReview({ ...base, weekFrom: "2026-09-15", action: "confirm" }).ok, false, "🔴 тиждень не з понеділка");
  assert.equal(validateReview({ ...base, nomination: "другое", action: "confirm" }).ok, false);
  // 🪞 Дзеркало: повне виправлення проходить.
  const ok = validateReview({ ...base, action: "override", overrideManagerIds: [101, 101], overrideValue: "37", reason: " завантажили в неділю " });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.value.overrideManagerIds, ok.value.overrideValue, ok.value.reason], [[101], 37, "завантажили в неділю"]);
});

/* ─────────────────────────── #604 знімок тримає обидва числа ─────────────────────────── */

test("#604 рядок знімка тримає фінальне число І число CRM поруч; порожня номінація — рядок без переможця", async () => {
  const { snapshotRows } = await import("./nominationRules.js");
  const view = {
    weekFrom: "2026-09-14", weekTo: "2026-09-20", state: "draft" as const, frozenAt: null, ruleVersion: "x", freezeDueAt: "",
    depts: [], names: { 101: "Андрусенко", 102: "Цалко" },
    teams: [{ teamId: 13, teamName: "РНК", dept: "rnk" as const, members: [], noCostDeals: 2, cells: [
      { nomination: "cars" as const, crm: { state: "ok" as const, value: 31, winners: [101] }, deal: null,
        final: { status: "overridden" as const, winners: [102], value: 37, reason: "неділя", stale: false } },
      { nomination: "intl" as const, crm: { state: "empty" as const }, deal: null,
        final: { status: "empty" as const, winners: [] as [], value: null, reason: null, stale: false } },
    ] }],
  };
  const rows = snapshotRows(view);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].managerId, rows[0].value, rows[0].crmValue, rows[0].crmManagerIds, rows[0].reason], [102, 37, 31, [101], "неділя"],
    "🔴 виправлене число витіснило число CRM зі знімка — розбіжність більше не видно");
  assert.deepEqual([rows[1].managerId, rows[1].value, rows[1].status], [null, null, "empty"]);
  assert.equal(NOMINATIONS.length, 5);
});
