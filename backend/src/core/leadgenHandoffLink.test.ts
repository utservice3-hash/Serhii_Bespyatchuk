import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { stageCountsQuery, handoffLinkQuery, bucketKeySql, type SqlQuery } from "./leadgenSql.js";
import { LEADGEN_STAGE_IDS, QUALIFICATION_PIPELINES } from "./leadgenStages.js";
import { pickHandoffs, LINK_BEFORE_SEC, LINK_AFTER_SEC, type HandoffEntry } from "./leadgenHandoffRules.js";

/**
 * #675…#676b — ЖИВИЙ SQL ЛІДОГЕНУ НА ТИМЧАСОВІЙ БАЗІ: вікно звʼязку передачі з угодою
 * менеджера, «передачі == прорахунки», київські ключі одиниць і місячний кошик тренду.
 *
 * 🔴 ТЕКСТ ЗАПИТІВ — ТОЙ САМИЙ, ЩО ЖЕНЕ ЯДРО: `leadgenSql.ts` (без імпортів) збирає рядок, пул
 * ядра і клієнт тут виконують його ж. Копія SQL у тесті доводила б рівність двох рядків,
 * написаних поруч (урок `#214c`), а не поведінку продукту.
 *
 * 🕐 Сесія — UTC, як на Neon. Без цього кластер успадкував би пояс машини (Київ), і саботаж
 * «прибрати AT TIME ZONE» лишився б ЗЕЛЕНИМ: помилка поясу не видна там, де пояс і так Київ.
 *
 * ⚠️ Один кластер на файл (`before`/`after`), а не на тест: кластерів на машині обмаль
 * (SysV shared memory), і паралельні прогони інших чатів уже клали їх провізію.
 * На прод-сервері бінарів PostgreSQL немає — скіп законний і названий у `ALLOWED_PROD_SKIPS`.
 *
 * 🧩 `#682b`…`#684b` — ЯДРО ЦІЛКОМ, А НЕ ЛИШЕ ТЕКСТ ЗАПИТУ (ревʼю F2–F4). Там кличуться
 * СПРАВЖНІ `money.handoffDealStates`, `leadgenTrend`, `leadgenStats`, `leadgenHandoffMoney` —
 * через пул ядра, спрямований на цей самий кластер (прийом `#25`/`#37` у `reactivation.test.ts`:
 * `DATABASE_URL` ставиться ДО першого імпорту `db/pool.js`, решта змінних — заглушки). Пул
 * модульний, але процес у файла свій, тож чужих тестів він не зачіпає; закривається в `after`.
 * Часовий пояс бази — UTC (`ALTER DATABASE`), щоб і зʼєднання пулу жили в поясі Neon.
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
const FC = [8921932, 155304];   // воронки повного циклу у фікстурі; у ядрі — `money.FC_PIPELINES`
const PZ = LEADGEN_STAGE_IDS.pz[0], QUAL = QUALIFICATION_PIPELINES[0], OTHER = 9999999;
const Q = LEADGEN_STAGE_IDS.qualified;

type C = import("pg").Client;
let client: C | null = null;
let skip: string | null = null;
let dispose: (() => void) | null = null;
let poolUsed = false;
/** Ядро через пул, спрямований на тимчасовий кластер. Лише після `before` з живим кластером. */
async function core() {
  poolUsed = true;
  const [money, stats, lgPlans] = await Promise.all([import("./money.js"), import("./leadgenStats.js"), import("./leadgenPlans.js")]);
  return { money, stats, lgPlans };
}

const utc = (s: string) => new Date(s + "Z");
const sec = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

async function run<T>(q: SqlQuery): Promise<T[]> {
  return (await client!.query(q.text, q.values)).rows as T[];
}
const linkQ = (from: string, to: string) => handoffLinkQuery(from, to,
  { pz: LEADGEN_STAGE_IDS.pz, qualified: Q, managerPipelines: [...QUALIFICATION_PIPELINES, ...FC] },
  { beforeSec: LINK_BEFORE_SEC, afterSec: LINK_AFTER_SEC });

let nextId = 700000;
async function deal(p: { manager: number | null; pipeline: number; status?: number; ck: string | null;
  created?: Date; name?: string }): Promise<number> {
  const id = nextId++;
  await client!.query(
    `INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, created_at_kommo, client_key, client_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, p.name ?? `угода ${id}`, p.manager, p.pipeline, p.status ?? 1, p.created ?? utc("2026-01-01T00:00:00"), p.ck, p.ck]);
  return id;
}
async function ev(kommoId: number, pipeline: number, status: number, at: Date): Promise<void> {
  await client!.query(`INSERT INTO deal_stage_events (kommo_id, status_id, pipeline_id, changed_at) VALUES ($1,$2,$3,$4)`,
    [kommoId, status, pipeline, at]);
}

/** Вікно звʼязку: момент передачі T і угоди-кандидати навколо обох меж. */
const T = utc("2026-09-10T09:00:00");
const fx: Record<string, { pz: number; want: number | null }> = {};

before(async () => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { skip = skipReason(s); return; }
  dispose = s.dispose;
  const { default: pg } = await import("pg");
  client = new pg.Client({ connectionString: s.url });
  await client.connect();
  await client.query(readFileSync(SCHEMA, "utf8"));
  await client.query("SET TIME ZONE 'UTC'");
  // Пояс Neon — і для зʼєднань пулу ядра, які відкриються пізніше (`#682b`…`#684b`).
  await client.query(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone = %L', current_database(), 'UTC'); END $$`);
  process.env.DATABASE_URL = s.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  await client.query(`INSERT INTO teams (id, name) VALUES (1, 'Лідоген-1'), (2, 'Лідоген-2')`);
  await client.query(`INSERT INTO managers (id, name, team_id) VALUES (1,'Лідген А',1),(2,'Лідген Б',2),(3,'Продажі В',1)`);

  // ── #675: межі вікна −10…+120 с, NULL-ключ, найраніша, чужа воронка
  const link = async (key: string, cands: { off: number; pipeline: number }[], want: number | null | "first") => {
    const pz = await deal({ manager: 1, pipeline: PZ, ck: key });
    await ev(pz, PZ, Q, T);
    const ids: number[] = [];
    for (const c of cands) ids.push(await deal({ manager: 3, pipeline: c.pipeline, ck: key, created: sec(T, c.off) }));
    fx[key] = { pz, want: want === "first" ? ids[0] : want };
  };
  await link("k-11", [{ off: -11, pipeline: FC[0] }], null);
  await link("k-10", [{ off: -10, pipeline: FC[0] }], "first");
  await link("k+120", [{ off: 120, pipeline: FC[0] }], "first");
  await link("k+121", [{ off: 121, pipeline: FC[0] }], null);
  await link("k-other", [{ off: 1, pipeline: OTHER }], null);
  {
    // найраніша з двох кандидатів — навіть коли пізнішу вставлено першою
    const pz = await deal({ manager: 1, pipeline: PZ, ck: "k-earliest" });
    await ev(pz, PZ, Q, T);
    await deal({ manager: 3, pipeline: QUAL, ck: "k-earliest", created: sec(T, 30) });
    const early = await deal({ manager: 3, pipeline: FC[0], ck: "k-earliest", created: sec(T, 5) });
    fx["k-earliest"] = { pz, want: early };
  }
  {
    // NULL-ключ: ані «NULL = NULL», ані угода без ключа поруч у часі не звʼязуються
    const pz = await deal({ manager: 1, pipeline: PZ, ck: null });
    await ev(pz, PZ, Q, T);
    await deal({ manager: 3, pipeline: FC[0], ck: null, created: sec(T, 1) });
    fx["k-null"] = { pz, want: null };
  }

  // ── #675b: два входи однієї угоди Продзвону; угода без менеджера; 142 поза Продзвоном
  const twice = await deal({ manager: 2, pipeline: PZ, ck: "k-twice" });
  await ev(twice, PZ, Q, utc("2026-09-12T08:00:00"));                          // перший вхід — угоди нема
  await ev(twice, PZ, Q, utc("2026-09-12T10:00:00"));                          // другий — створив угоду
  fx["k-twice"] = { pz: twice, want: await deal({ manager: 3, pipeline: QUAL, ck: "k-twice", created: utc("2026-09-12T10:00:30") }) };
  const orphan = await deal({ manager: null, pipeline: PZ, ck: "k-orphan" });
  await ev(orphan, PZ, Q, utc("2026-09-12T09:00:00"));                          // без менеджера — поза ростером
  const fcWin = await deal({ manager: 1, pipeline: FC[0], ck: "k-fc" });
  await ev(fcWin, FC[0], Q, utc("2026-09-12T09:00:00"));                        // 142 повного циклу — не передача
  // лічильники інших стадій — щоб рядки мали що рахувати, крім прорахунків
  for (const [m, st, when] of [[1, LEADGEN_STAGE_IDS.taken, "2026-09-02T07:00:00"], [2, LEADGEN_STAGE_IDS.opr, "2026-09-03T07:00:00"],
    [1, LEADGEN_STAGE_IDS.taken, "2026-08-20T07:00:00"]] as [number, number, string][]) {
    const d = await deal({ manager: m, pipeline: PZ, ck: null });
    await ev(d, PZ, st, utc(when));
  }

  // ── #676: межі тижня й місяця за Києвом (Київ = UTC+3 у вересні)
  const edge = async (manager: number, at: string, status: number = LEADGEN_STAGE_IDS.taken) => {
    const d = await deal({ manager, pipeline: PZ, ck: null });
    await ev(d, PZ, status, utc(at));
    return d;
  };
  await edge(2, "2026-09-13T20:30:00");   // Нд 13.09 23:30 Київ → тиждень 07.09
  await edge(2, "2026-09-13T21:30:00");   // Пн 14.09 00:30 Київ → тиждень 14.09
  await edge(2, "2026-08-31T20:30:00");   // Пн 31.08 23:30 Київ → серпень
  await edge(2, "2026-08-31T21:30:00", Q);// Вт 01.09 00:30 Київ → вересень (і передача вересня)

  // ── #748/#749 (плани лідгенів, 25.09.2026): БЕРЕЗЕНЬ 2025 — поза будь-яким вікном гейтів вище
  // (тренд найдовше тягнеться з 2025-10), тож їхніх чисел ці рядки не рушать. Команда 50011 —
  // із сиду схеми. 60, 61 — учасники; 64 — учасник без жодної події; 62 — лідген поза командою;
  // 63 — у команді, але логін вимкнено в Налаштуваннях (не активний за `activeManagerSql`).
  await client.query(`INSERT INTO managers (id, name, team_id) VALUES
    (60,'Учасник А',50011),(61,'Учасник Б',50011),(62,'Поза командою',1),(63,'Вимкнений',50011),(64,'Без подій',50011)`);
  await client.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,is_active) VALUES
    (900,'off@x','x','manager',63,50011,false),(901,'lead@x','x','team_lead',60,50011,true),(902,'adm@x','x','admin',NULL,NULL,true)`);
  for (const [m, st, when] of [[60, LEADGEN_STAGE_IDS.taken, "2025-03-03T08:00:00"], [60, LEADGEN_STAGE_IDS.opr, "2025-03-04T08:00:00"],
    [60, Q, "2025-03-05T08:00:00"], [61, LEADGEN_STAGE_IDS.taken, "2025-03-10T08:00:00"], [62, LEADGEN_STAGE_IDS.taken, "2025-03-11T08:00:00"],
    [62, Q, "2025-03-12T08:00:00"], [63, LEADGEN_STAGE_IDS.taken, "2025-03-13T08:00:00"]] as [number, number, string][]) {
    const d = await deal({ manager: m, pipeline: PZ, ck: null });
    await ev(d, PZ, st, utc(when));
  }

  // ── #1090/#1090b (задача 4668, 30.09.2026): СІЧЕНЬ 2025 — поза вікнами всіх гейтів вище (тренд
  // тягнеться з 2025-10, плани — березень 2025). Людина 70, тиждень 13–19.01.2025, по угоді на випадок:
  // A — «Взято» і ОПР (один лід) · B — лише ОПР (лід: так лідген ставить реактивацію й повернуте
  // менеджером) · C — лише «Кваліфіковано» (не лід) · D — лише «Взято» · E — статус ОПР у воронці
  // Реактивації (не лід: чужа воронка) · F — «Підігрівається» (з 06.10.2026 — лід і ОПР). Джерела різні.
  await client.query(`INSERT INTO managers (id, name, team_id) VALUES (70,'Лідген Лід',1)`);
  const lg = async (src: string, pipeline: number, evs: [number, string][]) => {
    const d = await deal({ manager: 70, pipeline, ck: null });
    await client!.query(`UPDATE deals SET client_source = $2 WHERE kommo_id = $1`, [d, src]);
    for (const [st, when] of evs) await ev(d, pipeline, st, utc(when));
  };
  const RE = LEADGEN_STAGE_IDS.react[0];
  await lg("Холодная база", PZ, [[LEADGEN_STAGE_IDS.taken, "2025-01-13T08:00:00"], [LEADGEN_STAGE_IDS.opr, "2025-01-14T08:00:00"]]);
  await lg("Реактивація закриті", PZ, [[LEADGEN_STAGE_IDS.opr, "2025-01-15T08:00:00"]]);
  await lg("Холодная база", PZ, [[Q, "2025-01-15T09:00:00"]]);
  await lg("Реактивація наша база", PZ, [[LEADGEN_STAGE_IDS.taken, "2025-01-16T08:00:00"]]);
  await lg("Реактивація наша база", RE, [[LEADGEN_STAGE_IDS.opr, "2025-01-16T09:00:00"]]);
  await lg("Реактивація наша база", RE, [[LEADGEN_STAGE_IDS.warming, "2025-01-17T08:00:00"]]);
  // 06.10.2026 (#1264): G — одна угода пройшла «Взято» Продзвону, потім «Підігрів» Реактивації (один лід);
  // H — «Отримано зворотній зв'язок» Реактивації (69693744) — НЕ лід.
  {
    const g = await deal({ manager: 70, pipeline: RE, ck: null });
    await client.query(`UPDATE deals SET client_source = 'Холодная база' WHERE kommo_id = $1`, [g]);
    await ev(g, PZ, LEADGEN_STAGE_IDS.taken, utc("2025-01-17T09:00:00"));
    await ev(g, RE, LEADGEN_STAGE_IDS.warming, utc("2025-01-17T10:00:00"));
    await lg("Реактивація закриті", RE, [[69693744, "2025-01-17T11:00:00"]]);
  }

  // ── #1094b (30.09.2026): ЧЕРВЕНЬ 2025 — звʼязок за приміткою Kommo `lead_child_links`. Поза вікнами решти.
  const T2 = utc("2025-06-10T09:00:00");
  const note = async (parent: number, child: number) =>
    client!.query(`INSERT INTO lead_child_links (parent_id, child_id, created_at) VALUES ($1, $2, now())`, [parent, child]);
  { // a) клієнта в Продзвоні немає, примітка є → угода з примітки
    const pz = await deal({ manager: 1, pipeline: PZ, ck: null }); await ev(pz, PZ, Q, T2);
    const a = await deal({ manager: 3, pipeline: FC[0], ck: "n-a", created: sec(T2, 1) }); await note(pz, a);
    fx["n-nokey"] = { pz, want: a };
  }
  { // b) здогад знаходить B, примітка каже C → C (примітка точніша)
    const at = sec(T2, 600);
    const pz = await deal({ manager: 1, pipeline: PZ, ck: "n-c" }); await ev(pz, PZ, Q, at);
    await deal({ manager: 3, pipeline: FC[0], ck: "n-c", created: sec(at, 5) });
    const c = await deal({ manager: 3, pipeline: FC[0], ck: "n-other", created: sec(at, 20) }); await note(pz, c);
    fx["n-conflict"] = { pz, want: c };
  }
  { // c) дочірня з примітки поза вікном цього входу → лишається здогад E
    const at = sec(T2, 1200);
    const pz = await deal({ manager: 1, pipeline: PZ, ck: "n-o" }); await ev(pz, PZ, Q, at);
    const dd = await deal({ manager: 3, pipeline: FC[0], ck: "n-d", created: sec(at, 300) }); await note(pz, dd);
    const ee = await deal({ manager: 3, pipeline: FC[0], ck: "n-o", created: sec(at, 3) });
    fx["n-outside"] = { pz, want: ee };
  }
  { // d) ні клієнта, ні примітки → без угоди, як і було
    const pz = await deal({ manager: 1, pipeline: PZ, ck: null }); await ev(pz, PZ, Q, sec(T2, 1800));
    await deal({ manager: 3, pipeline: FC[0], ck: "n-z", created: sec(T2, 1801) });
    fx["n-none"] = { pz, want: null };
  }
});

after(async () => {
  if (client) await client.end();
  // Пул ядра — лише якщо його підняв котрийсь із гейтів (інакше імпорт створив би його тут).
  if (poolUsed) await (await import("../db/pool.js")).pool.end();
  dispose?.();
});

/**
 * #675 — ВІКНО ЗВʼЯЗКУ: обидва боки обох меж, NULL-ключ і найраніша угода.
 * 🧨 САБОТАЖ: `LINK_AFTER_SEC = 121` у `leadgenHandoffRules.ts` → угода на +121 с звʼязується, червоніє.
 */
test("#675 ЖИВИЙ SQL: вікно звʼязку −10…+120 с з обох боків межі; без client_key — без угоди", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const rows = await run<{ pz_id: string; deal_id: string | null }>(linkQ("2026-09-10", "2026-09-10"));
  const got = new Map(rows.map((r) => [Number(r.pz_id), r.deal_id == null ? null : Number(r.deal_id)]));
  const keys = ["k-11", "k-10", "k+120", "k+121", "k-other", "k-earliest", "k-null"];
  for (const k of keys) {
    assert.ok(got.has(fx[k].pz), `🔴 передача ${k} зникла з результату — вікно не має права її ховати`);
    assert.equal(got.get(fx[k].pz), fx[k].want, `🔴 ${k}: угода менеджера ${got.get(fx[k].pz)} замість ${fx[k].want}`);
  }
  assert.equal(rows.length, keys.length, "🔴 LATERAL розмножив передачі або додав чужі");
  // 🪞 Дзеркало: вікно таки ЗНАХОДИТЬ угоди — інакше «усе null» теж пройшло б межі «зовні».
  assert.ok([...got.values()].filter((v) => v != null).length >= 3, "фікстура вироджена — звʼязаних угод нема");
});

/**
 * #675b — ПЕРЕДАЧІ ЛЮДИНИ == ЇЇ «ПРОРАХУНКИ»; два входи однієї угоди — одна передача.
 * Рядки (`stageCountsQuery`) і передачі (`handoffLinkQuery` + `pickHandoffs`) — ті самі
 * запити, що в ядрі. Угода без менеджера й 142 повного циклу не мають права потрапити НІКУДИ.
 * 🧨 САБОТАЖ: у запиті передач `JOIN managers` → `LEFT JOIN managers` → червоніє.
 */
test("#675b ЖИВИЙ SQL: передачі людини == її «Прорахунки»; два входи однієї угоди — одна передача", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const from = "2026-09-01", to = "2026-09-30";
  const rows = await run<{ manager_id: number; quotes: string }>(stageCountsQuery(from, to, LEADGEN_STAGE_IDS));
  const quotes = new Map(rows.map((r) => [r.manager_id, Number(r.quotes)]));
  const links = (await run<{ pz_id: string; lg_id: number | null; lg_team_id: number | null; at: Date; day: string; deal_id: string | null }>(
    linkQ(from, to))).map((x): HandoffEntry => ({ pzId: Number(x.pz_id), lgId: x.lg_id as number, lgTeamId: x.lg_team_id,
    at: new Date(x.at).getTime(), day: x.day, dealId: x.deal_id == null ? null : Number(x.deal_id) }));
  assert.ok(links.every((l) => l.lgId != null), "🔴 передача без менеджера потрапила в список — прорахунки її не бачать");
  const picked = pickHandoffs(links);
  const handoffs = new Map<number, number>();
  for (const h of picked) handoffs.set(h.lgId, (handoffs.get(h.lgId) ?? 0) + 1);
  assert.deepEqual([...handoffs.entries()].sort(), [...quotes.entries()].filter(([, n]) => n > 0).sort(),
    "🔴 передачі людини розійшлись із її «Прорахунками» — предикати двох запитів уже не ті самі");
  assert.equal(links.filter((l) => l.pzId === fx["k-twice"].pz).length, 2, "фікстура мусить мати два входи однієї угоди");
  const tw = picked.filter((h) => h.pzId === fx["k-twice"].pz);
  assert.equal(tw.length, 1, "🔴 два входи однієї угоди Продзвону дали дві передачі");
  assert.equal(tw[0].dealId, fx["k-twice"].want, "🔴 угода менеджера не з того входу, що її створив");
  assert.ok(!links.some((l) => l.dealId != null && l.pzId === l.dealId), "🔴 угода звʼязалась сама з собою");
  assert.ok((quotes.get(1) ?? 0) >= 7 && (quotes.get(2) ?? 0) >= 2, "фікстура вироджена — рахувати нема чого");
});

/**
 * #676 — КЛЮЧІ ОДИНИЦЬ ЗА КИЄВОМ: тиждень — понеділок, день — київська дата, місяць — 1-ше;
 * і межа ПЕРІОДУ передач теж київська.
 * 🧨 САБОТАЖ: у `bucketKeySql` прибрати `AT TIME ZONE` → 00:30 понеділка падає в минулий тиждень.
 */
test("#676 ЖИВИЙ SQL: ключ тижня — понеділок за Києвом, дня — київська дата; межа місяця за Києвом", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const key = async (ts: string) => (await client!.query(
    `SELECT ${bucketKeySql("day", "$1::timestamptz")} AS d, ${bucketKeySql("week", "$1::timestamptz")} AS w,
            ${bucketKeySql("month", "$1::timestamptz")} AS m`, [utc(ts)])).rows[0];
  assert.deepEqual(await key("2026-09-13T20:30:00"), { d: "2026-09-13", w: "2026-09-07", m: "2026-09-01" }, "Нд 23:30 Київ");
  assert.deepEqual(await key("2026-09-13T21:30:00"), { d: "2026-09-14", w: "2026-09-14", m: "2026-09-01" },
    "🔴 00:30 понеділка за Києвом ліг у минулий тиждень — ключ рахується в UTC");
  assert.deepEqual(await key("2026-08-31T20:30:00"), { d: "2026-08-31", w: "2026-08-31", m: "2026-08-01" });
  assert.deepEqual(await key("2026-08-31T21:30:00"), { d: "2026-09-01", w: "2026-08-31", m: "2026-09-01" },
    "🔴 00:30 першого числа за Києвом ліг у минулий місяць");
  // Та сама межа — у запиті стадій з одиницею (тиждень, людина 2)
  const weeks = await run<{ bucket: string; manager_id: number; leads: string }>(
    stageCountsQuery("2026-09-07", "2026-09-20", LEADGEN_STAGE_IDS, "week"));
  const w2 = weeks.filter((r) => r.manager_id === 2).map((r) => [r.bucket, Number(r.leads)]);
  assert.deepEqual(w2, [["2026-09-07", 1], ["2026-09-14", 1]], "🔴 вхід о 00:30 понеділка за Києвом ліг не в свій тиждень");
  // Межа ПЕРІОДУ передач: 01.09 00:30 Київ — у вересні, а не в серпні
  const aug = await run<{ day: string }>(linkQ("2026-08-01", "2026-08-31"));
  const sep = await run<{ day: string }>(linkQ("2026-09-01", "2026-09-01"));
  assert.ok(!aug.some((r) => r.day === "2026-09-01"), "🔴 передача 01.09 за Києвом потрапила в серпень");
  assert.ok(sep.some((r) => r.day === "2026-09-01"), "🔴 передача 01.09 00:30 за Києвом зникла з вересня");
});

/**
 * #676b — МІСЯЧНИЙ КОШИК ТРЕНДУ == РЯДКАМ ТОГО МІСЯЦЯ, по кожній людині й кожному показнику.
 * Обидва — `stageCountsQuery`, у двох формах; фікстура тримає події по обидва боки межі місяця.
 * 🧨 САБОТАЖ: у формі з одиницею прибрати `JOIN managers` (або ключ без `AT TIME ZONE`) → червоніє.
 */
test("#676b ЖИВИЙ SQL: місячний кошик тренду == рядкам того місяця, по кожній людині", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const trend = await run<{ bucket: string; manager_id: number; leads: string; opr: string; quotes: string; warming: string }>(
    stageCountsQuery("2026-08-01", "2026-09-30", LEADGEN_STAGE_IDS, "month"));
  let compared = 0;
  for (const [ms, me] of [["2026-08-01", "2026-08-31"], ["2026-09-01", "2026-09-30"]]) {
    const rows = await run<{ manager_id: number; leads: string; opr: string; quotes: string; warming: string }>(
      stageCountsQuery(ms, me, LEADGEN_STAGE_IDS));
    const pick = (r: { leads: string; opr: string; quotes: string; warming: string }) =>
      [Number(r.leads), Number(r.opr), Number(r.quotes), Number(r.warming)];
    const a = rows.map((r) => [r.manager_id, ...pick(r)]).sort();
    const b = trend.filter((r) => r.bucket === ms).map((r) => [r.manager_id, ...pick(r)]).sort();
    assert.deepEqual(b, a, `🔴 місяць ${ms}: кошик тренду розійшовся з рядками /leadgen-stats того місяця`);
    compared += a.length;
  }
  assert.ok(compared >= 3, "фікстура вироджена — порівнювати нема чого");
});

/**
 * #683b — СТАН УГОДИ МЕНЕДЖЕРА ЗАРАЗ: СПРАВЖНІЙ `money.handoffDealStates` НА ТИМЧАСОВІЙ БАЗІ (ревʼю F3).
 *
 * Чиста `managerDealClass` уже під `#671`, а звірку правил із константами тримає `#683`. Тут —
 * решта ланцюга, якої не бачить жоден із них: SQL (`closed_at IS NOT NULL`, предикат списання),
 * відображення рядка в `{ closed, writtenOff }`, які правила передано, округлення й знак ціни.
 * Кожна межа — з обох боків: 142 з `closed_at` і без; етап 8 списаний цілком, частково й зі
 * скасованим списанням; «Виставлення рахунку» (зона, але не етап 8); 143 трьох воронок; 142
 * Кваліфікації; 142 чужої воронки.
 * 🧨 САБОТАЖ (money.ts): `closed: x.closed` → `closed: true` → червоніє; у виклику
 * `managerDealClass` підмінити зону на `STAGE_EXPECTED` → червоніє; `NOT (${DEAL_NOT_WRITTEN_OFF})
 * AS written_off` → `FALSE AS written_off` → червоніє.
 */
test("#683b ЖИВИЙ SQL: стан угоди менеджера — успіх лише з closed_at, списане → програно, зона «Очікуємо» ціла", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { money } = await core();
  const FC_NEW = FC[0], FC_OLD = FC[1], QUAL_OLD = QUALIFICATION_PIPELINES[1];
  const at = utc("2026-03-02T10:00:00");
  const mk = async (want: string, pipeline: number, status: number, o: { closed?: boolean; price?: number } = {}) => {
    const id = nextId++;
    await client!.query(
      `INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, price, created_at_kommo, closed_at_kommo, client_key, client_name)
       VALUES ($1, $2, 3, $3, $4, $5, $6, $7, NULL, NULL)`,
      [id, want, pipeline, status, o.price ?? 1000, at, o.closed ? at : null]);
    return { id, want, price: Math.round(o.price ?? 1000) };
  };
  const writeOff = async (dealId: number, inv: string, o: { revoked?: boolean; writtenOff?: boolean } = {}) => {
    const ck = `wo-${dealId}`;
    await client!.query(
      `INSERT INTO receivable_invoices (client_key, client_name, client_key_raw, invoice_no, amount, service_url)
       VALUES ($1, 'ТОВ Списання', $1, $2, 100, $3)`, [ck, inv, `https://x.invalid/leads/detail/${dealId}`]);
    if (o.writtenOff === false) return;
    await client!.query(
      `INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note, revoked_at)
       VALUES ($1, $2, 100, 'гейт #683b', $3)`, [ck, inv, o.revoked ? at : null]);
  };
  const cases = [
    await mk("success", FC_NEW, 142, { closed: true, price: 12_345.6 }),
    await mk("work", FC_NEW, 142, { closed: false }),                 // 142 без closed_at — ядро його не рахує
    await mk("paid", FC_OLD, 60412544),
    await mk("paid", FC_NEW, 69716460, { price: -500 }),              // мінусова — зі знаком
    await mk("expect", FC_NEW, 100274340),                            // «Виставлення рахунку»: зона, не етап 8
    await mk("lost", FC_NEW, 69716312),                               // етап 8, списано ВСЕ
    await mk("expect", FC_NEW, 69716312),                             // етап 8, списано ОДИН із двох рахунків
    await mk("expect", FC_NEW, 69716312),                             // етап 8, списання скасоване
    await mk("lost", FC_NEW, 143),
    await mk("lost", QUAL, 143),                                      // «Не цільові»
    await mk("lost", QUAL_OLD, 143),                                  // «Сміття»
    await mk("work", QUAL, 142, { closed: true }),                    // Кваліфіковано — ще не повний цикл
    await mk("work", FC_NEW, 69693668),
    await mk("work", OTHER, 142, { closed: true }),                   // 142 чужої воронки — не успіх
  ];
  await writeOff(cases[5].id, "A1");
  await writeOff(cases[6].id, "B1");
  await writeOff(cases[6].id, "B2", { writtenOff: false });
  await writeOff(cases[7].id, "C1", { revoked: true });

  const got = await money.handoffDealStates([...cases.map((c) => c.id), cases[0].id, 999_999_999]);
  assert.equal(got.size, cases.length, "🔴 дубль або неіснуюча угода змінили кількість станів");
  for (const c of cases) {
    const st = got.get(c.id);
    assert.ok(st, `🔴 угода ${c.id} (${c.want}) без стану`);
    assert.equal(st.cls, c.want, `🔴 угода ${c.id}: ${st.pipelineId}:${st.statusId} → «${st.cls}» замість «${c.want}»`);
    assert.equal(st.price, c.price, `🔴 угода ${c.id}: бюджет ${st.price} замість ${c.price}`);
  }
  assert.equal(got.get(cases[0].id)!.price, 12_346, "🔴 бюджет не округлено до гривні");
  assert.equal(got.get(cases[3].id)!.price, -500, "🔴 мінусова угода втратила знак");
  const kinds = new Set(cases.map((c) => c.want));
  assert.deepEqual([...kinds].sort(), ["expect", "lost", "paid", "success", "work"], "фікстура не покриває всіх класів");
});

/**
 * #1500b — ЯДРО ВІДДАЄ ПОЗНАЧКУ «МІНУСОВА УГОДА», А СУМУ НЕ ЧІПАЄ (рішення власника 07.10.2026).
 * `handoffDealStates` читає `deals.is_minus` → `minus`; бюджет лишається зі знаком (продажі й далі віднімають мінус —
 * нуль ставить лише `leadgenPrice` лідгена). Обидва боки: мінусова з прапорцем, плюсова без.
 * 🧨 САБОТАЖ: у `handoffDealStates` `minus: x.is_minus === true` → `minus: false` → червоніє.
 */
test("#1500b ЖИВИЙ SQL: стан угоди несе позначку «Мінус», бюджет — зі знаком", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { money } = await core();
  const at = utc("2026-03-02T10:00:00");
  const mk = async (price: number, minus: boolean) => {
    const id = nextId++;
    await client!.query(
      `INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, price, is_minus, created_at_kommo, client_key, client_name)
       VALUES ($1, 'гейт #1500b', 3, $2, 69716460, $3, $4, $5, NULL, NULL)`, [id, FC[0], price, minus, at]);
    return id;
  };
  const neg = await mk(-4_948, true), pos = await mk(2_448, false);
  const got = await money.handoffDealStates([neg, pos]);
  assert.deepEqual([got.get(neg)?.minus, got.get(neg)?.price], [true, -4_948], "🔴 мінусова угода: ядро загубило позначку або змінило бюджет");
  assert.deepEqual([got.get(pos)?.minus, got.get(pos)?.price], [false, 2_448], "🔴 плюсова угода позначена мінусовою або змінила бюджет");
});

/**
 * #682b — МІСЯЦЬ ТРЕНДУ == `/leadgen-stats` + ГРОШІ ТОГО МІСЯЦЯ, НА ЖИВОМУ SQL (ревʼю F2).
 *
 * `#676b` звіряв лише чотири лічильники стадій двома формами одного запиту. Тут — СПРАВЖНІ
 * `leadgenTrend`, `leadgenStats` і `leadgenHandoffMoney` через пул ядра: для кожного місяця вікна
 * рядки людей тренду (з ДЗВІНКАМИ) == рядкам `leadgenStats` того місяця, а гроші тренду ==
 * `leadgenHandoffMoney` того місяця, у відділі й у команді. Фікстура тримає обидві пастки ревʼю:
 * людина 4 дзвонить у травні без жодної події стадій у травні; угоду менеджера привели передачі
 * 30.04 23:59:30 і 01.05 00:00:30 за Києвом (різні місяці, одне вікно звʼязку).
 * 🧨 САБОТАЖ: в `assembleTrend` ростер на все вікно (`true` → `false`) → червоніє; у `leadgenTrend` передачі
 * лише за місяць `to` → червоніє. Дедуп угоди менеджера з 30.09.2026 — над УСІМ доменом (`#1095`).
 */
test("#682b ЖИВИЙ SQL: місяць тренду == /leadgen-stats і гроші з передач того місяця — з дзвінками, у відділі й команді", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { stats } = await core();
  await client!.query(`INSERT INTO teams (id, name) VALUES (3, 'Лідоген-3'), (4, 'Лідоген-4')`);
  await client!.query(`INSERT INTO managers (id, name, team_id) VALUES (4,'Лідген Г',3),(5,'Лідген Д',3),(6,'Лідген Е',4)`);
  const T = utc("2026-04-30T20:59:30");                                  // 30.04 23:59:30 за Києвом
  const p1 = await deal({ manager: 4, pipeline: PZ, ck: "tr-a" });
  await ev(p1, PZ, LEADGEN_STAGE_IDS.taken, utc("2026-04-10T07:00:00"));
  await ev(p1, PZ, Q, T);                                                // передача квітня
  const p2 = await deal({ manager: 5, pipeline: PZ, ck: "tr-a" });
  await ev(p2, PZ, LEADGEN_STAGE_IDS.taken, utc("2026-05-02T07:00:00"));
  await ev(p2, PZ, Q, sec(T, 60));                                       // 01.05 00:00:30 — передача травня
  const x = await deal({ manager: 3, pipeline: FC[0], status: 142, ck: "tr-a", created: sec(T, 55) });
  await client!.query(`UPDATE deals SET price = 10000, closed_at_kommo = $2 WHERE kommo_id = $1`, [x, utc("2026-05-20T10:00:00")]);
  const p3 = await deal({ manager: 4, pipeline: PZ, ck: null });
  await ev(p3, PZ, LEADGEN_STAGE_IDS.taken, utc("2026-06-05T07:00:00"));
  const p4 = await deal({ manager: 6, pipeline: PZ, ck: null });
  await ev(p4, PZ, LEADGEN_STAGE_IDS.taken, utc("2026-06-09T07:00:00"));
  await ev(p4, PZ, Q, utc("2026-06-10T07:00:00"));                       // без ключа — без угоди
  const p5 = await deal({ manager: 6, pipeline: PZ, ck: "tr-b" });
  await ev(p5, PZ, Q, utc("2026-06-15T07:00:00"));
  await deal({ manager: 3, pipeline: QUAL, status: 69716164, ck: "tr-b", created: utc("2026-06-15T07:00:03") });
  let n = 0;
  for (const [m, when, type, billsec] of [
    [4, "2026-04-11T08:00:00", "out", 30], [4, "2026-05-15T08:00:00", "out", 60],   // травень: подій у 4 немає
    [5, "2026-05-03T08:00:00", "out", 25], [5, "2026-05-03T09:00:00", "out", 5],    // 5 с — не успішний
    [6, "2026-06-09T10:00:00", "in", 100], [6, "2026-06-10T10:00:00", "out", 40],   // вхідний — не рахується
  ] as [number, string, string, number][]) {
    await client!.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, manager_id) VALUES ($1,$2,$3,$4,$5)`,
      [`tr-${n++}`, utc(when), type, billsec, m]);
  }

  const MONTHS: [string, string][] = [["2026-04-01", "2026-04-30"], ["2026-05-01", "2026-05-31"], ["2026-06-01", "2026-06-30"]];
  const shape = (r: { managerId: number; calls: number; leads: number; opr: number; quotes: number; warming: number }) =>
    [r.managerId, r.calls, r.leads, r.opr, r.quotes, r.warming];
  let compared = 0;
  for (const scope of [{ teamId: null, managerId: null }, { teamId: 3, managerId: null }]) {
    const trend = await stats.leadgenTrend("2026-06-30", 3, scope);
    assert.deepEqual(trend.monthStarts, MONTHS.map((m) => m[0]), "журнал памʼятає всі три місяці — порівнювати є що");
    for (const [ms, me] of MONTHS) {
      const s = await stats.leadgenStats(ms, me);
      const want = s.rows.filter((r) => scope.teamId == null || r.teamId === scope.teamId).map(shape).sort();
      const got = trend.byPerson.filter((r) => r.bucket === ms).map(shape).sort();
      assert.deepEqual(got, want, `🔴 ${ms} (команда ${scope.teamId}): рядки тренду ≠ /leadgen-stats того місяця`);
      const hm = await stats.leadgenHandoffMoney(ms, me, scope);
      const tm = trend.money.find((b) => b.bucket === ms);
      assert.deepEqual(tm?.totals, hm.totals, `🔴 ${ms} (команда ${scope.teamId}): гроші тренду ≠ /leadgen-stats того місяця`);
      assert.deepEqual(tm?.byPerson, hm.byPerson, `🔴 ${ms} (команда ${scope.teamId}): гроші людей тренду ≠ того місяця`);
      compared += want.length;
    }
    // Фікстура не вироджена: обидві пастки ревʼю справді присутні в даних.
    const may = await stats.leadgenStats("2026-05-01", "2026-05-31");
    assert.ok(!may.rows.some((r) => r.managerId === 4), "фікстура: у травні людина 4 без подій");
    const money = (ms: string) => trend.money.find((b) => b.bucket === ms)!.totals;
    assert.equal(money("2026-04-01").success.n, 1, "фікстура: квітнева передача веде в успішну угоду");
    // З 30.09.2026 (правило Ярослава, `#1095`): угода належить ПЕРШІЙ передачі — квітневій; травнева — «та сама»,
    // а «Успішні» рахуються в місяць успіху (20.05), не в місяць передачі.
    assert.equal(money("2026-05-01").sameDeal, 1, "🔴 травнева передача в угоду квітневої не стала «тією самою»");
    assert.equal(money("2026-04-01").earned.n, 0, "🔴 успіх 20.05 потрапив у квітень (місяць передачі)");
    assert.equal(money("2026-05-01").earned.n, 1, "🔴 успіх 20.05 не потрапив у травень (місяць успіху)");
  }
  assert.ok(compared >= 5, "фікстура вироджена — порівнювати нема чого");
  const jun = (await stats.leadgenTrend("2026-06-30", 3, { teamId: null, managerId: null })).money[2].totals;
  assert.equal(jun.unlinked, 1, "фікстура: червнева передача без ключа — без угоди");
  assert.equal(jun.work.n, 1, "фікстура: червнева передача в Кваліфікацію — «в роботі»");
});

/**
 * #684b — СПИСОК ПЕРЕДАЧ ІЗ СПРАВЖНЬОГО ЯДРА: назви стадій, префікс Кваліфікації, посилання (ревʼю F4).
 *
 * `#684` доводить правила рядка на тестових залежностях. Тут — що `leadgenHandoffMoney` передає
 * СПРАВЖНІ: реєстр назв (`stageNames`), воронки Кваліфікації (префікс) і `kommoLeadUrl`; і що
 * поля доїжджають із запиту звʼязку (менеджер продажу, причина, фолбек назви на Продзвін).
 * Лютий — власний місяць фікстури, щоб не зачіпати інших гейтів файла.
 * 🧨 САБОТАЖ: у `HANDOFF_ROW_DEPS` `qualificationPipelines: []` → червоніє (а `#684` лишається
 * зеленим — саме тому цей гейт і потрібен).
 */
test("#684b ЖИВИЙ SQL: список передач — справжні назви стадій, префікс Кваліфікації, причина й посилання", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { stats } = await core();
  const pq = await deal({ manager: 1, pipeline: PZ, ck: "rw-q", name: "Продзвін Кваліф" });
  await ev(pq, PZ, Q, utc("2026-02-10T07:00:00"));
  const q = await deal({ manager: 3, pipeline: QUAL, status: 69716164, ck: "rw-q", created: utc("2026-02-10T07:00:02"),
    name: "Київ — Львів" });
  const pn = await deal({ manager: 1, pipeline: PZ, ck: null, name: "Продзвін без угоди" });
  await ev(pn, PZ, Q, utc("2026-02-11T07:00:00"));
  const pl = await deal({ manager: 1, pipeline: PZ, ck: "rw-l", name: "Продзвін програний" });
  await ev(pl, PZ, Q, utc("2026-02-12T07:00:00"));
  const l = await deal({ manager: 3, pipeline: FC[0], status: 143, ck: "rw-l", created: utc("2026-02-12T07:00:05"), name: " " });
  await client!.query(`UPDATE deals SET reject_reason = 'Дорого' WHERE kommo_id = $1`, [l]);

  const hm = await stats.leadgenHandoffMoney("2026-02-01", "2026-02-28", { teamId: null, managerId: null });
  const by = new Map(hm.deals.map((d) => [d.pzId, d]));
  assert.equal(hm.deals.length, 3, "🔴 у лютому три передачі — список їх не всі");
  const rq = by.get(pq)!, rn = by.get(pn)!, rl = by.get(pl)!;
  assert.equal(rq.dealId, q);
  assert.equal(rq.stage, "Кваліфікація · Нова заявка від лідогенератора",
    "🔴 стадія Кваліфікації без префікса або не з реєстру назв");
  assert.equal(rq.cls, "work");
  assert.equal(rq.salesManager, "Продажі В", "🔴 менеджер продажу не доїхав із запиту звʼязку");
  assert.equal(rq.route, "Київ — Львів");
  assert.ok(rq.url?.endsWith(`/leads/detail/${q}`), `🔴 посилання «${rq.url}» не на угоду менеджера`);
  assert.equal(rn.cls, "none");
  assert.equal(rn.stage, null);
  assert.equal(rn.route, "Продзвін без угоди", "🔴 «без угоди» без назви Продзвону");
  assert.ok(rn.url?.endsWith(`/leads/detail/${pn}`), `🔴 «без угоди» веде не на угоду Продзвону: ${rn.url}`);
  assert.equal(rl.cls, "lost");
  assert.equal(rl.reason, "Дорого", "🔴 програна угода без причини відмови");
  assert.equal(rl.stage, "Закрито і не реалізовано", "🔴 143 повного циклу — з префіксом або без назви");
  assert.equal(rl.route, "Продзвін програний", "🔴 порожня назва угоди менеджера не впала на назву Продзвону");
  // Підсумок списку — з того самого виклику (дзеркало `#677` на живих даних).
  assert.equal(hm.totals.handoffs, hm.deals.length);
});

/**
 * #748 — РОСТЕР НА ЖИВОМУ SQL: справжні `leadgenStats` + `leadgenTeamMembers` (пул ядра на тимчасовій
 * базі) → рядки = активні учасники 50011 (з нульовим рядком того, хто без подій), «інші» = решта;
 * Σ рядків + Σ інших == підсумок відділу == `leadgenStats().totals`. Вимкнений у Налаштуваннях — не учасник.
 * 🧨 САБОТАЖ: у `leadgenTeamMembers` прибрати `AND ${activeManagerSql("m")}` → «Вимкнений» стає рядком → червоніє.
 */
test("#748 ЖИВИЙ SQL: ростер — активні учасники 50011, інші окремо, Σ рядків + Σ інших == відділ", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { stats, lgPlans } = await core();
  const { leadgenRosterView, rosterInvariantBreaks } = await import("./leadgenPlanRules.js");
  const st = await stats.leadgenStats("2025-03-01", "2025-03-31");
  const members = await lgPlans.leadgenTeamMembers();
  assert.deepEqual(members.map((m) => m.managerId).sort(), [60, 61, 64], "🔴 склад команди не той (вимкнений у Налаштуваннях чи чужі)");
  const zero = (m: { managerId: number; name: string; teamId: number | null; teamName: string | null }) =>
    ({ ...m, isActive: true, leads: 0, opr: 0, quotes: 0, warming: 0, calls: 0 });
  const v = leadgenRosterView(st.rows, members, null, zero);
  assert.deepEqual(v.rows.map((r) => r.managerId).sort(), [60, 61, 64]);
  assert.deepEqual(v.others.map((r) => r.managerId).sort(), [62, 63], "🔴 «інші» — не всі, хто з подіями поза командою");
  assert.deepEqual(v.totals, st.totals, "🔴 підсумок відділу змінився");
  assert.deepEqual(rosterInvariantBreaks(v), []);
  // 5, а не 4: у людини 60 окрема угода лише з ОПР — з 30.09.2026 це теж лід (`leadStatusPred`, задача 4668).
  assert.equal(st.totals.leads, 5, "фікстура: 5 лідів у березні 2025 — інакше перевіряти нічого");
  const lead = leadgenRosterView(st.rows, members, 50011, zero);
  assert.deepEqual(lead.rows.map((r) => r.managerId).sort(), [60, 61, 63, 64], "🔴 тімлід 50011 бачить не свою команду");
  assert.deepEqual(lead.others, []);
});

/**
 * #749 — ЦИКЛ ПЛАНУ НА ЖИВІЙ БАЗІ: подано → затверджено (живий план) → подано знову (живий лишився) →
 * повернуто (живий лишився) — і продажні `plans`/`plan_formation` НЕ ЗМІНИЛИСЬ ані рядком (рішення 6).
 * CHECK таблиці відхиляє чужу метрику й відʼємне значення (перевірка НА ВІДХИЛЕННЯ, не очима).
 * 🧨 САБОТАЖ: у `returnLeadgenPlan` дописати `approved_value = NULL,` → червоніє (повернення стерло живий план).
 */
test("#749 ЖИВИЙ SQL: подання → затвердження → повторне подання → повернення; продажні plans незаймані", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { lgPlans } = await core();
  const count = async () => (await client!.query(`SELECT (SELECT COUNT(*) FROM plans) + (SELECT COUNT(*) FROM plan_formation) AS n`)).rows[0].n;
  const sales0 = await count();
  const M = "2025-04-01";
  await lgPlans.submitLeadgenPlan(60, M, { leads: 200, opr: 80, quotes: 40, calls: null, money: null }, "перший", 901);
  let f = (await lgPlans.leadgenFormation(M, [60])).get(60)!;
  assert.equal(f.status, "submitted");
  assert.deepEqual(f.approved, { leads: null, opr: null, quotes: null, calls: null, money: null }, "🔴 план став живим до затвердження");
  assert.equal(await lgPlans.approveLeadgenPlans(M, null, 902), 1);
  const ap1 = await lgPlans.approvedLeadgenPlans([60], "2025-04-01", "2025-04-30");
  assert.deepEqual(ap1.get(60)?.get(M), { leads: 200, opr: 80, quotes: 40 });
  await lgPlans.submitLeadgenPlan(60, M, { leads: 250, opr: 90, quotes: 50, calls: null, money: null }, "другий", 901);
  assert.equal(await lgPlans.returnLeadgenPlan(M, 60, "замало", 902), 5, "🔴 повернуто не всі пʼять пунктів (рядок на кожен, і на «не плануємо» теж)");
  f = (await lgPlans.leadgenFormation(M, [60])).get(60)!;
  assert.equal(f.status, "returned");
  assert.deepEqual(f.proposed, { leads: 250, opr: 90, quotes: 50, calls: null, money: null });
  assert.equal(f.returnComment, "замало");
  const ap2 = await lgPlans.approvedLeadgenPlans([60], "2025-04-01", "2025-04-30");
  assert.deepEqual(ap2.get(60)?.get(M), { leads: 200, opr: 80, quotes: 40 }, "🔴 повернення стерло попередній затверджений план");
  assert.equal(await lgPlans.returnLeadgenPlan(M, 60, null, 902), 0, "🔴 повернули те, що вже не на розгляді");
  assert.equal(await count(), sales0, "🔴 цикл лідоген-плану записав у продажні plans/plan_formation");
  await assert.rejects(client!.query(`INSERT INTO leadgen_plans (manager_id, month, metric, proposed_value) VALUES (61, '2025-04-01', 'payment_amount', 1)`),
    /check/i, "🔴 CHECK пропустив продажну метрику");
  await assert.rejects(client!.query(`INSERT INTO leadgen_plans (manager_id, month, metric, proposed_value) VALUES (61, '2025-04-01', 'quotes', -1)`), /check/i);
  await assert.rejects(client!.query(`INSERT INTO leadgen_plans (manager_id, month, metric, proposed_value) VALUES (61, '2025-04-15', 'quotes', 1)`), /check/i,
    "🔴 місяць не з першого числа прийнято");
  await assert.rejects(client!.query(`INSERT INTO plans (manager_id, plan_date, metric, planned_value) VALUES (61, '2025-04-01', 'quotes', 1)`), /check/i,
    "🔴 продажний plans приймає лідоген-метрику");
});

/**
 * #1264 — ЛІД = «ВЗЯТО» АБО «ОПР» ПРОДЗВОНУ АБО «ПІДІГРІВАЄТЬСЯ» РЕАКТИВАЦІЇ; ОПР = «ОПР» АБО «ПІДІГРІВАЄТЬСЯ»
 * (рішення власника 06.10.2026, звірка жовтня з таблицями лідгенів; наступник `#1090`). По обидва боки: A «Взято»+«ОПР»
 * (один лід), B лише ОПР (лід), C лише «Кваліфіковано» (ні), D лише «Взято» (лід), E статус ОПР у воронці Реактивації
 * (ні), F «Підігрівається» (лід і ОПР), G «Взято» Продзвону + «Підігрів» Реактивації однією угодою (ОДИН лід),
 * H «Отримано зворотній зв'язок» Реактивації (ні). Плюс інваріант: лідів ≥ ОПР у кожного за будь-який період.
 * 🧨 САБОТАЖ: в `oprStatusPred` прибрати гілку Реактивації → ОПР людини 70 стає 2 замість 4 → червоніє.
 */
test("#1264 ЖИВИЙ SQL: лід — «Взято»/«ОПР» Продзвону або «Підігрів» Реактивації; ОПР — «ОПР» або «Підігрів»", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const wk = await run<{ manager_id: number; leads: string; opr: string; quotes: string; warming: string }>(
    stageCountsQuery("2025-01-13", "2025-01-19", LEADGEN_STAGE_IDS));
  const r70 = wk.find((r) => r.manager_id === 70);
  assert.ok(r70, "фікстура вироджена — людини 70 у тижні немає");
  assert.deepEqual([Number(r70.leads), Number(r70.opr), Number(r70.quotes), Number(r70.warming)], [5, 4, 1, 2],
    "🔴 ліди/ОПР/прорахунки/підігрів людини 70 не 5/4/1/2: «Підігрів» не став лідом і ОПР, угода G порахована двічі або «зворотній зв'язок» прийнято за лід");
  const all = await run<{ manager_id: number; leads: string; opr: string }>(stageCountsQuery("2025-01-01", "2026-12-31", LEADGEN_STAGE_IDS));
  assert.ok(all.length >= 4, "фікстура вироджена — людей замало");
  for (const r of all) assert.ok(Number(r.leads) >= Number(r.opr), `🔴 людина ${r.manager_id}: лідів ${r.leads} < ОПР ${r.opr}`);
});

/**
 * #1090b — ТРИ ЛІЧИЛЬНИКИ ЛІДІВ, ОДНЕ ПРАВИЛО: рядок людини (`leadgenStats().rows`), розріз за джерелом
 * (`bySource`) і тижні (`leadgenWeekly`) — справжнє ядро на тимчасовій базі. Друга копія предиката в
 * будь-якому з них розійшлась би мовчки: екран показав би 3 ліди в рядку й 2 у «Звідки ліди».
 * 🧨 САБОТАЖ: у запиті `bySource` (`leadgenStats.ts`) у плейсхолдерах `leadStatusPred` замінити `warming: "$7"` на `warming: "$4"` (лишається ВАЛІДНИМ) → червоніє саме розріз. Стара примітка: замінити `"$5"` на `"$4"` і дописати
 * `AND $5::bigint > 0` (запит лишається ВАЛІДНИМ, змінюється лише зміст) → червоніє саме розріз. Просто прибрати `$5`
 * не можна: Postgres упаде на невизначеному типі параметра, і червоне доведе аварію, а не гейт (♾ правило 6).
 */
test("#1090b ЖИВИЙ SQL: рядок, джерела й тижні рахують ліди одним правилом", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { stats } = await core();
  const st = await stats.leadgenStats("2025-01-13", "2025-01-19");
  const row = st.rows.find((r) => r.managerId === 70);
  assert.equal(row?.leads, 5, "🔴 рядок людини рахує ліди не за правилом");
  assert.deepEqual(st.bySource.map((s) => [s.source, s.leads]).sort(), [["Холодная база", 2], ["Реактивація закриті", 1], ["Реактивація наша база", 2]].sort(),
    "🔴 розріз за джерелом рахує ліди іншим правилом, ніж рядок");
  const weeks = await stats.leadgenWeekly("2025-01-13", "2025-01-19");
  assert.deepEqual(weeks.map((w) => [w.week, w.leads, w.opr]), [["2025-01-13", 5, 4]], "🔴 тижні рахують ліди іншим правилом, ніж рядок");
});

/**
 * #1091c — ПОСТІЙНИЙ КЛІЄНТ НАСКРІЗЬ: справжні `money.clientSuccessHistory` і `leadgenHandoffMoney` на
 * тимчасовій базі (задача 4668, п.5). Успіх клієнта — рівно клас `success`: повний цикл, 142, є
 * `closed_at`, не мінусова. Поруч — усе, що схоже, але НЕ успіх: 142 без `closed_at`, 142 Кваліфікації,
 * «Оплата отримана», мінусова 142. Дві передачі одного дня: клієнта з 2 успіхами до передачі — `regular`
 * (поза грошима), клієнта з 1 успіхом — у «Успішних». Лютий 2025 — поза вікнами решти гейтів.
 * 🧨 САБОТАЖ: у `clientSuccessHistory` прибрати `AND NOT d.is_minus` → у «k-one» стає 2 успіхи → червоніє.
 */
test("#1091c ЖИВИЙ SQL: історія успіхів — лише FC-142 з closed_at без мінусових; передача постійного — поза грошима", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { money, stats } = await core();
  await client!.query(`INSERT INTO managers (id, name, team_id) VALUES (71,'Лідген Постійні',1) ON CONFLICT DO NOTHING`);
  const hist = async (ck: string, pipeline: number, status: number, closed: string | null, minus = false) => {
    const id = await deal({ manager: 3, pipeline, status, ck, created: utc("2024-12-01T08:00:00") });
    await client!.query(`UPDATE deals SET closed_at_kommo = $2, is_minus = $3, price = 1000 WHERE kommo_id = $1`,
      [id, closed == null ? null : utc(closed), minus]);
  };
  const PAID = 69716460;
  await hist("k-reg", FC[0], Q, "2025-01-10T10:00:00");
  await hist("k-reg", FC[1], Q, "2025-02-01T10:00:00");
  await hist("k-one", FC[0], Q, "2025-01-20T10:00:00");
  await hist("k-one", FC[0], Q, null);                              // 142 без closed_at — не успіх
  await hist("k-one", QUAL, Q, "2025-01-21T10:00:00");               // 142 Кваліфікації — не успіх
  await hist("k-one", FC[0], PAID, "2025-01-22T10:00:00");           // «Оплата отримана» — не успіх
  await hist("k-one", FC[0], Q, "2025-01-23T10:00:00", true);        // мінусова — не перевезення
  const handoff = async (ck: string) => {
    const pz = await deal({ manager: 71, pipeline: PZ, ck });
    const at = utc("2025-02-10T09:00:00");
    await ev(pz, PZ, Q, at);
    const md = await deal({ manager: 3, pipeline: FC[0], status: Q, ck, created: sec(at, 30) });
    await client!.query(`UPDATE deals SET closed_at_kommo = $2, price = 5000 WHERE kommo_id = $1`, [md, utc("2025-02-20T10:00:00")]);
    return pz;
  };
  const pzReg = await handoff("k-reg"), pzOne = await handoff("k-one");
  const h = await money.clientSuccessHistory(["k-reg", "k-one"]);
  assert.deepEqual((h.get("k-reg") ?? []).map((x) => x.day).sort(), ["2025-01-10", "2025-02-01", "2025-02-20"],
    "🔴 історія постійного клієнта не та (успіх — FC-142 з closed_at, обидві FC-воронки)");
  assert.deepEqual((h.get("k-one") ?? []).map((x) => x.day).sort(), ["2025-01-20", "2025-02-20"],
    "🔴 в історію потрапило те, що не є успішним перевезенням (без closed_at / Кваліфікація / оплата / мінусова)");
  const hm = await stats.leadgenHandoffMoney("2025-02-10", "2025-02-10", { teamId: null, managerId: null });
  const cls = new Map(hm.deals.map((d) => [d.pzId, d.cls]));
  assert.equal(cls.get(pzReg), "regular", "🔴 передача клієнта з 2 успіхами ДО неї не визнана постійною");
  assert.equal(cls.get(pzOne), "success", "🔴 клієнт з одним успіхом до передачі визнаний постійним");
  assert.deepEqual([hm.totals.success.n, hm.totals.success.sum, hm.totals.regular.n, hm.totals.regular.sum], [1, 5000, 1, 5000],
    "🔴 гроші лідгена не без постійного, або постійного не названо числом");
});

/**
 * #1093 — МЕЖА «УСПІШНОГО ДЗВІНКА» НЕВКЛЮЧНА: розмова ДОВША за 8 с, як фільтр Ringostat «тривалість
 * більше 00:08», яким рахує Ярослав (30.09.2026: з `>= 8` Сердюк мав 1 106 проти 1 102 у Ringostat — рівно
 * 4 дзвінки по 8 с). Справжній `leadgenStats` на тимчасовій базі; фікстура — по обидва боки межі:
 * 7 і 8 с — ні, 9 і 60 с — так; вхідний 60 с — ні (напрямок).
 * 🧨 САБОТАЖ: у `callsQuery` (`leadgenStats.ts`) `c.billsec > $4` → `c.billsec >= $4` → червоніє.
 */
test("#1093 ЖИВИЙ SQL: успішний дзвінок — вихідний, розмова ДОВША за 8 с (8 с — ні, 9 с — так)", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { stats } = await core();
  let k = 0;
  for (const [type, sec] of [["out", 7], ["out", 8], ["out", 9], ["out", 60], ["in", 60]] as [string, number][]) {
    await client!.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, manager_id) VALUES ($1, $2, $3, $4, 70)`,
      [`gt8-${k++}`, utc("2025-01-14T10:00:00"), type, sec]);
  }
  const st = await stats.leadgenStats("2025-01-13", "2025-01-19");
  const row = st.rows.find((r) => r.managerId === 70);
  assert.ok(row, "фікстура вироджена — людини 70 у тижні немає");
  assert.equal(row.calls, 2, "🔴 успішні дзвінки не ті: рахуються лише вихідні, ДОВШІ за 8 с (як фільтр Ringostat «більше 00:08»)");
});

/**
 * #1094b — УГОДА МЕНЕДЖЕРА ЗА ПРИМІТКОЮ KOMMO, А НЕ ЗДОГАДОМ (30.09.2026, угода 62668945). Кожен бік:
 * без клієнта, але з приміткою — звʼязано (раніше — «без угоди»); примітка проти здогаду — примітка;
 * дочірня з примітки поза вікном цього входу — здогад; ні того, ні іншого — без угоди.
 * 🧨 САБОТАЖ: у `handoffLinkQuery` поміняти пріоритети (`0 AS prio` ↔ `1 AS prio`) → червоніє «n-conflict»;
 * прибрати вікно з гілки примітки → червоніє «n-outside».
 */
test("#1094b ЖИВИЙ SQL: угода менеджера — спершу за приміткою Kommo, здогад за клієнтом — лише без неї", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const rows = await run<{ pz_id: string; deal_id: string | null; link_prio: number | null }>(linkQ("2025-06-10", "2025-06-10"));
  const got = new Map(rows.map((r) => [Number(r.pz_id), r]));
  for (const [k, prio] of [["n-nokey", 0], ["n-conflict", 0], ["n-outside", 1], ["n-none", null]] as [string, number | null][]) {
    const r = got.get(fx[k].pz);
    assert.ok(r, `🔴 передача ${k} зникла з результату`);
    assert.equal(r.deal_id == null ? null : Number(r.deal_id), fx[k].want, `🔴 ${k}: угода менеджера ${r.deal_id} замість ${fx[k].want}`);
    assert.equal(r.link_prio == null ? null : Number(r.link_prio), prio, `🔴 ${k}: звʼязано не тим шляхом`);
  }
  assert.equal(rows.length, 4, "🔴 гілки звʼязку розмножили передачі");
});

/**
 * #1095b — ДАТИ ГРОШЕЙ НА ЖИВОМУ SQL: справжній `money.handoffDealStates` дає дату закриття й дату «авто
 * поїхало» = ПЕРШИЙ вхід у «Авто працює» чи далі (обидві воронки повного циклу), без «фантомного» 142 на
 * початку шляху й без етапів ДО авто («Виставлення рахунку»). Наскрізь: передача липня 2025, успіх
 * серпня → «Успішні» серпня, не липня.
 * 🧨 САБОТАЖ: у `HANDOFF_CLASS_RULES.autoWent` додати 142 → дата авто зсувається на фантомний 142 → червоніє.
 */
test("#1095b ЖИВИЙ SQL: дата успіху й дата авто для грошей; передача липня з успіхом серпня — у серпні", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { money, stats } = await core();
  await client!.query(`INSERT INTO managers (id, name, team_id) VALUES (72,'Лідген Гроші',1) ON CONFLICT DO NOTHING`);
  const at = utc("2025-07-07T09:00:00");
  const pz = await deal({ manager: 72, pipeline: PZ, ck: "m-1" }); await ev(pz, PZ, Q, at);
  const md = await deal({ manager: 3, pipeline: FC[0], status: Q, ck: "m-1", created: sec(at, 20) });
  await client!.query(`UPDATE deals SET closed_at_kommo = $2, price = 8000 WHERE kommo_id = $1`, [md, utc("2025-08-20T10:00:00")]);
  await ev(md, FC[0], Q, utc("2025-07-08T08:00:00"));            // фантомний 142 на початку шляху
  await ev(md, FC[0], 100274340, utc("2025-07-20T08:00:00"));    // «Виставлення рахунку» — ще не авто
  await ev(md, FC[0], 69716300, utc("2025-08-05T08:00:00"));     // «Авто працює» — дата авто
  await ev(md, FC[0], Q, utc("2025-08-20T10:00:00"));
  const st = (await money.handoffDealStates([md])).get(md);
  assert.equal(st?.closedDay, "2025-08-20", "🔴 дата успіху не з closed_at за Києвом");
  assert.equal(st?.autoDay, "2025-08-05", "🔴 дата авто — не перший вхід у «Авто працює» чи далі (фантомний 142 / рахунок?)");
  const aug = await stats.leadgenHandoffMoney("2025-08-01", "2025-08-31", { teamId: null, managerId: 72 });
  const jul = await stats.leadgenHandoffMoney("2025-07-01", "2025-07-31", { teamId: null, managerId: 72 });
  assert.deepEqual([aug.totals.earned.n, aug.totals.earned.sum], [1, 8000], "🔴 успіх серпня з липневої передачі не в серпні");
  assert.equal(jul.totals.earned.n, 0, "🔴 успіх серпня потрапив у липень (місяць передачі)");
  assert.equal(jul.totals.handoffs, 1, "фікстура: передача — у липні");
  assert.equal(aug.deals.find((d) => d.pzId === pz)?.inPeriod, false, "🔴 у списку серпня угода не позначена «передано раніше»");
});
/**
 * #1173 — ДЗВІНКИ Й ГРОШІ В ПЛАНІ, НЕОБОВʼЯЗКОВІ (Ярослав, рішення власника 01.10.2026), на живому SQL.
 * Подання з дзвінками й грошима → затвердження → обидва живі; повторне подання БЕЗ грошей → після
 * затвердження грошей у плані НЕМАЄ (а не «лишились з минулого подання»). База приймає `calls`/`money`
 * і відмовляє невідомому пункту.
 * 🧨 САБОТАЖ: у `submitLeadgenPlan` пропускати пункти зі значенням `null` → гроші з першого подання
 * лишаються живими після другого → червоніє.
 */
test("#1173 ЖИВИЙ SQL: план на дзвінки й гроші — необовʼязковий; пропущений пункт після затвердження зникає", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const { lgPlans } = await core();
  const M = "2025-03-01";
  await lgPlans.submitLeadgenPlan(60, M, { leads: 10, opr: 5, quotes: 3, calls: 1200, money: 150000 }, null, 901);
  await lgPlans.approveLeadgenPlans(M, 60, 902);
  let ap = (await lgPlans.approvedLeadgenPlans([60], M, "2025-03-31")).get(60)?.get(M);
  assert.deepEqual(ap, { leads: 10, opr: 5, quotes: 3, calls: 1200, money: 150000 }, "🔴 дзвінки чи гроші не стали живим планом");
  await lgPlans.submitLeadgenPlan(60, M, { leads: 11, opr: 5, quotes: 3, calls: 1300, money: null }, null, 901);
  const f = (await lgPlans.leadgenFormation(M, [60])).get(60)!;
  assert.equal(f.proposed.money, null, "🔴 «не плануємо» прочиталось як число");
  assert.equal(f.approved.money, 150000, "🔴 до затвердження нового живий план мусить лишатись попереднім");
  await lgPlans.approveLeadgenPlans(M, 60, 902);
  ap = (await lgPlans.approvedLeadgenPlans([60], M, "2025-03-31")).get(60)?.get(M);
  assert.deepEqual(ap, { leads: 11, opr: 5, quotes: 3, calls: 1300 },
    "🔴 гроші з ПОПЕРЕДНЬОГО подання лишились живими, хоча нове подання їх не планувало");
  // База: новий пункт приймається, невідомий — ні.
  await assert.rejects(client!.query(
    `INSERT INTO leadgen_plans (manager_id, month, metric, proposed_value) VALUES (60, '2025-02-01', 'revenue', 1)`),
    /leadgen_plans_metric_check/, "🔴 база прийняла пункт, якого немає в переліку");
  await client!.query(`INSERT INTO leadgen_plans (manager_id, month, metric, proposed_value) VALUES (60, '2025-02-01', 'money', 1)`);
});

/**
 * #1260 — «ПРИЙНЯТО ЛІДОГЕН» НА ЖИВОМУ SQL (рішення власника 05.10.2026): угода менеджера, яку Kommo створила з
 * угоди Продзвону (`lead_child_links`), — рахується; угода з каналом «лідоген», але без звʼязку, — ні; створена
 * поза періодом — ні; створена з угоди НЕ з Продзвону — ні; угода в чужій воронці (не Кваліфікація/повний цикл) — ні.
 * 🧨 САБОТАЖ: у `leadgenAcceptedByManager` прибрати `AND p.pipeline_id = ANY($1::bigint[])` → звʼязок з не-Продзвону
 * рахується → червоніє.
 */
test("#1260 ЖИВИЙ SQL: прийнято лідоген — лише угоди, створені Kommo з передачі Продзвону, у періоді", async (t) => {
  if (!client) return t.skip(skip ?? "кластер не піднявся");
  const metrics = await import("./metrics.js");
  await client!.query(`INSERT INTO managers (id, name, team_id, is_active) VALUES (80,'Продажі Прийм',1,true) ON CONFLICT (id) DO NOTHING`);
  const mk = async (id: number, pipeline: number, created: string, channel: string | null = null) =>
    client!.query(`INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, created_at_kommo, lead_channel) VALUES ($1,$2,80,$3,1,$4,$5)`,
      [id, `угода ${id}`, pipeline, created, channel]);
  const link = (parent: number, child: number) => client!.query(`INSERT INTO lead_child_links (parent_id, child_id, created_at) VALUES ($1,$2,now())`, [parent, child]);
  await mk(810001, PZ, "2025-02-01T09:00:00Z");                    // угода Продзвону (батько)
  await mk(810002, 9999999, "2025-02-01T09:00:00Z");               // батько НЕ з Продзвону
  await mk(810011, FC[0], "2025-02-10T09:00:00Z"); await link(810001, 810011);          // ✅ рахується
  await mk(810012, QUAL, "2025-02-11T09:00:00Z"); await link(810001, 810012);           // ✅ рахується (Кваліфікація)
  await mk(810013, FC[0], "2025-02-12T09:00:00Z", "leadgen");                          // ❌ канал є, звʼязку немає
  await mk(810014, FC[0], "2025-03-01T09:00:00Z"); await link(810001, 810014);          // ❌ поза періодом
  await mk(810015, FC[0], "2025-02-13T09:00:00Z"); await link(810002, 810015);          // ❌ батько не з Продзвону
  await mk(810016, 9999999, "2025-02-14T09:00:00Z"); await link(810001, 810016);        // ❌ не воронка менеджера
  const rows = await metrics.leadgenAcceptedByManager({ from: "2025-02-01", to: "2025-02-28", managerId: 80 });
  assert.deepEqual(rows, [{ managerId: 80, count: 2 }],
    "🔴 «прийнято лідоген» не рівно 2: рахує канал без звʼязку, угоду поза періодом, звʼязок не з Продзвону чи чужу воронку");
  // 🪞 Межа періоду включно, по-київськи: 28.02 23:30 Київ (21:30 UTC) — ще лютий.
  await mk(810017, FC[0], "2025-02-28T21:30:00Z"); await link(810001, 810017);
  const r2 = await metrics.leadgenAcceptedByManager({ from: "2025-02-01", to: "2025-02-28", managerId: 80 });
  assert.equal(r2[0]?.count, 3, "🔴 угода, створена 28.02 о 23:30 за Києвом, випала з лютого — межа не київська або не включна");
});
