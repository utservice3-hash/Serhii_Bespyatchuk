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
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
const FC = [8921932, 155304];   // воронки повного циклу у фікстурі; у ядрі — `money.FC_PIPELINES`
const PZ = LEADGEN_STAGE_IDS.pz[0], QUAL = QUALIFICATION_PIPELINES[0], OTHER = 9999999;
const Q = LEADGEN_STAGE_IDS.qualified;

type C = import("pg").Client;
let client: C | null = null;
let skip: string | null = null;
let dispose: (() => void) | null = null;

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
