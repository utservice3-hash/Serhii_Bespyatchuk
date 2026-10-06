import { pool } from "../db/pool.js";
import { QUALIFICATION_PIPELINES } from "./leadgenStages.js";
import { FC_PIPELINES, successForSources } from "./money.js";
import { RNK_TEAM_IDS, NON_COMMERCIAL_TEAM_IDS } from "./metrics.js";
import { teamAtSql } from "./teamAt.js";
import { kommoLeadUrl } from "./kommoLinks.js";
import {
  takeOf, statsOf, inColumn, isWorkTime, TAKE_EVENT_LABEL,
  type DealTake, type TakeRowInput, type TakeStats, type TakeColumn,
} from "./leadTakeRules.js";

/**
 * ⏱ ВІКНО «ЧАС ОПРАЦЮВАННЯ ЗАЯВКИ» (ТЗ Юлії 24.09.2026) — ЄДИНЕ ДЖЕРЕЛО для таблиці, списку угод і Excel.
 *
 * Одна вибірка угод → одна чиста класифікація (`leadTakeRules`) → три подання. Клік по клітинці бере угоди тим
 * самим `inColumn`, що рахує число в клітинці, тож список не може розійтись із числом.
 *
 * ДЖЕРЕЛА (тлумачення ТЗ, звірене з Юлиним заміром «1-23.09, реклама: 1 122 заявки, 364 відсіяно»; у нас
 * 1 124 і 362 закриті ще в «Кваліфікації» — заміряно 02.10.2026):
 *   • `ad`      — «Реклама»: `client_source` ∈ джерел uts.ua (форма, дзвінок, callback з рекламного сайту);
 *                 розбивка за `utm_campaign`, порожня — «кампанія не вказана» (заповнена лише в ~24% заявок);
 *   • `site`    — «Сайт»: джерела yalogist.com.ua (другий сайт);
 *   • `leadgen` — «Лідгени»: `lead_channel = 'leadgen'`;
 *   • `all`     — «Все»: три разом.
 * Воронки — «Кваліфікація» і «Повний цикл»: там живуть заявки. Період — за датою СТВОРЕННЯ за Києвом.
 *
 * КОМАНДИ (ТЗ: «групування по командах (Андрій, Дарина, РПК)»): кожна команда РНК окремо, усі продажні РПК —
 * однією групою «РПК», решта (без команди, лідоген, фінанси) — «Інші». Команда — НА ДАТУ СТВОРЕННЯ заявки
 * (`core/teamAt.ts`): хто перейшов, лишає свої заявки в тодішній команді.
 */
export const AD_SOURCES = ["Дзвінок з uts.ua", "uts.ua", "Callback з uts.ua"] as const;
export const SITE_SOURCES = ["Дзвінок з yalogist.com.ua", "yalogist.com.ua", "Callback з yalogist.com.ua"] as const;
export const NO_CAMPAIGN = "(кампанія не вказана)";
export type TakeSource = "all" | "ad" | "site" | "leadgen";
export type TakeTime = "all" | "work" | "off";

export interface TakeQuery {
  from: string; to: string;
  source: TakeSource;
  /** Лише для `ad`: одна кампанія (`NO_CAMPAIGN` — порожня). */
  campaign?: string | null;
  time: TakeTime;
  /** Межа ролі: менеджер — лише свої, тімлід — своя команда. */
  managerId?: number | null;
  teamId?: number | null;
}

export interface TakeDeal {
  kommoId: number; name: string; url: string;
  managerId: number | null; manager: string | null;
  teamId: number | null; team: string | null; group: string;
  createdAt: string; takenAt: string | null;
  event: string | null; minutes: number | null;
  bucket: DealTake["bucket"]; offHours: boolean;
  status: "open" | "won" | "lost"; rejectReason: string | null;
  source: string | null; campaign: string;
}

interface Row extends TakeRowInput { d: TakeDeal }

async function loadRows(q: TakeQuery): Promise<Row[]> {
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const p: unknown[] = [[...QUALIFICATION_PIPELINES, ...FC_PIPELINES], q.from, q.to];
  const conds = ["d.pipeline_id = ANY($1)", `(d.created_at_kommo ${K})::date BETWEEN $2::date AND $3::date`];
  const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  // Параметр джерела додається ЛИШЕ коли умова його вживає: зайвий параметр Postgres відкидає цілим запитом.
  const ad = () => `d.client_source = ANY(${add([...AD_SOURCES])})`;
  const site = () => `d.client_source = ANY(${add([...SITE_SOURCES])})`;
  const lg = "(d.lead_channel = 'leadgen')";
  conds.push(q.source === "ad" ? ad() : q.source === "site" ? site() : q.source === "leadgen" ? lg : `(${ad()} OR ${site()} OR ${lg})`);
  if (q.source === "ad" && q.campaign) {
    conds.push(q.campaign === NO_CAMPAIGN ? "d.utm_campaign IS NULL" : `d.utm_campaign = ${add(q.campaign)}`);
  }
  const TEAM = teamAtSql("m", `(d.created_at_kommo ${K})::date`);
  if (q.managerId) conds.push(`d.manager_id = ${add(q.managerId)}`);
  if (q.teamId) conds.push(`${TEAM} IS NOT DISTINCT FROM ${add(q.teamId)}`);
  const r = await pool.query<{
    kommo_id: string; name: string | null; manager_id: number | null; manager: string | null; team_id: number | null; team: string | null;
    created: Date; stage_at: Date | null; call_at: Date | null; field_at: Date | null;
    status_id: string; reject_reason: string | null; client_source: string | null; utm_campaign: string | null;
  }>(
    `SELECT d.kommo_id, d.name, d.manager_id, m.name AS manager, ${TEAM} AS team_id, t.name AS team,
            d.created_at_kommo AS created,
            (SELECT MIN(e.changed_at) FROM deal_stage_events e
              WHERE e.kommo_id = d.kommo_id AND e.status_id NOT IN (142, 143) AND e.changed_at >= d.created_at_kommo) AS stage_at,
            -- Вихідний дзвінок: нотатка Kommo (Ringostat → контакт → угода) або запис Ringostat того самого клієнта.
            LEAST(d.first_call_out_at,
              (SELECT MIN(rc.calldate) FROM ringostat_calls rc
                WHERE d.client_key IS NOT NULL AND rc.client_key = d.client_key
                  AND rc.call_type IN ('out', 'transitout') AND rc.calldate >= d.created_at_kommo)) AS call_at,
            d.taken_field_at AS field_at,
            d.status_id, d.reject_reason, d.client_source, d.utm_campaign
       FROM deals d
       LEFT JOIN managers m ON m.id = d.manager_id
       LEFT JOIN teams t ON t.id = ${TEAM}
      WHERE ${conds.join(" AND ")}
      ORDER BY d.created_at_kommo`, p);
  const rnk = new Set(RNK_TEAM_IDS), nonCom = new Set(NON_COMMERCIAL_TEAM_IDS);
  const ms = (x: Date | null) => (x == null ? null : x.getTime());
  const rows: Row[] = [];
  for (const x of r.rows) {
    const created = x.created.getTime();
    if (q.time === "work" && !isWorkTime(created)) continue;
    if (q.time === "off" && isWorkTime(created)) continue;
    const take = takeOf({ createdAt: created, stageAt: ms(x.stage_at), callAt: ms(x.call_at), fieldAt: ms(x.field_at) });
    const status = x.status_id === "142" ? "won" : x.status_id === "143" ? "lost" : "open";
    const group = x.team_id != null && rnk.has(x.team_id) ? (x.team ?? `Команда #${x.team_id}`)
      : x.team_id != null && !nonCom.has(x.team_id) ? "РПК" : "Інші";
    rows.push({
      take, lost: status === "lost",
      d: {
        kommoId: Number(x.kommo_id), name: x.name ?? "", url: kommoLeadUrl(Number(x.kommo_id)),
        managerId: x.manager_id, manager: x.manager, teamId: x.team_id, team: x.team, group,
        createdAt: x.created.toISOString(), takenAt: take.takenAt == null ? null : new Date(take.takenAt).toISOString(),
        event: take.event == null ? null : TAKE_EVENT_LABEL[take.event],
        minutes: take.minutes == null ? null : Math.round(take.minutes * 10) / 10,
        bucket: take.bucket, offHours: take.offHours, status, rejectReason: x.reject_reason,
        source: x.client_source, campaign: x.utm_campaign ?? NO_CAMPAIGN,
      },
    });
  }
  return rows;
}

export interface TakeTableRow extends TakeStats { kind: "manager" | "group" | "dept"; key: string; label: string; group?: string }
export interface TakeTable {
  rows: TakeTableRow[];
  avgCheck: number | null;
  /** Скільки успішних рекламних угод дали середній чек — щоб «Втрати» читались чесно на малій вибірці. */
  avgCheckDeals: number;
  campaigns: { campaign: string; n: number }[];
}

/** Порядок груп: РНК-команди за назвою, далі «РПК», «Інші» в кінці. */
const groupOrder = (g: string) => (g === "Інші" ? 2 : g === "РПК" ? 1 : 0);

export async function leadTakeTable(q: TakeQuery): Promise<TakeTable> {
  const [rows, succ] = await Promise.all([loadRows(q), successForSources({ from: q.from, to: q.to }, AD_SOURCES)]);
  const avgCheck = succ.deals > 0 ? Math.round(succ.revenue / succ.deals) : null;
  const byGroup = new Map<string, Row[]>();
  for (const r of rows) byGroup.set(r.d.group, [...(byGroup.get(r.d.group) ?? []), r]);
  const out: TakeTableRow[] = [];
  for (const g of [...byGroup.keys()].sort((a, b) => groupOrder(a) - groupOrder(b) || a.localeCompare(b, "uk"))) {
    const gr = byGroup.get(g)!;
    out.push({ kind: "group", key: `g:${g}`, label: g, ...statsOf(gr, avgCheck) });
    const byMgr = new Map<string, Row[]>();
    for (const r of gr) {
      const k = r.d.managerId == null ? "∅" : String(r.d.managerId);
      byMgr.set(k, [...(byMgr.get(k) ?? []), r]);
    }
    const mgrRows = [...byMgr].map(([k, rs]) => ({
      kind: "manager" as const, key: `m:${k}:${g}`, group: g,
      label: rs[0].d.manager ?? "Без відповідального", ...statsOf(rs, avgCheck),
    }));
    out.push(...mgrRows.sort((a, b) => a.label.localeCompare(b.label, "uk")));
  }
  out.push({ kind: "dept", key: "dept", label: "ВІДДІЛ", ...statsOf(rows, avgCheck) });
  const camp = new Map<string, number>();
  if (q.source === "ad" && !q.campaign) for (const r of rows) camp.set(r.d.campaign, (camp.get(r.d.campaign) ?? 0) + 1);
  return {
    rows: out, avgCheck, avgCheckDeals: succ.deals,
    campaigns: [...camp].map(([campaign, n]) => ({ campaign, n })).sort((a, b) => b.n - a.n),
  };
}

/** Угоди клітинки: рядок (`key` таблиці) × колонка — той самий відбір, що порахував число. */
export async function leadTakeDeals(q: TakeQuery, rowKey: string, col: TakeColumn): Promise<TakeDeal[]> {
  const rows = await loadRows(q);
  const inRow = (r: Row): boolean => {
    if (rowKey === "dept") return true;
    if (rowKey.startsWith("g:")) return r.d.group === rowKey.slice(2);
    const [, mgr, ...g] = rowKey.split(":");
    return r.d.group === g.join(":") && (mgr === "∅" ? r.d.managerId == null : String(r.d.managerId) === mgr);
  };
  return rows.filter((r) => inRow(r) && inColumn(col, r)).map((r) => r.d);
}
