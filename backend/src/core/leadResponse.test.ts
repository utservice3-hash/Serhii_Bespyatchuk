import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skipReason } from "../db/scratchDb.js";
import { kyivAt } from "./leadTakeRules.js";
import {
  firstDial, answerOf, responseMinutes, responseStats, buildResponseTable, responseRowsSql, FIRST_CALL_UPDATE_SQL,
  type ResponseRawRow,
} from "./leadResponseRules.js";

/**
 * 📞 «ВІДПОВІДЬ НА ЗАЯВКУ» (задача 5148): від створення заявки до першого набору — медіана, нічні від 08:15, лідгени
 * окремо, «не взяв трубку» = перший набір 0 с.
 */
const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const SRC = (p: string) => readFileSync(srcOf(`../${p}`), "utf8");
const FE = (p: string) => readFileSync(srcOf(`../../../frontend/src/${p}`), "utf8");
const MIN = 60_000;
// Вівторок 06.10.2026: 10:00 — робочий час; 23:00 — неробочий (годинник з 08:15 середи 07.10).
const TUE10 = kyivAt(2026, 10, 6, 10, 0);
const TUE23 = kyivAt(2026, 10, 6, 23, 0);
const WED0815 = kyivAt(2026, 10, 7, 8, 15);

test("#1550 ПЕРШИЙ НАБІР: найраніший із Kommo й Ringostat, тривалість — САМЕ його; 0 с — не взяв трубку, невідомо — не нуль", () => {
  assert.deepEqual(firstDial({ at: TUE10 + 5 * MIN, sec: 40 }, { at: TUE10 + 2 * MIN, sec: 0 }), { at: TUE10 + 2 * MIN, sec: 0 },
    "🔴 перший набір узято не найраніший (або з тривалістю іншого дзвінка)");
  assert.deepEqual(firstDial({ at: TUE10 + 2 * MIN, sec: null }, { at: null, sec: null }), { at: TUE10 + 2 * MIN, sec: null });
  assert.equal(firstDial({ at: null, sec: null }, { at: null, sec: null }), null);
  assert.equal(answerOf(0), "no", "🔴 набір без відповіді не впізнано");
  assert.equal(answerOf(1), "yes");
  assert.equal(answerOf(null), "unknown", "🔴 невідома тривалість прочитана як «не взяв трубку»");
});

test("#1550b ГОДИННИК: робоча заявка — від створення; нічна — від 08:15; набір до 08:15 — нуль хвилин, а не мінус", () => {
  assert.equal(responseMinutes({ createdAt: TUE10, dial: { at: TUE10 + 7 * MIN, sec: 30 } }), 7);
  assert.equal(responseMinutes({ createdAt: TUE23, dial: { at: WED0815 + 3 * MIN, sec: 30 } }), 3,
    "🔴 нічна заявка рахується від створення, а не від 08:15 — відділ виглядав би повільним через ніч");
  assert.equal(responseMinutes({ createdAt: TUE23, dial: { at: TUE23 + 10 * MIN, sec: 30 } }), 0, "🔴 набір уночі дав відʼємні хвилини");
  assert.equal(responseMinutes({ createdAt: TUE10, dial: null }), null);
  assert.equal(responseMinutes({ createdAt: TUE10, dial: { at: TUE10 - MIN, sec: 30 } }), null, "🔴 дзвінок до створення заявки зарахований як відповідь");
});

test("#1550c ПІДСУМОК: медіана (не середнє), «до 5 хв» — від усіх заявок, без набору й «не взяв трубку» окремо", () => {
  const rows = [1, 2, 3, 4, 1440].map((m, i) => ({ createdAt: TUE10, dial: { at: TUE10 + m * MIN, sec: i === 0 ? 0 : i === 1 ? null : 20 } }));
  const s = responseStats([...rows, { createdAt: TUE10, dial: null }]);
  assert.equal(s.medianMin, 3, "🔴 замість медіани — середнє (було б 290)");
  assert.equal(s.n, 6); assert.equal(s.dialed, 5); assert.equal(s.notDialed, 1);
  assert.equal(s.m5Pct, 66.7, "🔴 «до 5 хв» рахується не від усіх заявок");
  assert.equal(s.noAnswer, 1); assert.equal(s.answerUnknown, 1);
  assert.equal(responseStats([]).medianMin, null);
});

test("#1550d ІЄРАРХІЯ: лідгени не входять у відділ, але мають свій рядок; Σ команд = відділ; Σ менеджерів = команда", () => {
  const r = (kind: "main" | "leadgen", teamId: number | null, managerId: number | null, m: number): ResponseRawRow => ({
    kind, teamId, team: teamId == null ? null : `Команда ${teamId}`, managerId, manager: managerId == null ? null : `М${managerId}`,
    createdAt: TUE10, dial: { at: TUE10 + m * MIN, sec: 20 },
  });
  const t = buildResponseTable([r("main", 1, 11, 1), r("main", 1, 12, 3), r("main", 2, 21, 5), r("main", null, null, 2),
    r("leadgen", 3, 31, 600), r("leadgen", 3, 32, 900)]);
  assert.equal(t.dept.n, 4, "🔴 лідгени потрапили у відділ — його медіану тягнуть угору");
  assert.equal(t.dept.medianMin, 2.5);
  assert.equal(t.teams.reduce((a, x) => a + x.n, 0), t.dept.n, "🔴 Σ команд ≠ відділ");
  for (const tm of t.teams) assert.equal(tm.managers.reduce((a, x) => a + x.n, 0), tm.n, `🔴 Σ менеджерів ≠ команда ${tm.label}`);
  assert.ok(t.teams.some((x) => x.label === "Без команди"), "🔴 заявка без команди зникла замість рядка «Без команди»");
  assert.equal(t.leadgen.n, 2, "🔴 лідгенів немає окремим рядком");
  assert.equal(t.leadgen.medianMin, 750);
});

let ctxP: Promise<{ raw: import("pg").Client } | { unavailable: string }> | null = null;
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });
async function ctx(t: { skip: (m: string) => void }) {
  ctxP ??= (async () => {
    const { provisionScratch } = await import("../db/scratchDb.js");
    const s = provisionScratch();
    if ("unavailable" in s) return { unavailable: skipReason(s) };
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: s.url });
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    dispose = async () => { await c.end().catch(() => {}); s.dispose(); };
    return { raw: c };
  })();
  const r = await ctxP;
  if ("unavailable" in r) { t.skip(r.unavailable); return null; }
  return r;
}

test("#1550e ЖИВА СХЕМА: SQL рядків бере нотатку й Ringostat; запис першого набору — тривалість їде за часом", async (t) => {
  const c = await ctx(t); if (!c) return;
  const q = (s: string, p?: unknown[]) => c.raw.query(s, p);
  await q(`INSERT INTO teams (id, name) VALUES (155, 'РНК 155') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO managers (id, name, team_id) VALUES (1551, 'Менеджер 1551', 155) ON CONFLICT DO NOTHING`);
  const at = (ms: number) => new Date(ms).toISOString();
  await q(`INSERT INTO deals (kommo_id, client_key, manager_id, pipeline_id, status_id, created_at_kommo, client_source, lead_channel, first_call_out_at, first_call_out_sec)
           VALUES (15501, 'k1', 1551, 8921932, 1, $1, 'uts.ua', NULL, $2, 45),
                  (15502, 'k2', 1551, 8921932, 1, $1, NULL, 'leadgen', NULL, NULL)`, [at(TUE10), at(TUE10 + 9 * MIN)]);
  await q(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, client_key) VALUES ('rc1', $1, 'out', 0, 'k1')`, [at(TUE10 + 4 * MIN)]);
  // Вибірку будуємо руками (бойова `leadSelection` тягне пул); тут перевіряється САМ SQL рядків.
  const sel = { conds: ["d.kommo_id = ANY($1)"], params: [[15501, 15502]], teamSql: "m.team_id" };
  const { sql, params } = responseRowsSql(sel, ["uts.ua"]);
  const rows = (await q(sql + " ORDER BY d.kommo_id", params)).rows as { is_main: boolean; note_sec: number | null; rc_at: Date | null; rc_sec: number | null; team: string | null }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].is_main, true); assert.equal(rows[1].is_main, false, "🔴 лідген прочитаний як заявка відділу");
  assert.equal(rows[0].note_sec, 45); assert.equal(rows[0].rc_sec, 0);
  assert.equal(rows[0].team, "РНК 155");
  const dial = firstDial({ at: TUE10 + 9 * MIN, sec: 45 }, { at: rows[0].rc_at!.getTime(), sec: rows[0].rc_sec });
  assert.deepEqual(dial, { at: TUE10 + 4 * MIN, sec: 0 }, "🔴 перший набір — не ранній запис Ringostat");

  // Запис першого набору з нотаток: пізніший дзвінок не перезаписує тривалість; ранній — перезаписує; той самий без тривалості — дописує.
  const sec = async () => (await q(`SELECT first_call_out_sec AS s FROM deals WHERE kommo_id = 15501`)).rows[0].s as number | null;
  await q(FIRST_CALL_UPDATE_SQL, [[15501], [at(TUE10 + 20 * MIN)], [0]]);
  assert.equal(await sec(), 45, "🔴 пізніший дзвінок переписав тривалість першого");
  await q(FIRST_CALL_UPDATE_SQL, [[15501], [at(TUE10 + 2 * MIN)], [0]]);
  assert.equal(await sec(), 0, "🔴 ранніший дзвінок не приніс своєї тривалості");
  await q(`UPDATE deals SET first_call_out_sec = NULL WHERE kommo_id = 15501`);
  await q(FIRST_CALL_UPDATE_SQL, [[15501], [at(TUE10 + 2 * MIN)], [12]]);
  assert.equal(await sec(), 12, "🔴 той самий дзвінок без тривалості так і лишився «невідомо»");
});

test("#1550f МЕЖІ Й ЕКРАН: роут — той самий кламп і період, що в розділу; у матриці; блок показує медіану й лідгенів окремо", () => {
  const src = SRC("routes/dashboard.ts");
  const i = src.indexOf('dashboardRouter.get("/missed-calls/response-time"');
  assert.ok(i >= 0, "🔴 роуту немає");
  const body = src.slice(i, src.indexOf("\ndashboardRouter.", i + 10));
  assert.match(body, /missedScopeFor\(req\.auth!, req\.query\)/, "🔴 менеджер побачить чужих — немає клампа розділу");
  assert.match(body, /managerId: scope\.managerId, teamId: scope\.teamId/, "🔴 кламп обчислено, але не передано в ядро");
  assert.match(body, /missedPeriod\(/, "🔴 період не той, що в решти розділу");
  assert.match(SRC("auth/accessMatrix.ts"), /path: "\/api\/dashboard\/missed-calls\/response-time"/, "🔴 роут поза матрицею доступу");
  const fe = FE("pages/dashboard/sections/MissedCallsSection.tsx");
  assert.match(fe, /<ResponseTimeBlock from=\{d\.period\.from\} to=\{d\.period\.to\} \/>/, "🔴 блок не стоїть у розділі або бере інший період");
  assert.match(fe, /label="Медіана відповіді"/, "🔴 головне число блоку — не медіана");
  assert.match(fe, /label="Лідгени \(окремо\)"/, "🔴 лідгени не показані окремо");
  const sync = SRC("jobs/syncDealActivity.ts");
  assert.match(sync, /await pool\.query\(FIRST_CALL_UPDATE_SQL,/, "🔴 джоба активності пише перший набір не тим SQL, що перевіряє #1550e");
});
