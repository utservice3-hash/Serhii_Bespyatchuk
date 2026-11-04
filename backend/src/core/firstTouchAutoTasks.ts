import type { Db } from "./adCallFacts.js";
import { nextWorkingDay } from "./callAiPromise.js";

/**
 * 📋 АВТОЗАДАЧІ «ПЕРШОГО ДОТИКУ» (задача 7238, ТЗ Юлі 28.10.2026, задача 1 пп.2–3; рішення Романа 04.11.2026).
 *
 * ① «Погодився, а в Kommo втрачено» — по КОЖНІЙ угоді такої розмови задача тімліду її команди: «Перевірити, чому закрили
 *   угоду № …», високий пріоритет, дедлайн — наступний робочий день (пн–пт, свят календар не знає — як решта дашборду).
 *   Правило — те саме, що фільтр екрана (`TILE_MATCH.agreedLost`): у розмові клієнт погодився після ціни, а всі угоди
 *   розмови в Kommo закриті як втрачені. Роман 04.11.2026: «роби всі» — і наявні з `AUTO_TASKS_FROM`, не лише нові.
 *   Задачу далі веде тімлід: джоба її не закриває й не ставить повторно (видалив — значить, не потрібна).
 * ② «Аналіз не вдався» (розпізнавання чи модель) — задача Роману на кожну розмову з причиною: визначити, хто дзвонив.
 *   Перевізник → позначка «не запит на перевезення» на картці; клієнт → розбір заново. Закривається САМА, щойно на розмові
 *   є позначка «не запит» або вдалий розбір (Роман 04.11.2026: «так, роби»).
 *
 * Посилання на угоду (`dealUrl`) передає джоба (`kommoLinks` тягне `config`, а ядро мусить імпортуватись без БД — гейти).
 *
 * Журнал `first_touch_auto_tasks` — рядок на (вид, ключ): угода для ①, розмова для ②. Унікальний ключ у БД, а не
 * перевірка в коді: задача й рядок журналу йдуть ОДНИМ оператором, тож дубль упирається в індекс і відкочує обидва.
 */

export const AUTO_TASKS_FROM = "2026-09-01";
/** Роман — акаунт `drv@uts.ua` (`users.id` 50): так стоять усі його задачі в Задачнику. */
export const ROMAN_USER_ID = 50;
export const DASHBOARD_ORIGIN = "https://dashboard.uts.ua";
export const FAILED_STATES: ReadonlySet<string> = new Set(["llm_failed", "stt_failed"]);
export const FAILED_DONE_REASON = "Закрито автоматично: розмову позначено «не запит на перевезення» або її розібрано заново.";

export type DealUrl = (kommoId: number) => string;
export type AutoTaskKind = "agreed_lost" | "analysis_failed";
/** Рядок екрана «Перший дотик · AI» у тій мірі, що потрібна автозадачам (`aiCallsList` + `clientDecision`). */
export interface AutoTaskSrc {
  uniqueid: string; calledAt: string; kommoIds: readonly number[]; managerName: string | null;
  teamId: number | null; teamName: string | null; state: string; failure: string | null; inReport: boolean;
  typeOverride: { isCargo: boolean } | null;
  decision: { value: string; quote: string; quoteFound: boolean | null } | null;
  dealOutcome: { state: string; lossReason: string | null } | null;
}
export interface AutoTaskItem {
  kind: AutoTaskKind; key: string; assigneeUserId: number; title: string; description: string;
  deadline: string; priority: "high" | "medium"; department: string;
}
export interface AutoTaskPlan {
  items: AutoTaskItem[];
  /** Угоди «погодився, а втрачено» без тімліда-акаунта в команді — задачі нікому; число видно в лозі джоби. */
  noLead: string[];
  /** Розмови, які були «аналіз не вдався» і вже ні (позначка «не запит» чи вдалий розбір) — їхні задачі закриваються. */
  resolved: Set<string>;
}

const kyivStamp = (iso: string): string => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const callUrl = (uniqueid: string): string => `${DASHBOARD_ORIGIN}/ai-calls?call=${encodeURIComponent(uniqueid)}`;

export const isAgreedLost = (r: AutoTaskSrc): boolean => r.inReport && r.decision?.value === "agreed" && r.dealOutcome?.state === "lost";
const markedNotCargo = (r: AutoTaskSrc): boolean => r.typeOverride?.isCargo === false;
export const isAnalysisFailed = (r: AutoTaskSrc): boolean => FAILED_STATES.has(r.state) && !markedNotCargo(r);

export function agreedLostTitle(kommoId: number): string { return `Перевірити, чому закрили угоду № ${String(kommoId)}`; }
export function agreedLostDescription(r: AutoTaskSrc, kommoId: number, dealUrl: DealUrl): string {
  return [
    "У першій розмові клієнт погодився після ціни, а угоду в Kommo закрито як втрачену. Зʼясуйте з менеджером, що сталось після дзвінка.",
    `Менеджер: ${r.managerName ?? "не вказаний"} · розмова ${kyivStamp(r.calledAt)}`,
    `Причина відмови в CRM: ${r.dealOutcome?.lossReason ?? "не вказана"}`,
    ...(r.decision?.quote && r.decision.quoteFound !== false ? [`Слова клієнта: «${r.decision.quote}»`] : []),
    `Угода: ${dealUrl(kommoId)}`,
    `Розмова: ${callUrl(r.uniqueid)}`,
    "Створено автоматично з «Перший дотик · AI» (фільтр «Погодився, а в Kommo втрачено»).",
  ].join("\n");
}
export function failedTitle(r: AutoTaskSrc): string {
  return `AI не розібрав розмову: перевізник чи клієнт? — ${r.managerName ?? "менеджер не вказаний"}, ${kyivStamp(r.calledAt).slice(0, 10)}`;
}
export function failedDescription(r: AutoTaskSrc, dealUrl: DealUrl): string {
  return [
    `${r.state === "stt_failed" ? "Розпізнавання" : "Аналіз"} не вдався: ${r.failure ?? "причину не записано"}.`,
    `Менеджер: ${r.managerName ?? "не вказаний"} · розмова ${kyivStamp(r.calledAt)}`,
    `Розмова: ${callUrl(r.uniqueid)}`,
    ...r.kommoIds.map((id) => `Угода: ${dealUrl(id)}`),
    "Послухайте запис. Перевізник — поставте на картці розмови «не запит на перевезення»; клієнт — розмову треба розібрати заново.",
    "Задача закриється сама, щойно на розмові буде позначка «не запит» або вдалий розбір. Створено автоматично.",
  ].join("\n");
}

/** Що поставити і що закрити — чиста функція від рядків екрана й тімлідів команд (`teamId → users.id`). */
export function planAutoTasks(rows: readonly AutoTaskSrc[], leads: ReadonlyMap<number, number>, now: Date, dealUrl: DealUrl): AutoTaskPlan {
  const deadline = nextWorkingDay(now);
  const plan: AutoTaskPlan = { items: [], noLead: [], resolved: new Set() };
  const seen = new Set<string>();
  for (const r of rows) {
    if (isAgreedLost(r)) {
      const lead = r.teamId == null ? undefined : leads.get(r.teamId);
      for (const id of r.kommoIds) {
        const key = String(id);
        if (seen.has(`agreed_lost:${key}`)) continue;
        seen.add(`agreed_lost:${key}`);
        if (lead == null) { plan.noLead.push(key); continue; }
        plan.items.push({ kind: "agreed_lost", key, assigneeUserId: lead, title: agreedLostTitle(id), description: agreedLostDescription(r, id, dealUrl),
          deadline, priority: "high", department: r.teamName ?? "Перший дотик" });
      }
    }
    if (isAnalysisFailed(r)) {
      plan.items.push({ kind: "analysis_failed", key: r.uniqueid, assigneeUserId: ROMAN_USER_ID, title: failedTitle(r),
        description: failedDescription(r, dealUrl), deadline, priority: "medium", department: "Перший дотик" });
    } else if (r.state === "done" || markedNotCargo(r)) plan.resolved.add(r.uniqueid); // у черзі на повтор — ще не розвʼязано
  }
  return plan;
}

/** Тімлід кожної команди — активний акаунт із роллю team_lead (той самий вибір, що в нагадуваннях «Дзвінки на мобільні»). */
export async function teamLeadUsers(db: Db): Promise<Map<number, number>> {
  return new Map((await db.query<{ team_id: number; user_id: number }>(`
    SELECT DISTINCT ON (u.team_id) u.team_id, u.id AS user_id FROM users u
     WHERE COALESCE(u.role_override, u.role) = 'team_lead' AND u.team_id IS NOT NULL AND u.is_active
     ORDER BY u.team_id, u.id`)).rows.map((x) => [Number(x.team_id), Number(x.user_id)]));
}

export interface AutoTaskStats { created: number; known: number; closed: number; noLead: number }

export async function syncFirstTouchAutoTasks(db: Db, plan: AutoTaskPlan, now: Date): Promise<AutoTaskStats> {
  const at = now.toISOString();
  const stats: AutoTaskStats = { created: 0, known: 0, closed: 0, noLead: plan.noLead.length };
  const journal = (await db.query<{ id: string; kind: AutoTaskKind; item_key: string; task_id: number | null; closed_at: Date | null; status: string | null }>(`
    SELECT j.id, j.kind, j.item_key, j.task_id, j.closed_at, t.status
      FROM first_touch_auto_tasks j LEFT JOIN tasks t ON t.id = j.task_id`)).rows;
  const known = new Set(journal.map((j) => `${j.kind}:${j.item_key}`));
  for (const it of plan.items) {
    if (known.has(`${it.kind}:${it.key}`)) { stats.known++; continue; }
    await db.query(`
      WITH x AS (
        INSERT INTO tasks (title, description, status, deadline, assignee_user_id, priority, department, task_type, created_at, updated_at)
        VALUES ($1, $2, 'not_started', $3::date, $4, $5, $6, 'simple', $7, $7) RETURNING id)
      INSERT INTO first_touch_auto_tasks (kind, item_key, task_id, opened_at) SELECT $8, $9, id, $7 FROM x`,
      [it.title, it.description, it.deadline, it.assigneeUserId, it.priority, it.department, at, it.kind, it.key]);
    known.add(`${it.kind}:${it.key}`);
    stats.created++;
  }
  for (const j of journal) {
    if (j.kind !== "analysis_failed" || j.closed_at != null || !plan.resolved.has(j.item_key)) continue;
    if (j.task_id != null && j.status !== "done") {
      await db.query("UPDATE tasks SET status = 'done', close_reason = $2, closed_at = $3, updated_at = $3 WHERE id = $1 AND status <> 'done'",
        [j.task_id, FAILED_DONE_REASON, at]);
      await db.query("INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, $2, 'done', NULL)",
        [j.task_id, j.status ?? "not_started"]);
    }
    await db.query("UPDATE first_touch_auto_tasks SET closed_at = $2 WHERE id = $1", [j.id, at]);
    stats.closed++;
  }
  return stats;
}
