import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { teamAt, inTeamDuring, type TeamMove } from "./teamAt.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");

/**
 * 🔀 КОМАНДА НА ДАТУ (02.10.2026, задача 4892). Хомік з 01.10 іде від Яцика «без команди»; відповідь
 * власника — «все що було залишається в команді у якій працювала». Гейти стережуть правило з обох
 * боків межі переходу, його SQL-форму, гроші й план поверх неї, запис переходу й обох писарів.
 */
const KHOMIK: TeamMove[] = [{ effectiveFrom: "2026-10-01", fromTeamId: 5, toTeamId: null }];
const CHAIN: TeamMove[] = [
  { effectiveFrom: "2026-10-01", fromTeamId: 5, toTeamId: 6 },
  { effectiveFrom: "2026-11-15", fromTeamId: 6, toTeamId: 7 },
];
/** Перехід ІЗ «без команди»: `from` = NULL — і саме його `COALESCE` сплутав би з «переходу немає». */
const FROM_NONE: TeamMove[] = [{ effectiveFrom: "2026-10-01", fromTeamId: null, toTeamId: 5 }];

test("#1301 КОМАНДА НА ДАТУ: до дня переходу — стара, з дня переходу — нова; без переходів — поточна", () => {
  assert.equal(teamAt(null, KHOMIK, "2026-09-30"), 5, "🔴 останній день у Яцика віддано новій команді");
  assert.equal(teamAt(null, KHOMIK, "2026-10-01"), null, "🔴 день переходу лишився в старій команді");
  assert.equal(teamAt(6, [], "2020-01-01"), 6, "🔴 без переходів команда не поточна");
  assert.deepEqual(["2026-09-30", "2026-10-01", "2026-11-14", "2026-11-15"].map((d) => teamAt(7, CHAIN, d)), [5, 6, 6, 7],
    "🔴 ланцюг із двох переходів дає не ту команду");
  assert.equal(teamAt(5, FROM_NONE, "2026-09-30"), null, "🔴 «був без команди» прочитано як «переходу немає»");
});

test("#1301b БУВ У КОМАНДІ ХОЧ ДЕНЬ ПЕРІОДУ: вересень Хомік — у Яцика, жовтень — ні; перехід усередині періоду рахується", () => {
  assert.equal(inTeamDuring(null, KHOMIK, 5, "2026-09-01", "2026-09-30"), true, "🔴 вересень без Хомік у команді Яцика");
  assert.equal(inTeamDuring(null, KHOMIK, 5, "2026-10-01", "2026-10-31"), false, "🔴 жовтень із Хомік у команді Яцика");
  assert.equal(inTeamDuring(null, KHOMIK, 5, "2026-09-15", "2026-10-15"), true, "🔴 період через межу загубив людину");
  assert.equal(inTeamDuring(7, CHAIN, 7, "2026-11-01", "2026-11-30"), true, "🔴 перехід У команду посеред періоду не врахований");
  assert.equal(inTeamDuring(7, CHAIN, 7, "2026-10-01", "2026-10-31"), false, "🔴 людина в команді раніше за перехід");
  assert.equal(inTeamDuring(7, CHAIN, 6, "2026-11-20", "2026-11-30"), false, "🔴 людина в команді після переходу з неї");
});

// ── Живий SQL на scratch-кластері: один кластер на файл, пул ядра дивиться в нього ──────────────────
type Ctx = {
  c: import("pg").Client;
  money: typeof import("./money.js");
  plans: typeof import("./plans.js");
  metrics: typeof import("./metrics.js");
  sql: typeof import("./teamAt.js");
};
let ctxP: Promise<Ctx | { skip: string }> | null = null;
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });

const FC = 8921932;
async function db(): Promise<Ctx | { skip: string }> {
  ctxP ??= (async () => {
    const { provisionScratch } = await import("../db/scratchDb.js");
    const scratch = provisionScratch();
    if ("unavailable" in scratch) return { skip: skipReason(scratch) };
    // ⚠️ `DATABASE_URL` — ДО імпорту ядра: `db/pool` читає конфіг на імпорті (прийом #843 / #1300).
    process.env.DATABASE_URL = scratch.url;
    process.env.JWT_SECRET ??= "test";
    process.env.KOMMO_BASE_URL ??= "https://x.invalid";
    process.env.KOMMO_API_TOKEN ??= "x";
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: scratch.url });
    await c.connect();
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id, name) VALUES (5, 'РПК-Яцика'), (6, 'РНК'), (7, 'РПК-2') ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id, is_active) VALUES
      (1, 'Хомік', NULL, true), (2, 'Сусід', 5, true), (3, 'Без переходів', 6, true), (4, 'Новенький', 5, true)
      ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO manager_team_moves (manager_id, from_team_id, to_team_id, effective_from, source) VALUES
      (1, 5, NULL, '2026-10-01', 'settings'), (4, NULL, 5, '2026-10-01', 'kommo')`);
    await c.query(`INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES (${FC}, 142, 'paid') ON CONFLICT DO NOTHING`);
    // Межа з ОБОХ боків: 30.09 (ще Яцик) і 01.10 (уже без команди) — полудень за Києвом, щоб доба не з'їхала.
    for (const [id, mgr, price, at] of [
      [101, 1, 100, "2026-09-30 12:00+03"], [102, 1, 30, "2026-10-01 12:00+03"],
      [103, 2, 50, "2026-09-20 12:00+03"], [104, 3, 7, "2026-09-10 12:00+03"],
    ] as const) {
      await c.query(
        `INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, price, created_at_kommo, closed_at_kommo)
         VALUES ($1, $2, $3, ${FC}, 142, $4, $5::timestamptz - interval '3 days', $5::timestamptz)`,
        [id, `угода ${id}`, mgr, price, at]);
    }
    await c.query(`INSERT INTO plans (manager_id, metric, plan_date, planned_value) VALUES
      (1, 'payment_amount', '2026-09-01', 1000), (1, 'payment_amount', '2026-10-01', 900), (2, 'payment_amount', '2026-09-01', 2000)`);
    const [money, plans, metrics, sql] = await Promise.all([
      import("./money.js"), import("./plans.js"), import("./metrics.js"), import("./teamAt.js")]);
    // Як сервер на старті: знімок переходів у памʼяті (`refreshTeamMoves`). #1302/#1302b окремо женуть і запасну форму.
    await sql.refreshTeamMoves(c);
    dispose = async () => {
      const { pool } = await import("../db/pool.js");
      await pool.end();
      await c.end();
      scratch.dispose();
    };
    return { c, money, plans, metrics, sql };
  })();
  return ctxP;
}

async function movesOf(c: import("pg").Client): Promise<Map<number, TeamMove[]>> {
  const r = await c.query<{ manager_id: number; ef: string; f: number | null; t: number | null }>(
    `SELECT manager_id, to_char(effective_from, 'YYYY-MM-DD') AS ef, from_team_id AS f, to_team_id AS t FROM manager_team_moves`);
  const m = new Map<number, TeamMove[]>();
  for (const x of r.rows) m.set(x.manager_id, [...(m.get(x.manager_id) ?? []), { effectiveFrom: x.ef, fromTeamId: x.f, toTeamId: x.t }]);
  return m;
}
const DAYS = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];

test("#1302 ЖИВИЙ SQL: вираз «команда на дату» == правилу для кожного менеджера й дня (і для «був без команди»)", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  try {
    for (const form of ["знімок", "запасна"] as const) {
      if (form === "запасна") x.sql.forgetTeamMoves(); else await x.sql.refreshTeamMoves(x.c);
      await checkTeamAtSql(x, form);
    }
  } finally { await x.sql.refreshTeamMoves(x.c); }
});

async function checkTeamAtSql(x: Ctx, form: string): Promise<void> {
  const moves = await movesOf(x.c);
  const mgrs = (await x.c.query<{ id: number; team_id: number | null }>(`SELECT id, team_id FROM managers ORDER BY id`)).rows;
  assert.equal(mgrs.length, 4, "🔴 фікстура не засіялась — порожньо означає ПРОВАЛ");
  for (const m of mgrs) for (const d of DAYS) {
    const got: number | null = (await x.c.query<{ t: number | null }>(
      `SELECT ${x.sql.teamAtSql("m", "$1::date")} AS t FROM managers m WHERE m.id = $2`, [d, m.id])).rows[0].t;
    assert.equal(got, teamAt(m.team_id, moves.get(m.id) ?? [], d), `🔴 [${form}] менеджер ${m.id} на ${d}: SQL розійшовся з правилом`);
    const on: boolean = (await x.c.query<{ v: boolean }>(
      `SELECT ${x.sql.teamOnDateSql("m", "$1::date", "$3")} AS v FROM managers m WHERE m.id = $2`, [d, m.id, 5])).rows[0].v ?? false;
    assert.equal(on, teamAt(m.team_id, moves.get(m.id) ?? [], d) === 5, `🔴 [${form}] «рядок у команді 5» для менеджера ${m.id} на ${d} не той`);
  }
  for (const [from, to] of [["2026-09-01", "2026-09-30"], ["2026-10-01", "2026-10-31"], ["2026-09-15", "2026-10-15"]]) {
    for (const m of mgrs) for (const team of [5, 6]) {
      const got: boolean = (await x.c.query<{ v: boolean }>(
        `SELECT ${x.sql.inTeamDuringSql("m", "$3", "$1", "$2")} AS v FROM managers m WHERE m.id = $4`, [from, to, team, m.id])).rows[0].v;
      assert.equal(got, inTeamDuring(m.team_id, moves.get(m.id) ?? [], team, from, to),
        `🔴 «був у команді ${team} за ${from}…${to}» для менеджера ${m.id}: SQL розійшовся з правилом`);
    }
  }
  const commercial = async (id: number, from: string, to: string) => (await x.c.query<{ v: boolean }>(
    `SELECT ${x.metrics.commercialDuringSql("m", "$1", "$2")} AS v FROM managers m WHERE m.id = $3`, [from, to, id])).rows[0].v;
  assert.equal(await commercial(1, "2026-09-01", "2026-09-30"), true, "🔴 у вересні Хомік не продажна — випаде з ростера Звіту");
  assert.equal(await commercial(1, "2026-10-01", "2026-10-31"), false, "🔴 у жовтні Хомік без команди, а рахується продажною");
}

test("#1302b ЖИВИЙ SQL: без жодного переходу вираз == поточна команда кожного менеджера (звіти байт-у-байт як були)", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  await x.c.query("BEGIN");
  try {
    await x.c.query(`DELETE FROM manager_team_moves`);
    for (const form of ["знімок", "запасна"] as const) {
      if (form === "запасна") x.sql.forgetTeamMoves(); else await x.sql.refreshTeamMoves(x.c);
      const r: { rows: { n: string; same: string }[] } = await x.c.query<{ n: string; same: string }>(
        `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE ${x.sql.teamAtSql("m", "d::date")} IS NOT DISTINCT FROM m.team_id) AS same
           FROM managers m CROSS JOIN unnest($1::date[]) AS d`, [DAYS]);
      assert.equal(Number(r.rows[0].n), 16, "🔴 сітка менеджер × день не та — перевіряти нема чого");
      assert.equal(Number(r.rows[0].same), 16, `🔴 [${form}] без переходів команда на дату відрізняється від поточної — зрушить усі звіти`);
    }
    // Зі знімком без переходів вираз — ДОСЛІВНО старий: той самий SQL, той самий план, ніякого регресу часу.
    await x.sql.refreshTeamMoves(x.c);
    assert.equal(x.sql.teamOnDateSql("m", "d::date", "$9"), "m.team_id = $9", "🔴 без переходів запит уже не той, що до модуля");
    assert.equal(x.sql.teamAtSql("m", "d::date"), "m.team_id", "🔴 без переходів вираз команди уже не `m.team_id`");
  } finally { await x.c.query("ROLLBACK"); await x.sql.refreshTeamMoves(x.c); }
});

test("#1303 ГРОШІ З ПЕРЕХОДОМ: вересень Хомік — у Яцика, жовтень — без команди; Σ команд == відділ; рядок у команді — лише її частка", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const P = { from: "2026-09-01", to: "2026-10-31" };
  const byTeam = await x.money.receivedByTeam(P);
  const of = (id: number | null) => byTeam.find((r) => r.teamId === id)?.revenue ?? 0;
  assert.equal(of(5), 150, "🔴 команда Яцика втратила вересень Хомік (або отримала її жовтень)");
  assert.equal(of(null), 30, "🔴 жовтень Хомік не в «без команди»");
  assert.equal(of(6), 7, "🔴 команда без переходів зрушилась");
  const total = (await x.money.receivedMoney(P)).revenue;
  assert.equal(byTeam.reduce((a, r) => a + r.revenue, 0), total, "🔴 Σ команд ≠ відділу — гроші загубились або задвоїлись");
  const rows = await x.money.receivedByMgr({ ...P, teamId: 5 });
  assert.deepEqual(rows.map((r) => [r.managerId, r.revenue]).sort((a, b) => a[0] - b[0]), [[1, 100], [2, 50]],
    "🔴 у розрізі команди Яцика рядок Хомік — не її вересенева частка");
  assert.equal((await x.money.receivedMoney({ from: "2026-10-01", to: "2026-10-31", teamId: 5 })).revenue, 0,
    "🔴 жовтень Хомік рахується в команді, з якої вона пішла");
  // 🪞 Дзеркало: прибрати перехід — і вересень іде за людиною (старе правило). Отже тримає саме перехід.
  await x.c.query(`DELETE FROM manager_team_moves WHERE manager_id = 1`);
  await x.sql.refreshTeamMoves(x.c);
  try {
    const old = await x.money.receivedByTeam(P);
    assert.equal(old.find((r) => r.teamId === 5)?.revenue ?? 0, 50, "🔴 без переходу команда й далі тримає вересень — гейт міряє не перехід");
  } finally {
    await x.c.query(`INSERT INTO manager_team_moves (manager_id, from_team_id, to_team_id, effective_from, source)
                     VALUES (1, 5, NULL, '2026-10-01', 'settings')`);
    await x.sql.refreshTeamMoves(x.c);
  }
});

test("#1304 ПЛАН З ПЕРЕХОДОМ: вересневий план Хомік — у плані команди Яцика, жовтневий — поза нею", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const sep = await x.plans.managerPlan({ month: "2026-09-01", teamId: 5 });
  assert.deepEqual(sep.rows.map((r) => r.managerId).sort(), [1, 2], "🔴 у вересневому плані команди Яцика немає Хомік");
  assert.equal(sep.rows.find((r) => r.managerId === 1)?.plan, 1000, "🔴 вересневий план Хомік не той");
  const oct = await x.plans.managerPlan({ month: "2026-10-01", teamId: 5 });
  assert.ok(!oct.rows.some((r) => r.managerId === 1), "🔴 жовтневий план Хомік рахується в команді, з якої вона пішла");
  const octAll = await x.plans.managerPlan({ month: "2026-10-01" });
  assert.equal(octAll.rows.find((r) => r.managerId === 1)?.teamId, null, "🔴 у жовтні Хомік підписана старою командою");
});

test("#1305 ЗАПИС ПЕРЕХОДУ: новий день — рядок; той самий день — виправлення; повернення того ж дня — переходу не було; раніша дата — відмова", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const rows = async () => (await x.c.query<{ ef: string; f: number | null; t: number | null }>(
    `SELECT to_char(effective_from, 'YYYY-MM-DD') AS ef, from_team_id AS f, to_team_id AS t FROM manager_team_moves
      WHERE manager_id = 3 ORDER BY effective_from`)).rows;
  // Як роут: перехід пишеться з поточної команди, ПОТІМ команда міняється (інакше «той самий день» не перевірити).
  const rec = async (to: number | null, ef: string) => {
    const r = await x.sql.recordTeamMove(x.c, { managerId: 3, toTeamId: to, effectiveFrom: ef, source: "settings" });
    if (r.kind !== "rejected" && r.kind !== "none") await x.c.query(`UPDATE managers SET team_id = $2 WHERE id = $1`, [3, to]);
    return r;
  };
  assert.deepEqual(await rec(6, "2026-10-02"), { kind: "none" }, "🔴 перехід у ту саму команду записано");
  assert.equal((await rec(5, "2026-10-02")).kind, "inserted");
  assert.deepEqual(await rows(), [{ ef: "2026-10-02", f: 6, t: 5 }], "🔴 перехід лягав не з поточної команди");
  assert.equal((await rec(7, "2026-10-02")).kind, "updated", "🔴 друга зміна того ж дня стала другим переходом");
  assert.deepEqual(await rows(), [{ ef: "2026-10-02", f: 6, t: 7 }]);
  assert.equal((await rec(6, "2026-10-02")).kind, "cancelled", "🔴 повернення в ту саму команду того ж дня лишило перехід");
  assert.deepEqual(await rows(), [], "🔴 скасований перехід лишився рядком");
  assert.equal((await rec(5, "2026-10-05")).kind, "inserted");
  const back = await rec(6, "2026-10-03");
  assert.equal(back.kind, "rejected", "🔴 перехід раніше за останній прийнято — ланцюг розірвався б");
  assert.equal((await x.sql.recordTeamMove(x.c, { managerId: 3, fromTeamId: 5, toTeamId: 5, effectiveFrom: "2026-10-06", source: "kommo" })).kind,
    "none", "🔴 синк записав перехід без зміни команди");
  await x.c.query(`DELETE FROM manager_team_moves WHERE manager_id = 3`);
  await x.c.query(`UPDATE managers SET team_id = 6 WHERE id = 3`);
});

test("#1306 ОБИДВА ПИСАРІ КОМАНДИ ПИШУТЬ ПЕРЕХІД: синк (джерело kommo) і Налаштування (джерело settings, з датою)", () => {
  const sync = readFileSync(path.join(ROOT, "backend/src/jobs/syncKommo.ts"), "utf8");
  const settings = readFileSync(path.join(ROOT, "backend/src/routes/settings.ts"), "utf8");
  assert.match(sync, /\brecordTeamMove\(client, \{[^}]*source: "kommo"/s, "🔴 синк міняє команду без переходу — минуле переїде за людиною");
  assert.match(settings, /\brecordTeamMove\(client, \{[^}]*effectiveFrom,[^}]*source: "settings"/s,
    "🔴 Налаштування міняють команду без переходу з датою");
  // Знімок переходів: без оновлення звіти бачили б перехід лише через 10 хв (крон) — або ніколи без старту.
  const index = readFileSync(path.join(ROOT, "backend/src/index.ts"), "utf8");
  assert.match(settings, /\bawait refreshTeamMoves\(pool\)/, "🔴 Налаштування не оновлюють знімок переходів");
  assert.match(sync, /if \(teamMoved\) await refreshTeamMoves\(pool\)/, "🔴 синк не оновлює знімок переходів");
  assert.match(index, /\bawait refreshTeamMoves\(pool\)/, "🔴 сервер стартує без знімка переходів — звіти підуть запасною формою");
});

// ── Прохід 2: розгортка «Команд», номінації тижня, пропущені дзвінки ─────────────────────────────

test("#1307 РОЗГОРТКА КОМАНДИ: хто перейшов — рядок у кожній команді зі своєю частиною; Σ рядків команди == команда", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const P = { from: "2026-09-01", to: "2026-10-31" };
  const [rows, teams] = await Promise.all([x.money.successByMgrAtTeam(P), x.money.successByTeam(P)]);
  const khomik = rows.filter((r) => r.managerId === 1).map((r) => [r.teamId, r.revenue]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(khomik, [[5, 100], [null, 30]], "🔴 Хомік у розгортці не розкладена між вереснем у Яцика і жовтнем без команди");
  for (const tm of teams) {
    const sum = rows.filter((r) => r.teamId === tm.teamId).reduce((a, r) => a + r.revenue, 0);
    assert.equal(sum, tm.revenue, `🔴 команда ${tm.teamId}: Σ менеджерів розгортки ≠ рядку команди`);
  }
});

test("#1308 НОМІНАЦІЇ ТИЖНЯ: склад — команда на понеділок тижня (Хомік у Яцика до 01.10, після — поза заліком)", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const { nominationRoster } = await import("./nominations.js");
  const ids = async (asOf: string) => (await nominationRoster(5, asOf)).map((r) => r.id).sort();
  assert.deepEqual(await ids("2026-09-28"), [1, 2], "🔴 у тижні 28.09 Хомік не змагається в команді Яцика");
  assert.deepEqual(await ids("2026-10-05"), [2, 4], "🔴 у тижні 05.10 склад команди Яцика не той (Хомік пішла, Новенький прийшов)");
});

test("#1309 ПРОПУЩЕНІ ДЗВІНКИ: рядок команди й скоуп тімліда — за командою на день дзвінка", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const rules = await import("./missedCallsRules.js");
  await x.c.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, disposition, billsec, manager_id, client_phone) VALUES
    ('mc1', '2026-09-30 12:00+03', 'in', 'NO ANSWER', 0, 1, '380500000001'),
    ('mc2', '2026-10-01 12:00+03', 'in', 'NO ANSWER', 0, 1, '380500000002')`);
  try {
    const q = rules.missedByTeamSql("2026-09-01", "2026-10-31", {});
    const byTeam = new Map((await x.c.query<{ team_id: number | null; missed: number }>(q.sql, q.params)).rows.map((r) => [r.team_id, r.missed]));
    assert.equal(byTeam.get(5), 1, "🔴 вересневий пропущений Хомік не в рядку команди Яцика");
    assert.equal(byTeam.get(null), 1, "🔴 жовтневий пропущений Хомік не «поза командами»");
    const s = rules.missedSummarySql("2026-09-01", "2026-10-31", { teamId: 5 });
    assert.equal((await x.c.query<{ missed: number }>(s.sql, s.params)).rows[0].missed, 1, "🔴 тімлід Яцика бачить жовтневий пропущений Хомік");
  } finally {
    await x.c.query(`DELETE FROM ringostat_calls WHERE uniqueid IN ('mc1', 'mc2')`);
  }
});

/**
 * #1310 — РЕКЛАМНА КОГОРТА ВИКОНУЄТЬСЯ Й ДІЛИТЬСЯ ЗА КОМАНДОЮ НА ДАТУ ВХОДУ. Привід: golden на проді впав
 * `syntax error at or near "$"` — `${KYIV}` у звичайних лапках пішов у SQL буквально. `tsc` і 1433 гейти
 * мовчали, бо цей запит не виконувався ніде, крім живого Звіту. Тепер виконується тут.
 */
test("#1310 РЕКЛАМНА КОГОРТА: виконується; по команді — за датою входу в зону, по менеджеру — один рядок", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  for (const [id, at] of [[201, "2026-09-29 12:00+03"], [202, "2026-10-02 12:00+03"]] as const) {
    await x.c.query(`INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, price, client_key, lead_channel, utm_medium, created_at_kommo)
                     VALUES ($1, 'реклама', 1, ${FC}, 69693652, 0, $2, 'ad', 'cpc', $3::timestamptz)`, [id, `k${id}`, at]);
    await x.c.query(`INSERT INTO deal_stage_events (kommo_id, status_id, pipeline_id, changed_at) VALUES ($1, 69693652, ${FC}, $2)`, [id, at]);
  }
  try {
    const P = { from: "2026-09-01", to: "2026-10-31" };
    const byTeam = new Map((await x.metrics.conversionAdsByTeam(P, [])).map((r) => [r.teamId, r.entered]));
    assert.equal(byTeam.get(5), 1, "🔴 вересневий рекламний лід Хомік не в команді Яцика");
    assert.equal(byTeam.get(null), 1, "🔴 жовтневий рекламний лід Хомік не «без команди»");
    const mgr = (await x.metrics.conversionAdsByManager(P, [])).filter((r) => r.managerId === 1);
    assert.deepEqual(mgr.map((r) => r.entered), [2], "🔴 по менеджеру рядок Хомік розколовся або загубив лід");
    const yat = await x.metrics.conversionAdsByManager({ ...P, teamId: 5 }, []);
    assert.deepEqual(yat.map((r) => [r.managerId, r.entered]), [[1, 1]], "🔴 у скоупі команди Яцика не рівно вересневий лід Хомік");
  } finally {
    await x.c.query(`DELETE FROM deal_stage_events WHERE kommo_id IN (201, 202)`);
    await x.c.query(`DELETE FROM deals WHERE kommo_id IN (201, 202)`);
  }
});

/**
 * #1311 — БЕЗ ПЕРЕХОДІВ ДЖЕРЕЛА ВИКОНУЮТЬСЯ І ДАЮТЬ СТАРІ ЧИСЛА. Привід: golden на проді впав
 * `bind message supplies 1 parameters, but prepared statement requires 0` — без переходів вираз команди
 * перестав згадувати `$1`, а ростер `managerPlan` передавав місяць лише для нього. Усі інші гейти тут
 * ходять ІЗ переходами, тож порожній знімок — саме той стан, у якому прод живе сьогодні, — не перевірявся.
 */
test("#1311 БЕЗ ПЕРЕХОДІВ: план, гроші, конверсії, воронка, номінації виконуються й рахують за поточною командою", async (t) => {
  const x = await db(); if ("skip" in x) return t.skip(x.skip);
  const saved = (await x.c.query(`SELECT manager_id, from_team_id, to_team_id, effective_from, source FROM manager_team_moves`)).rows;
  await x.c.query(`DELETE FROM manager_team_moves`);
  try {
    assert.equal(await x.sql.refreshTeamMoves(x.c), 0, "🔴 знімок не порожній — перевірка не про той стан");
    const P = { from: "2026-09-01", to: "2026-10-31" };
    const sep = await x.plans.managerPlan({ month: "2026-09-01", teamId: 5 });
    assert.deepEqual(sep.rows.map((r) => r.managerId).sort(), [2, 4], "🔴 план команди без переходів не за поточною командою");
    assert.ok((await x.plans.managerPlan({ month: "2026-09-01" })).rows.length >= 3, "🔴 план відділу порожній");
    assert.equal((await x.plans.planPerWorkingDay({ teamId: 5 }, "2026-09-01")).monthPlan, 2000, "🔴 план на день команди не той");
    const byTeam = await x.money.receivedByTeam(P);
    assert.equal(byTeam.find((r) => r.teamId === 5)?.revenue, 50, "🔴 без переходів гроші команди не за поточною командою");
    assert.equal((await x.money.successByMgrAtTeam(P)).filter((r) => r.managerId === 1).length, 1, "🔴 без переходів рядок менеджера розколовся");
    await x.metrics.conversionAdsByTeam(P, []);
    await x.metrics.funnelCohortHonest({ ...P, teamId: 5 }, "month");
    await x.metrics.dispatchedByManager({ ...P, teamId: 5 });
    const { nominationRoster } = await import("./nominations.js");
    assert.deepEqual((await nominationRoster(5, "2026-09-28")).map((r) => r.id).sort(), [2, 4], "🔴 номінації без переходів не за поточною командою");
  } finally {
    for (const r of saved) await x.c.query(
      `INSERT INTO manager_team_moves (manager_id, from_team_id, to_team_id, effective_from, source) VALUES ($1, $2, $3, $4, $5)`,
      [r.manager_id, r.from_team_id, r.to_team_id, r.effective_from, r.source]);
    await x.sql.refreshTeamMoves(x.c);
  }
});
