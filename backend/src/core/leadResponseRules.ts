import { clockStart, median } from "./leadTakeRules.js";

/**
 * 📞 «ВІДПОВІДЬ НА ЗАЯВКУ» — від створення заявки до ПЕРШОГО НАБОРУ менеджера (задача 5148, ТЗ Юлі 05.10.2026:
 * «середній час відповіді на заявку (від створення заявки до першого дзвінка) — у розділ «Пропущені дзвінки»,
 * щоб був один екран по швидкості реакції»). Чисте — без БД.
 *
 * Рішення Романа 12.10.2026:
 *  · головне число — МЕДІАНА, а не середнє: середнє за 28.09–04.10 було 650 хв проти медіани 12,7 — його тягнуть
 *    кілька заявок, яким передзвонили через дні; решта розділу й Юлин зріз теж у медіанах;
 *  · ЛІДГЕНИ — окремо: це передані заявки, їх передзвонюють годинами (медіана 45 хв за 05–11.10), і в медіані
 *    відділу (реклама + сайт) вони не рахуються;
 *  · «перший дзвінок» = ПЕРШИЙ НАБІР, навіть без відповіді; окремо видно, скільки разів клієнт не взяв трубку.
 * Нічна заявка рахується від 08:15 найближчого робочого дня — той самий годинник, що у вікні «Час опрацювання
 * заявки» (`clockStart`), щоб на двох екранах «швидкість» не мірялась двома лінійками.
 */

export type DialAnswer = "yes" | "no" | "unknown";

export interface FirstDial { at: number; sec: number | null }

/**
 * Перший набір — найраніший із двох джерел: нотатка дзвінка в Kommo (`first_call_out_at` / `_sec`) і запис
 * Ringostat за ключем клієнта. Тривалість — САМЕ того дзвінка, що перший; невідома — `null`, а не 0.
 */
export function firstDial(note: { at: number | null; sec: number | null }, rc: { at: number | null; sec: number | null }): FirstDial | null {
  const cands = [note, rc].filter((x): x is { at: number; sec: number | null } => x.at != null);
  if (!cands.length) return null;
  const best = cands.reduce((a, b) => (b.at < a.at ? b : a));
  return { at: best.at, sec: best.sec };
}

/** 0 с — набрав, клієнт не взяв трубку; більше — розмова була; невідомо — так і кажемо. */
export function answerOf(sec: number | null): DialAnswer {
  if (sec == null) return "unknown";
  return sec > 0 ? "yes" : "no";
}

export interface ResponseRow {
  createdAt: number;
  dial: FirstDial | null;
}

/** Хвилини від старту годинника (нічна заявка — від 08:15) до першого набору; набору не було — `null`. */
export function responseMinutes(r: ResponseRow): number | null {
  if (!r.dial || r.dial.at < r.createdAt) return null;
  return Math.max(0, r.dial.at - clockStart(r.createdAt)) / 60_000;
}

export interface ResponseStats {
  n: number;
  dialed: number;
  notDialed: number;
  medianMin: number | null;
  /** Частка ВСІХ заявок, яким набрали за 5 хв, %. */
  m5Pct: number | null;
  /** Перший набір без відповіді (0 с). */
  noAnswer: number;
  /** Перший набір є, а тривалість невідома (історія до 12.10.2026 без дозаповнення). */
  answerUnknown: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function responseStats(rows: ResponseRow[]): ResponseStats {
  const mins = rows.map(responseMinutes);
  const got = mins.filter((m): m is number => m != null);
  const n = rows.length;
  const dialedRows = rows.filter((_, i) => mins[i] != null);
  const med = median(got);
  return {
    n,
    dialed: got.length,
    notDialed: n - got.length,
    medianMin: med == null ? null : r1(med),
    m5Pct: n > 0 ? r1((got.filter((m) => m <= 5).length / n) * 100) : null,
    noAnswer: dialedRows.filter((r) => answerOf(r.dial!.sec) === "no").length,
    answerUnknown: dialedRows.filter((r) => answerOf(r.dial!.sec) === "unknown").length,
  };
}

/**
 * SQL рядків показника над готовою вибіркою заявок (`leadSelection` у `leadTake.ts`). Окремо від виконання, щоб гейт
 * прогнав САМЕ цей текст на тимчасовій базі: SQL у шаблонному рядку компілятор не перевіряє.
 * `mainSources` — джерела відділу (реклама + сайт); решта вибірки — лідгени.
 */
export function responseRowsSql(sel: { conds: string[]; params: unknown[]; teamSql: string }, mainSources: readonly string[]): { sql: string; params: unknown[] } {
  const params = [...sel.params, [...mainSources]];
  const main = `$${params.length}`;
  return {
    params,
    sql: `SELECT d.created_at_kommo AS created, d.manager_id, m.name AS manager, ${sel.teamSql} AS team_id, t.name AS team,
            -- без джерела (NULL = ANY дає NULL, а не false) — не відділ: явно, а не випадково через falsy.
            COALESCE(d.client_source = ANY(${main}), false) AS is_main,
            d.first_call_out_at AS note_at, d.first_call_out_sec AS note_sec,
            rc1.calldate AS rc_at, rc1.billsec AS rc_sec
       FROM deals d
       LEFT JOIN managers m ON m.id = d.manager_id
       LEFT JOIN teams t ON t.id = ${sel.teamSql}
       -- Перший вихідний запис Ringostat того самого клієнта — той самий, що бере вікно «Час опрацювання».
       LEFT JOIN LATERAL (SELECT rc.calldate, rc.billsec FROM ringostat_calls rc
                           WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key
                             AND rc.call_type IN ('out', 'transitout') AND rc.calldate >= d.created_at_kommo
                           ORDER BY rc.calldate LIMIT 1) rc1 ON true
      WHERE ${sel.conds.join(" AND ")}`,
  };
}

/**
 * Запис першого вихідного дзвінка з нотаток Kommo (джоба активності). Тривалість ЇДЕ ЗА ЧАСОМ: міняється лише коли
 * цей дзвінок став першим, або коли це той самий дзвінок, а тривалості ще немає (записи до 12.10.2026). SET бачить
 * СТАРІ значення рядка, тож порівняння з `d.first_call_out_at` — це порівняння з тим, що було до оновлення.
 * $1 — id угод, $2 — час, $3 — тривалість, с (NULL — невідома).
 */
export const FIRST_CALL_UPDATE_SQL = `UPDATE deals d SET first_call_out_at = LEAST(d.first_call_out_at, v.co),
              first_call_out_sec = CASE WHEN d.first_call_out_at IS NULL OR v.co < d.first_call_out_at
                                          OR (v.co = d.first_call_out_at AND d.first_call_out_sec IS NULL)
                                        THEN v.sec ELSE d.first_call_out_sec END
         FROM (SELECT UNNEST($1::bigint[]) AS kommo_id, UNNEST($2::timestamptz[]) AS co, UNNEST($3::int[]) AS sec) v
        WHERE d.kommo_id = v.kommo_id AND v.co >= d.created_at_kommo`;

export interface ResponseLine extends ResponseStats { key: string; label: string }
export interface ResponseTeam extends ResponseLine { managers: ResponseLine[] }
export interface ResponseTable {
  dept: ResponseLine;
  teams: ResponseTeam[];
  leadgen: ResponseTeam;
}

export interface ResponseRawRow extends ResponseRow {
  kind: "main" | "leadgen";
  managerId: number | null; manager: string | null;
  teamId: number | null; team: string | null;
}

/** Рядки → ієрархія. Чиста, щоб гейт міг довести «Σ команд = відділ» на власній фікстурі. */
export function buildResponseTable(rows: ResponseRawRow[]): ResponseTable {
  const line = (key: string, label: string, rs: ResponseRawRow[]): ResponseLine => ({ key, label, ...responseStats(rs) });
  const byManager = (rs: ResponseRawRow[], prefix: string): ResponseLine[] => {
    const m = new Map<string, ResponseRawRow[]>();
    for (const r of rs) { const k = r.managerId == null ? "∅" : String(r.managerId); m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m].map(([k, xs]) => line(`${prefix}:m:${k}`, xs[0].manager ?? "Без відповідального", xs))
      .sort((a, b) => (b.medianMin ?? -1) - (a.medianMin ?? -1) || a.label.localeCompare(b.label, "uk"));
  };
  const main = rows.filter((r) => r.kind === "main");
  const lg = rows.filter((r) => r.kind === "leadgen");
  const byTeam = new Map<string, ResponseRawRow[]>();
  for (const r of main) { const k = r.teamId == null ? "∅" : String(r.teamId); byTeam.set(k, [...(byTeam.get(k) ?? []), r]); }
  const teams = [...byTeam].map(([k, xs]) => ({
    ...line(`t:${k}`, xs[0].team ?? "Без команди", xs), managers: byManager(xs, `t:${k}`),
  })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, "uk"));
  return {
    dept: line("dept", "Відділ (реклама + сайт)", main),
    teams,
    leadgen: { ...line("leadgen", "Лідгени (окремо)", lg), managers: byManager(lg, "lg") },
  };
}

