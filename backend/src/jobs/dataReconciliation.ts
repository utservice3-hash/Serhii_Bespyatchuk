import { pool } from "../db/pool.js";

/**
 * Нічна авто-звірка даних із CRM — запобіжники, що ловлять «тихі» баги ДО того,
 * як їх помітить КВП. Кожна перевірка повертає значення + поріг + ok/warn. Результат
 * зберігається в `data_check_state`; за наявності попереджень створюється задача
 * адміну «🔎 Звірка даних». Мета — щоб «завжди труднощі з CRM» стали «рідко й видно».
 */
export interface DataCheck {
  key: string;
  label: string;
  value: number;
  threshold: number;
  ok: boolean;
  detail: string;
}

const FC = "d.pipeline_id IN (8921932, 155304)";

export async function runDataReconciliation(): Promise<{ warnings: number; checks: DataCheck[] }> {
  const checks: DataCheck[] = [];

  // 1) Частка угод повного циклу (30 днів) у ГЕНУЇННО незамаплених статусах —
  //    тобто НЕ в pipeline_stage_map і НЕ статус 143 (закрито/нейтралізовано —
  //    його правильно не мапити, це не активний етап). Сплеск = зʼявився НОВИЙ
  //    робочий етап, ще не в мапі → метрики за етапом його не бачать (саме такий
  //    баг ховав рекламу). Поріг 10%.
  const unmapped = await pool.query<{ total: string; bad: string; statuses: number[] | null }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE psm.funnel_stage IS NULL AND d.status_id <> 143) AS bad,
            array_agg(DISTINCT d.status_id) FILTER (WHERE psm.funnel_stage IS NULL AND d.status_id <> 143) AS statuses
       FROM deals d
       LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE ${FC} AND d.created_at_kommo >= now() - interval '30 days'`
  );
  const total = Number(unmapped.rows[0].total) || 0;
  const bad = Number(unmapped.rows[0].bad) || 0;
  const pct = total > 0 ? Math.round((bad / total) * 100) : 0;
  const statusList = (unmapped.rows[0].statuses || []).join(", ");
  checks.push({
    key: "unmapped_stage_share", label: "Частка НЕзамаплених робочих статусів (повний цикл, 30 дн.)",
    value: pct, threshold: 10, ok: pct <= 10,
    detail: `${bad} з ${total} угод у робочих статусах поза pipeline_stage_map (143 «закрито» не рахуємо).${statusList ? ` Статуси: ${statusList} — потребують мапінгу.` : ""}`,
  });

  // 2) РЕАЛЬНЕ розщеплення менеджерів: одне імʼя, під яким ДВА+ записи, і кожен
  //    має угоди (тобто дані справді розщеплені й потрібен мердж). Порожні
  //    історичні дублі (старий Kommo-логін без даних) НЕ рахуємо — вони невидимі
  //    й нешкідливі. Поріг 0.
  const dupMgr = await pool.query<{ n: string; names: string[] }>(
    `SELECT COUNT(*) AS n, array_agg(name) AS names FROM (
        SELECT m.name FROM managers m
         WHERE EXISTS (SELECT 1 FROM deals d WHERE d.manager_id = m.id)
         GROUP BY m.name HAVING COUNT(*) > 1
     ) x`
  );
  const dupN = Number(dupMgr.rows[0].n) || 0;
  checks.push({
    key: "duplicate_active_managers", label: "Менеджери з розщепленими даними (дублі)",
    value: dupN, threshold: 0, ok: dupN === 0,
    detail: dupN > 0 ? `Однакові імена з угодами на кількох записах: ${(dupMgr.rows[0].names || []).slice(0, 8).join(", ")}. Потрібен мердж.` : "Розщеплень немає (порожні історичні дублі не рахуються).",
  });

  // 3) Свіжість синку Kommo (хвилини від останнього успіху). Поріг 30 хв.
  const sync = await pool.query<{ mins: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - last_success_at)) / 60 AS mins FROM sync_state WHERE id = 1`
  );
  const mins = sync.rows[0]?.mins != null ? Math.round(Number(sync.rows[0].mins)) : 9999;
  checks.push({
    key: "sync_freshness", label: "Свіжість синку Kommo (хв)",
    value: mins, threshold: 30, ok: mins <= 30,
    detail: mins <= 30 ? "Синк свіжий." : `Останній успішний синк ${mins} хв тому — дані можуть відставати.`,
  });

  // 4) Угоди повного циклу без менеджера (30 дн.) — випадають з усіх per-manager
  //    метрик. Поріг 0.
  const noMgr = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM deals d WHERE ${FC} AND d.manager_id IS NULL
       AND d.created_at_kommo >= now() - interval '30 days'`
  );
  const noMgrN = Number(noMgr.rows[0].n) || 0;
  checks.push({
    key: "deals_without_manager", label: "Угоди без менеджера (повний цикл, 30 дн.)",
    value: noMgrN, threshold: 0, ok: noMgrN === 0,
    detail: noMgrN > 0 ? `${noMgrN} угод не привʼязані до менеджера → не потрапляють у per-manager звіти.` : "Усі угоди привʼязані.",
  });

  // 5) Відʼємна ціна без прапорця «Мінусова угода» (30 дн.) — псує грошові суми. Поріг 0.
  // Знак тепер дає ПОЛЕ 2098529 (is_minus), не слово в назві → перевіряємо по полю.
  const negs = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM deals d WHERE ${FC} AND d.price < 0 AND NOT d.is_minus
       AND d.created_at_kommo >= now() - interval '30 days'`
  );
  const negN = Number(negs.rows[0].n) || 0;
  checks.push({
    key: "negative_price_no_marker", label: "Відʼємна ціна без поля «Мінус» (30 дн.)",
    value: negN, threshold: 0, ok: negN === 0,
    detail: negN > 0 ? `${negN} угод з відʼємним price, де поле «Мінусова угода» ≠ «Мінус» → викривляють суми.` : "Немає.",
  });

  const warnings = checks.filter((c) => !c.ok).length;

  await pool.query(
    `INSERT INTO data_check_state (id, ran_at, warnings, checks)
     VALUES (1, now(), $1, $2)
     ON CONFLICT (id) DO UPDATE SET ran_at = now(), warnings = EXCLUDED.warnings, checks = EXCLUDED.checks`,
    [warnings, JSON.stringify(checks)]
  );

  // Проактивний сигнал КВП: одна задача на добу, якщо є попередження.
  if (warnings > 0) {
    const admin = await pool.query<{ id: number }>(
      `SELECT m.id FROM managers m JOIN users u ON u.manager_id = m.id
        WHERE u.role = 'admin' AND m.is_active LIMIT 1`
    );
    if (admin.rowCount) {
      const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
      const pad = (n: number) => String(n).padStart(2, "0");
      const deadline = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      const exists = await pool.query(
        `SELECT 1 FROM tasks WHERE assignee_id = $1 AND task_type = 'simple'
           AND title LIKE '🔎 Звірка даних%' AND deadline = $2::date`,
        [admin.rows[0].id, deadline]
      );
      if (!exists.rowCount) {
        const failed = checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.value}`).join("; ");
        await pool.query(
          `INSERT INTO tasks (title, description, status, deadline, assignee_id, priority, department, task_type, created_by)
           VALUES ($1, $2, 'not_started', $3, $4, 'high', 'Система', 'simple', NULL)`,
          [`🔎 Звірка даних: ${warnings} попереджень`, `Розділ «Якість даних». ${failed}`, deadline, admin.rows[0].id]
        );
      }
    }
  }

  console.log(`Data reconciliation: ${warnings} warning(s). ${checks.map((c) => `${c.key}=${c.value}${c.ok ? "" : "⚠"}`).join(" ")}`);
  return { warnings, checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDataReconciliation().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
