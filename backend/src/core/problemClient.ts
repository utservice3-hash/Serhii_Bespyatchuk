/**
 * ⚠️ «ПРОБЛЕМНИЙ КЛІЄНТ» (задача 8350; ТЗ Юлі 06.11 зі слів Віки; макет — артефакт 8350; Роман 11.11.2026 «викочуй»).
 *
 * Є клієнти, з якими неможливо працювати: конфлікт (Integral System після сварки по оплаті кидає трубку і менеджеру,
 * і лідгену), контакт втрачено (логіст звільнився, нового не дають навіть через бухгалтерію). Вони висіли сплячими
 * й псували статистику менеджера. Тепер — позначка з причиною й обовʼязковим коментарем:
 *   · клієнт ЛИШАЄТЬСЯ на екрані — окремою групою «⚠️ Проблемні» (бачать менеджер, тімлід, КВП);
 *   · не рахується в «Немає роботи», «Без задачі», «передати іншому», сплячих і реактивації;
 *   · позначка перестає діяти САМА, щойно клієнт знову замовить (рахунок чи оплата ПІЗНІШЕ за день позначки) —
 *     тоді він знову звичайний клієнт, а позначку видно в історії рядком «була».
 * Ставить той, хто бачить клієнта (`canSeeClient`): менеджер свого, тімлід своєї команди, КВП / ОД / адмін — будь-кого.
 *
 * Чисті правила — вгорі; запит — нижче, з явним `db`.
 */
export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Причини з макета (ТЗ: «конфлікт / контакт втрачено / відмовився працювати / інше»). CHECK у БД — той самий перелік. */
export const PROBLEM_REASONS = [
  { key: "conflict", label: "Конфлікт" },
  { key: "contact_lost", label: "Контакт втрачено" },
  { key: "refused", label: "Відмовився працювати" },
  { key: "other", label: "Інше" },
] as const;
export const PROBLEM_REASON_KEYS: readonly string[] = PROBLEM_REASONS.map((r) => r.key);
export const PROBLEM_NOTE_MIN = 5;

export function problemLabel(key: string): string {
  return PROBLEM_REASONS.find((r) => r.key === key)?.label ?? key;
}

/** Коментар із тіла: обрізаний; коротший за мінімум — `null` (роут відповість 400). */
export function cleanProblemNote(x: unknown): string | null {
  const s = typeof x === "string" ? x.trim().slice(0, 1000) : "";
  return s.length >= PROBLEM_NOTE_MIN ? s : null;
}

/**
 * Чи діє позначка ЗАРАЗ: так, доки клієнт не замовив ПІСЛЯ дня позначки. Замовлення того ж дня (до позначки) —
 * не знімає: саме воно могло бути останнім перед конфліктом.
 */
export function problemActive(markedDay: string, lastOrder: string | null): boolean {
  return !(lastOrder != null && lastOrder.slice(0, 10) > markedDay);
}

export interface ProblemMark {
  reason: string; label: string; note: string;
  /** День позначки за Києвом `YYYY-MM-DD`. */
  day: string;
  byName: string | null;
}

/** Позначки по ключах (усі, без огляду на те, чи діють — це вирішує `problemActive` з датою замовлення). */
export async function problemsFor(db: Db, keys: string[]): Promise<Map<string, ProblemMark>> {
  const out = new Map<string, ProblemMark>();
  if (!keys.length) return out;
  const r = await db.query<{ client_key: string; reason: string; note: string; day: string; by_name: string | null }>(
    `SELECT lo.client_key, lo.problem_reason AS reason, lo.problem_note AS note,
            to_char(lo.problem_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day,
            COALESCE(m.name, u.full_name, u.email) AS by_name
       FROM loyalty_overrides lo
       LEFT JOIN users u ON u.id = lo.problem_by
       LEFT JOIN managers m ON m.id = u.manager_id
      WHERE lo.problem_at IS NOT NULL AND lo.client_key = ANY($1)`, [keys]);
  for (const x of r.rows) out.set(x.client_key, { reason: x.reason, label: problemLabel(x.reason), note: x.note, day: x.day, byName: x.by_name });
  return out;
}

/** Поставити позначку (або замінити причину й коментар). Усе — одним запитом. */
export async function markProblem(db: Db, a: { clientKey: string; userId: number; reason: string; note: string }): Promise<void> {
  await db.query(
    `INSERT INTO loyalty_overrides (client_key, problem_at, problem_by, problem_reason, problem_note, updated_by, updated_at)
     VALUES ($1, now(), $2, $3, $4, $2, now())
     ON CONFLICT (client_key) DO UPDATE SET problem_at = EXCLUDED.problem_at, problem_by = EXCLUDED.problem_by,
       problem_reason = EXCLUDED.problem_reason, problem_note = EXCLUDED.problem_note,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [a.clientKey, a.userId, a.reason, a.note]);
}

/** Зняти позначку руками. Усі чотири поля — разом. */
export async function clearProblem(db: Db, clientKey: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE loyalty_overrides SET problem_at = NULL, problem_by = NULL, problem_reason = NULL, problem_note = NULL, updated_at = now()
      WHERE client_key = $1 AND problem_at IS NOT NULL`, [clientKey]);
  return (r.rowCount ?? 0) > 0;
}
