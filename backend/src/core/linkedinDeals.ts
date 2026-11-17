import type { Db } from "./adCallFacts.js";
import { stageName } from "./stageNames.js";

/**
 * 🔗 «Усі угоди з LinkedIn» на екрані «Клієнти → LinkedIn» (задача 9363, ТЗ Юлі 16.11.2026; рішення Романа 17.11.2026).
 *
 * ПРАВИЛО (`docs/METRICS_GLOSSARY.md` §20): угода з LinkedIn = «Источник клиента» (поле 2098035) = «LinkedIn»
 * (значення enum 6349053) АБО тег «LinkedIn» (id 3102047) — у будь-якій воронці, на будь-якому етапі, включно із
 * закритими. Теги пише `syncKommo` у `deals.tags` (NULL — угоду ще не читали після появи колонки: вона йде лише за
 * джерелом, доки синк чи `backfillLinkedinTags` її не прочитає).
 *
 * 📐 Чому НЕ етап «LinkedIn» у Кваліфікації: заміряно 17.11.2026 — 24 угоди етапу й 16 угод із джерелом LinkedIn
 * НЕ ПЕРЕТИНАЮТЬСЯ (у 23 з етапу джерело порожнє). Чи рахувати угоди етапу без джерела — ВІДКРИТЕ ПИТАННЯ до Юлі;
 * поки ні, і блок «Створено по днях» (`linkedinStageDeals.ts`) лишається окремим, як був.
 *
 * Джерело — таблиця `deals`, тобто стан на останній синк Kommo: окремого перерахунку немає.
 * Без пулу — гейти ганяють це на scratch-базі тим самим модулем, що кличе роут.
 */

/** Текст значення enum у «Источник клиента» — саме він лежить у `deals.client_source` (enum 6349053). */
export const LINKEDIN_CLIENT_SOURCE = "LinkedIn";
/** Назва тегу угоди в Kommo (id 3102047) — так вона лежить у `deals.tags` (синк обрізає пробіли). */
export const LINKEDIN_TAG = "LinkedIn";

const sourceSql = (a: string) => `COALESCE(btrim(${a}.client_source), '') = '${LINKEDIN_CLIENT_SOURCE}'`;
const tagSql = (a: string) => `'${LINKEDIN_TAG}' = ANY(COALESCE(${a}.tags, '{}'::text[]))`;

/** SQL-предикат «угода з LinkedIn» над аліасом таблиці `deals`. Єдине місце правила (його ж візьме 9230). */
export function linkedinDealSql(alias = "d"): string {
  return `(${sourceSql(alias)} OR ${tagSql(alias)})`;
}

/** Підпис воронки — щоб «Вхідні ліди» Кваліфікації не плутались з однойменним етапом повного циклу. */
const PIPELINE_LABELS: Record<string, string> = {
  "8921932": "Повний цикл", "155304": "Повний цикл (стара)",
  "8921928": "Кваліфікація", "7336928": "Кваліфікація (стара)",
  "8921936": "Продзвін", "8921948": "Реактивація",
};
const pipelineLabel = (id: string | null) => (id == null ? "воронка невідома" : PIPELINE_LABELS[id] ?? `воронка ${id}`);

/** Назва етапу; етап, якого ще немає в словнику, — його id словами, а не порожній «—» (невідоме читається як невідоме). */
function stageLabel(pipelineId: string | null, statusId: string | null): string {
  if (pipelineId == null || statusId == null) return "етап невідомий";
  const n = stageName(pipelineId, statusId);
  return n === "—" ? `етап ${statusId} (без назви в дашборді)` : n;
}

export type LinkedinOutcome = "open" | "won" | "lost";
/** 142 — успішно, 143 — закрито й не реалізовано (однаково в усіх воронках Kommo). */
const outcomeOf = (statusId: string | null): LinkedinOutcome => (statusId === "142" ? "won" : statusId === "143" ? "lost" : "open");

export interface LinkedinDealRow {
  kommoId: number; url: string | null; name: string | null; managerName: string | null;
  /** Чим угода потрапила в LinkedIn: джерело, тег чи обидва — щоб розбіжність у CRM було видно на екрані. */
  bySource: boolean; byTag: boolean;
  pipeline: string; stage: string; outcome: LinkedinOutcome; createdAt: string | null;
}
export interface LinkedinStageRow { pipeline: string; stage: string; outcome: LinkedinOutcome; count: number }
export interface LinkedinDeals {
  total: number; open: number; won: number; lost: number;
  byStage: LinkedinStageRow[];
  deals: LinkedinDealRow[];
}

/**
 * Усі угоди з LinkedIn за весь час, етап — поточний у CRM. `managerIds`: `null` — усі (керівництво);
 * масив — лише угоди цих менеджерів (менеджер — свої, тімлід — команда). Порожній масив = порожня відповідь.
 * `leadUrl` — посилання на угоду (`kommoLeadUrl` з роуту): ядро не тягне `config`, щоб гейти бігли без env Kommo.
 */
export async function loadLinkedinDeals(db: Db, managerIds: readonly number[] | null,
  leadUrl: ((kommoId: number) => string) | null = null): Promise<LinkedinDeals> {
  const rows = (await db.query<{ kommo_id: string; name: string | null; mname: string | null; pipeline_id: string | null;
    status_id: string | null; created_at_kommo: Date | null; by_source: boolean; by_tag: boolean }>(
    `SELECT d.kommo_id::text AS kommo_id, d.name, m.name AS mname, d.pipeline_id::text AS pipeline_id,
            d.status_id::text AS status_id, d.created_at_kommo,
            ${sourceSql("d")} AS by_source, ${tagSql("d")} AS by_tag
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
      WHERE ${linkedinDealSql("d")} AND ($1::int[] IS NULL OR d.manager_id = ANY($1::int[]))
      ORDER BY d.created_at_kommo DESC NULLS LAST, d.kommo_id DESC`, [managerIds == null ? null : [...managerIds]])).rows;
  const deals: LinkedinDealRow[] = rows.map((r) => ({
    kommoId: Number(r.kommo_id), url: leadUrl ? leadUrl(Number(r.kommo_id)) : null, name: r.name, managerName: r.mname,
    bySource: r.by_source, byTag: r.by_tag,
    pipeline: pipelineLabel(r.pipeline_id),
    stage: stageLabel(r.pipeline_id, r.status_id),
    outcome: outcomeOf(r.status_id),
    createdAt: r.created_at_kommo ? new Date(r.created_at_kommo).toISOString() : null,
  }));
  const byKey = new Map<string, LinkedinStageRow>();
  for (const d of deals) {
    const k = `${d.pipeline}\u0000${d.stage}`;
    const cur = byKey.get(k);
    if (cur) cur.count++; else byKey.set(k, { pipeline: d.pipeline, stage: d.stage, outcome: d.outcome, count: 1 });
  }
  const order: Record<LinkedinOutcome, number> = { open: 0, won: 1, lost: 2 };
  const byStage = [...byKey.values()].sort((a, b) => order[a.outcome] - order[b.outcome] || b.count - a.count || a.stage.localeCompare(b.stage, "uk"));
  const n = (o: LinkedinOutcome) => deals.filter((d) => d.outcome === o).length;
  return { total: deals.length, open: n("open"), won: n("won"), lost: n("lost"), byStage, deals };
}
