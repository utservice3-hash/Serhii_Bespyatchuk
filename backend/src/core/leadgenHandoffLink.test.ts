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
  const [money, stats] = await Promise.all([import("./money.js"), import("./leadgenStats.js")]);
  return { money, stats };
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
 * #682b — МІСЯЦЬ ТРЕНДУ == `/leadgen-stats` + ГРОШІ ТОГО МІСЯЦЯ, НА ЖИВОМУ SQL (ревʼю F2).
 *
 * `#676b` звіряв лише чотири лічильники стадій двома формами одного запиту. Тут — СПРАВЖНІ
 * `leadgenTrend`, `leadgenStats` і `leadgenHandoffMoney` через пул ядра: для кожного місяця вікна
 * рядки людей тренду (з ДЗВІНКАМИ) == рядкам `leadgenStats` того місяця, а гроші тренду ==
 * `leadgenHandoffMoney` того місяця, у відділі й у команді. Фікстура тримає обидві пастки ревʼю:
 * людина 4 дзвонить у травні без жодної події стадій у травні; угоду менеджера привели передачі
 * 30.04 23:59:30 і 01.05 00:00:30 за Києвом (різні місяці, одне вікно звʼязку).
 * 🧨 САБОТАЖ: в `assembleTrend` ростер на все вікно (`true` → `false`) → червоніє; дедуп над
 * передачами всього вікна → червоніє; у `leadgenTrend` передачі лише за місяць `to` → червоніє.
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
    assert.equal(money("2026-05-01").success.n, 1, "🔴 травнева передача в ту саму угоду стала «тією самою» — дедуп вийшов за місяць");
  }
  assert.ok(compared >= 5, "фікстура вироджена — порівнювати нема чого");
  const jun = (await stats.leadgenTrend("2026-06-30", 3, { teamId: null, managerId: null })).money[2].totals;
  assert.equal(jun.unlinked, 1, "фікстура: червнева передача без ключа — без угоди");
  assert.equal(jun.work.n, 1, "фікстура: червнева передача в Кваліфікацію — «в роботі»");
});
