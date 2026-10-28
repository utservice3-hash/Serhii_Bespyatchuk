import { pool } from "../db/pool.js";
import { AD_SOURCES, SITE_SOURCES, leadSelection } from "./leadTake.js";
import { elogistMarkSql } from "./elogist.js";
import { firstDial, responseRowsSql, buildResponseTable, type ResponseRawRow, type ResponseTable } from "./leadResponseRules.js";
export type { ResponseLine, ResponseTable } from "./leadResponseRules.js";

/**
 * 📞 «ВІДПОВІДЬ НА ЗАЯВКУ» (задача 5148) — таблиця для розділу «Пропущені дзвінки». Правила — `leadResponseRules.ts`,
 * множина заявок — та сама, що у вікні «Час опрацювання заявки» (`leadSelection`).
 *
 * Будова: ВІДДІЛ (реклама + сайт) → команди (на дату створення заявки) → менеджери; ЛІДГЕНИ — окремим блоком
 * зі своїми менеджерами й до медіани відділу не входять (рішення Романа 12.10.2026).
 */

export async function loadResponseRows(q: { from: string; to: string; managerId?: number | null; teamId?: number | null }): Promise<ResponseRawRow[]> {
  // 🟣 eLogist (окремий канал з 27.10.2026) сюди НЕ входить: «Все» вікна «Час опрацювання» тепер
  // включає eLogist, а цей екран — про заявки UTS (реклама + сайт + лідгени). Без цього рядка
  // eLogist-заявки (їхнє «Источник клиента» не в джерелах UTS) упали б у блок «лідгени» як не-основні.
  const sel = leadSelection({ ...q, source: "all" });
  sel.conds.push(`NOT ${elogistMarkSql("d")}`);
  const { sql, params } = responseRowsSql(sel, [...AD_SOURCES, ...SITE_SOURCES]);
  const r = await pool.query<{
    created: Date; manager_id: number | null; manager: string | null; team_id: number | null; team: string | null;
    is_main: boolean; note_at: Date | null; note_sec: number | null; rc_at: Date | null; rc_sec: number | null;
  }>(sql, params);
  const ms = (x: Date | null) => (x == null ? null : x.getTime());
  return r.rows.map((x) => ({
    createdAt: x.created.getTime(),
    // Заявка з рекламного джерела, яку вів лідген, лишається рекламною: «лідген» — лише те, що не з сайтів.
    kind: x.is_main ? "main" : "leadgen",
    dial: firstDial({ at: ms(x.note_at), sec: x.note_sec }, { at: ms(x.rc_at), sec: x.rc_sec }),
    managerId: x.manager_id, manager: x.manager, teamId: x.team_id, team: x.team,
  }));
}

export async function leadResponseTable(q: { from: string; to: string; managerId?: number | null; teamId?: number | null }): Promise<ResponseTable> {
  return buildResponseTable(await loadResponseRows(q));
}
