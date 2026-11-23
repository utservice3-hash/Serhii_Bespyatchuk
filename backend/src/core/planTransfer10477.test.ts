import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsDb, planGraceSkip } from "../testMode.js";
import {
  PLAN_POOL_FROM_MONTH, canTransferPlan, monthOpenForTransfer, poolApplies, splitEqually, transferAmount, transferVerdict,
} from "./planTransferRules.js";

/**
 * 🔁 ПЕРЕДАЧА ПЛАНУ МЕНЕДЖЕРА, ЯКИЙ ПІШОВ (задача 10477, 23.11.2026). План того, хто пішов, більше не ділиться сам на
 * всю команду, а лежить у пулі «не розподілено», поки КВП не передасть його обраним менеджерам. Гейти стережуть дві
 * речі: передача не міняє план команди, і жоден екран не «худне» на план, який ні на кому не лежить.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const roster = new Set([1, 2, 3, 4]);

test("#4030 ПОДІЛ ПОРІВНУ: сума частин завжди дорівнює плану, залишок від ділення не губиться", () => {
  assert.deepEqual(splitEqually(30000, 3), [10000, 10000, 10000]);
  // По другий бік межі: число, що не ділиться націло. Саме тут гривня губилась би при округленні кожної частини.
  const odd = splitEqually(10000, 3);
  assert.deepEqual(odd, [3334, 3333, 3333]);
  assert.equal(odd.reduce((a, b) => a + b, 0), 10000, "🔴 після поділу порівну сума не дорівнює плану - план команди зрушив би");
  assert.deepEqual(splitEqually(100, 0), [], "ділити ні на кого - порожньо, а не ділення на нуль");
});

test("#4031 ПЕРЕДАЧА НЕ МІНЯЄ ПЛАН КОМАНДИ: сума частин мусить точно дорівнювати тому, що передаємо", () => {
  const ok = transferVerdict({ pool: 30000, fact: 8400, mode: "all", roster, parts: [{ managerId: 1, amount: 10000 }, { managerId: 2, amount: 10000 }, { managerId: 3, amount: 10000 }] });
  assert.deepEqual(ok, { ok: true, amount: 30000, keep: 0, parts: [{ managerId: 1, amount: 10000 }, { managerId: 2, amount: 10000 }, { managerId: 3, amount: 10000 }] });
  // 🪞 Дзеркало: на гривню менше і на гривню більше - обидва відмова, інакше різниця тихо зникла б із плану команди.
  for (const last of [9999, 10001]) {
    const bad = transferVerdict({ pool: 30000, fact: 0, mode: "all", roster, parts: [{ managerId: 1, amount: 10000 }, { managerId: 2, amount: 10000 }, { managerId: 3, amount: last }] });
    assert.equal(bad.ok, false, `🔴 передача на ${20000 + last} з 30000 пройшла - план команди зрушив би на різницю`);
  }
  // «Тільки залишок»: зароблене лишається за тим, хто пішов, тож передане + лишене = увесь його план.
  const rest = transferVerdict({ pool: 30000, fact: 8400, mode: "rest", roster, parts: [{ managerId: 1, amount: 21600 }] });
  assert.ok(rest.ok && rest.amount === 21600 && rest.keep === 8400, "🔴 у режимі «залишок» передане і лишене не складаються в план");
  assert.equal(transferAmount(30000, 45000, "rest"), 0, "факт більший за план - залишку немає, а не відʼємна сума");
  assert.equal(transferVerdict({ pool: 30000, fact: 45000, mode: "rest", roster, parts: [{ managerId: 1, amount: 1 }] }).ok, false);
});

test("#4032 КОМУ ПЕРЕДАЄМО: лише менеджери тієї самої команди, кожен один раз, ціла сума більше нуля", () => {
  const base = { pool: 30000, fact: 0, mode: "all" as const, roster };
  assert.equal(transferVerdict({ ...base, parts: [{ managerId: 99, amount: 30000 }] }).ok, false, "🔴 план пішов менеджеру поза командою");
  assert.equal(transferVerdict({ ...base, parts: [{ managerId: 1, amount: 15000 }, { managerId: 1, amount: 15000 }] }).ok, false, "🔴 один менеджер двічі");
  assert.equal(transferVerdict({ ...base, parts: [{ managerId: 1, amount: 30000 }, { managerId: 2, amount: 0 }] }).ok, false, "🔴 нульова частина");
  assert.equal(transferVerdict({ ...base, parts: [{ managerId: 1, amount: 29999.5 }, { managerId: 2, amount: 0.5 }] }).ok, false, "🔴 дробова сума");
  assert.equal(transferVerdict({ ...base, parts: [] }).ok, false);
  assert.equal(transferVerdict({ ...base, pool: 0, parts: [{ managerId: 1, amount: 1 }] }).ok, false, "🔴 передача з порожнього пулу");
  // 🪞 Дзеркало: один отримувач зі своєї команди на всю суму - дозволено (ТЗ: «можна 1, 2, 3 і більше людей»).
  assert.equal(transferVerdict({ ...base, parts: [{ managerId: 4, amount: 30000 }] }).ok, true);
});

test("#4033 ХТО І КОЛИ: передає лише КВП і адмін; закритий місяць і місяці до листопада 2026 не рухаються", () => {
  for (const roleKey of ["kvp", "admin"]) assert.equal(canTransferPlan({ roleKey }), true, `🔴 ${roleKey} не може передати план`);
  for (const roleKey of ["team_lead", "manager", "ceo", "opdir", "financier", "hr", null]) {
    assert.equal(canTransferPlan({ roleKey }), false, `🔴 ${roleKey} може передати план сам`);
  }
  // Межа з обох боків: жовтень ще з автоподілом, листопад уже з пулом.
  assert.equal(PLAN_POOL_FROM_MONTH, "2026-11-01");
  assert.equal(poolApplies("2026-10-01"), false, "🔴 пул поширився на жовтень - закритий місяць зрушив би заднім числом");
  assert.equal(poolApplies("2026-11-01"), true);
  assert.equal(poolApplies("2026-11"), true);
  assert.equal(monthOpenForTransfer("2026-11-01", "2026-11-01"), true);
  assert.equal(monthOpenForTransfer("2026-12-01", "2026-11-01"), true, "наступний місяць передавати можна");
  assert.equal(monthOpenForTransfer("2026-11-01", "2026-12-01"), false, "🔴 план закритого місяця можна передати");
  assert.equal(monthOpenForTransfer("2026-10-01", "2026-10-01"), false, "🔴 місяць до пулу можна передати");

  // Проводка: у обох роутах право перевіряється ПЕРШОЮ дією, до розбору тіла й до будь-якого запису.
  const r = src("backend/src/routes/plans.ts");
  for (const route of ['plansRouter.post("/transfer", ', 'plansRouter.post("/transfer/drop", ']) {
    const at = r.indexOf(route);
    assert.ok(at > 0, `роут ${route} зник`);
    const body = r.slice(at, r.indexOf("\n});", at));
    const guard = body.indexOf("if (!canTransferPlan(auth)) return res.status(403)");
    const parse = body.indexOf(".safeParse(req.body)");
    const write = Math.max(body.indexOf("applyTransfer("), body.indexOf("dropPool("));
    assert.ok(guard > 0 && guard < parse && parse < write, `🔴 ${route}: право перевіряється не першим - 403 став би 400 або запис пройшов би без права`);
    assert.ok(body.indexOf("monthOpenForTransfer(month, kyivToday())") < write, `🔴 ${route}: закритий місяць не відсікається до запису`);
  }
  // Запис іде однією транзакцією, і рядок того, хто пішов, блокується до перечитування пулу.
  const core = src("backend/src/core/planTransfer.ts");
  const apply = core.slice(core.indexOf("export async function applyTransfer"), core.indexOf("export async function dropPool"));
  assert.ok(apply.indexOf("FOR UPDATE") > 0 && apply.indexOf("FOR UPDATE") < apply.indexOf("gonePlans(mo, null, client"),
    "🔴 пул читається до замка - двоє КВП роздадуть той самий план двічі");
  assert.ok(apply.indexOf('await client.query("BEGIN")') < apply.indexOf("INSERT INTO plans") && apply.indexOf("INSERT INTO plans") < apply.indexOf('await client.query("COMMIT")'));
});

test("#4034 ЖИВА БД: план команди = Σ менеджерів + «не розподілено»; з листопада 2026 чужий план ні на кому сам не лежить", needsDb(), async (t) => {
  const { managerPlan } = await import("./plans.js");
  const { gonePlans } = await import("./planTransfer.js");
  const { teamAtSql, sqlDate } = await import("./teamAt.js");
  const { pool } = await import("../db/pool.js");
  const month = (await pool.query<{ d: string }>(
    `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv'),'YYYY-MM-DD') d`)).rows[0].d;
  if (!poolApplies(month)) return t.skip("місяць до листопада 2026 - пулу ще немає");

  const mp = await managerPlan({ month });
  const raw = (await pool.query<{ team_id: number; s: string }>(
    `SELECT ${teamAtSql("m", sqlDate(month))} AS team_id, COALESCE(SUM(p.planned_value),0) s
       FROM plans p JOIN managers m ON m.id = p.manager_id
      WHERE p.metric = 'payment_amount' AND date_trunc('month', p.plan_date) = $1::date
        AND ${teamAtSql("m", sqlDate(month))} IS NOT NULL
      GROUP BY 1`, [month])).rows;
  const graced = planGraceSkip("команд із ненульовим планом місяця", raw.filter((r) => Number(r.s) > 0).length);
  if (graced) return t.skip(graced);
  assert.ok(raw.some((r) => Number(r.s) > 0), "🔴 у місяці немає жодного плану - рівність зійшлась би тривіально");

  assert.deepEqual(mp.rows.filter((r) => r.sharePlan !== 0).map((r) => `${r.name}: +${r.sharePlan}`), [],
    "🔴 на менеджерах знову лежить частка плану тих, хто пішов - автоподіл повернувся");
  const byTeam = new Map<number, number>();
  for (const r of mp.rows) if (r.teamId != null) byTeam.set(r.teamId, (byTeam.get(r.teamId) ?? 0) + r.plan);
  for (const [tid, v] of mp.orphanPlanByTeam) byTeam.set(tid, (byTeam.get(tid) ?? 0) + v);
  const drift = raw.filter((r) => Math.round(Number(r.s)) !== (byTeam.get(r.team_id) ?? 0))
    .map((r) => `команда ${r.team_id}: у plans ${Math.round(Number(r.s))}, на екранах ${byTeam.get(r.team_id) ?? 0}`);
  assert.deepEqual(drift, [], "🔴 план команди на екранах не дорівнює сумі в plans - чийсь план зник або подвоївся:\n  " + drift.join("\n  "));

  // «Не розподілено» з поіменного списку + лишене за людьми = те саме, що ядро віддає екранам одним числом.
  const gone = await gonePlans(month, null);
  const goneByTeam = new Map<number, number>();
  for (const g of gone) goneByTeam.set(g.teamId, (goneByTeam.get(g.teamId) ?? 0) + g.plan);
  for (const [tid, v] of mp.orphanPlanByTeam) {
    assert.equal(goneByTeam.get(tid) ?? 0, v, `🔴 команда ${tid}: поіменний список тих, хто пішов, не складається в число «не розподілено»`);
  }
  for (const g of gone) assert.ok(g.pool >= 0 && g.kept >= 0 && g.pool + g.kept === g.plan, `🔴 ${g.name}: пул + лишене ≠ план`);
});

test("#4035 🪞 ЕКРАНИ НЕ ХУДНУТЬ: Звіт і «Плани» додають план тих, хто пішов, до суми рядків; фронт ділить так само, як сервер", () => {
  // Сервер: план у шапці Звіту = Σ рядків + план тих, хто пішов; план менеджера без чужої частки з листопада.
  const dash = src("backend/src/routes/dashboard.ts");
  assert.match(dash, /plan: managers\.reduce\(\(s, m\) => s \+ m\.plan, 0\) \+ \(managerId \? 0 : gonePlanTotal\),/,
    "🔴 шапка Звіту рахує план лише з рядків менеджерів - команда схудне на план тих, хто пішов");
  const core = src("backend/src/core/plans.ts");
  assert.match(core, /for \(const \[tid, members\] of pooled \? \[\] : activeByTeam\)/, "🔴 автоподіл у ядрі більше не вимикається пулом");
  assert.match(core, /if \(tid != null && \(pooled \|\| a\.nactive === 0\) && a\.deact > 0\) orphanPlanByTeam\.set\(tid, a\.deact\);/,
    "🔴 план тих, хто пішов, не потрапляє в «не розподілено» - він зник би з плану команди");
  // Фронт: підсумковий рядок таблиці Звіту і злиття кількох команд.
  assert.match(src("frontend/src/pages/dashboard/sections/ReportTableSection.tsx"), /col\.key === "plan" && f0\.value != null \? \{ \.\.\.f0, value: f0\.value \+ planGone \}/,
    "🔴 підсумок плану в таблиці Звіту без плану тих, хто пішов");
  assert.match(src("frontend/src/pages/dashboard/reportScope.ts"), /"planGone",/, "🔴 при виборі 2+ команд план тих, хто пішов, береться лише з першої");
  assert.match(src("frontend/src/pages/dashboard/sections/PlanFormationSection.tsx"), /issuedOf\(m, drafts\), 0\) \+ \(team\.gonePlan \?\? 0\)\)/,
    "🔴 план команди в «Плани» без плану тих, хто пішов");
  // Правила поділу на фронті - ті самі, що на сервері: інакше «Зберегти» активна там, де сервер відмовить.
  const front = src("frontend/src/pages/dashboard/planTransferRule.ts"), back = src("backend/src/core/planTransferRules.ts");
  const fn = (text: string, name: string) => { const at = text.indexOf(`export function ${name}(`); return text.slice(text.indexOf("{\n", at), text.indexOf("\n}\n", at)); };
  for (const name of ["splitEqually", "transferAmount"]) {
    assert.ok(fn(front, name).length > 20 && fn(front, name) === fn(back, name), `🔴 ${name} на фронті й на сервері розійшлись`);
  }
  assert.match(src("frontend/src/pages/dashboard/sections/PlanTransferBlock.tsx"), /disabled=\{!ready \|\| busy\} onClick=\{save\}/,
    "🔴 «Зберегти» активна, коли сума частин не дорівнює плану");
});
