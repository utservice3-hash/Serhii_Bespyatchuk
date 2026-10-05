/**
 * 🔀 КОМАНДА МЕНЕДЖЕРА НА ДАТУ (02.10.2026, задача 4892).
 *
 * ЗВІДКИ ВЗЯЛОСЬ. Хомік з 01.10 іде від Яцика «без команди». Командний розріз скрізь
 * читав ПОТОЧНУ прив'язку `managers.team_id` (варіант A від 05.08.2026), тож перенос
 * забрав би з команди Яцика і всі її минулі місяці. Відповідь власника (Юля/Сергій):
 * **«все що було залишається в команді у якій працювала»**. Рішення Романа: лагодимо
 * лише від сьогодні — минулих переходів не відновлюємо.
 *
 * ПРАВИЛО. Перехід = рядок `manager_team_moves` «з дати F людина в to, до неї — у from».
 *   команда на дату D = from найранішого переходу з F > D; немає такого — `managers.team_id`.
 * Немає переходів у людини → поточна команда, тобто рівно як до цього модуля. Тому зміна
 * НЕ рухає жодного числа, доки хтось не запише перехід (тримає `#1352`).
 *
 * 🔴 ЛАНЦЮГ МУСИТЬ СХОДИТИСЬ: from кожного переходу = to попереднього, а to останнього =
 * `managers.team_id`. Тому писати переходи можна лише через `recordTeamMove`: він бере
 * from із поточної команди, не пускає дату раніше за останній перехід і зливає два записи
 * одного дня в один (виправлення, а не два переходи).
 *
 * ⚠️ ЗНІМКИ «СТАНОМ НА ЗАРАЗ» (очікування, дебіторка, застряглі, перенесені) і межі доступу
 * лишаються на ПОТОЧНІЙ команді: там питання «хто зараз», а не «коли заробив».
 */

export interface TeamMove {
  /** Перший день у новій команді, `YYYY-MM-DD` за Києвом. */
  effectiveFrom: string;
  fromTeamId: number | null;
  toTeamId: number | null;
}

/** Чиста форма правила — для тестів і для тих, хто вже тримає переходи в памʼяті. */
export function teamAt(currentTeamId: number | null, moves: readonly TeamMove[], date: string): number | null {
  let best: TeamMove | null = null;
  for (const m of moves) if (m.effectiveFrom > date && (!best || m.effectiveFrom < best.effectiveFrom)) best = m;
  return best ? best.fromTeamId : currentTeamId;
}

/** Чи був менеджер у команді `teamId` хоч один день періоду `[from, to]`. */
export function inTeamDuring(currentTeamId: number | null, moves: readonly TeamMove[], teamId: number, from: string, to: string): boolean {
  if (teamAt(currentTeamId, moves, from) === teamId) return true;
  return moves.some((m) => m.toTeamId === teamId && m.effectiveFrom > from && m.effectiveFrom <= to);
}

/**
 * 🧠 ЗНІМОК ПЕРЕХОДІВ У ПАМʼЯТІ ПРОЦЕСУ — і саме він робить вираз дешевим.
 *
 * 📐 ЧОМУ НЕ ПІДЗАПИТ (заміряно 02.10.2026 на проді, golden «до/після»). Перша редакція рахувала команду
 * на дату підзапитами до `manager_team_moves` прямо в рядковій умові. Числа сходились байт-у-байт, але
 * планувальник втрачав оцінки: чесна воронка команди Яцика 0.13 → 16.5 с, звіт менеджера по команді
 * 4 → 18 с (межа сервера 20 с), рекламна когорта «Звіту» 0.4 → 1.35 с, передачі в Огляді → 6.5 с.
 * Переходів одиниці, тож вони вбудовуються в SQL КОНСТАНТАМИ: без переходів вираз — рівно `m.team_id`
 * (запит той самий, що до модуля), з переходами — `CASE` без жодного підзапиту.
 *
 * Знімок оновлюють: старт сервера (до `listen`), кожен запис переходу (`refreshTeamMoves` після
 * COMMIT у Налаштуваннях і синку) і крон раз на 10 хв (страховка). Поки знімка немає (окремий
 * процес, тест без завантаження) — запасна форма з підзапитами: повільніша, але правильна.
 */
let snapshot: Map<number, TeamMove[]> | null = null;

/** Перечитати знімок із бази. Повертає кількість переходів. */
export async function refreshTeamMoves(db: Db): Promise<number> {
  const r = await db.query<{ manager_id: number; ef: string; f: number | null; t: number | null }>(
    `SELECT manager_id, to_char(effective_from, 'YYYY-MM-DD') AS ef, from_team_id AS f, to_team_id AS t
       FROM manager_team_moves ORDER BY manager_id, effective_from`);
  const m = new Map<number, TeamMove[]>();
  for (const x of r.rows) m.set(x.manager_id, [...(m.get(x.manager_id) ?? []), { effectiveFrom: x.ef, fromTeamId: x.f, toTeamId: x.t }]);
  snapshot = m;
  return r.rows.length;
}
/** Для тестів: повернутись до запасної форми (знімка немає). */
export function forgetTeamMoves(): void { snapshot = null; }

const intLit = (v: number | null): string => (v == null ? "NULL::int" : String(Math.trunc(Number(v))));
/**
 * Дата константою SQL (`DATE 'YYYY-MM-DD'`, формат перевіряється). Для запитів, де дата потрібна ЛИШЕ
 * виразу команди: без переходів вираз її не згадує, і параметр `$1` лишився б зайвим — Postgres відмовляє
 * (`bind message supplies 1 parameters, but prepared statement requires 0`; спіймав golden 02.10.2026).
 */
export const sqlDate = (ymd: string): string => dateLit(ymd);
const dateLit = (ymd: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`teamAt: дата переходу не YYYY-MM-DD: ${ymd}`);
  return `DATE '${ymd}'`;
};
const moverIds = (snap: Map<number, TeamMove[]>): string => `ARRAY[${[...snap.keys()].map((id) => intLit(id)).join(",")}]::int[]`;

/**
 * SQL-вираз «команда менеджера `alias` на дату `dateExpr`» (`dateExpr` — вираз типу date).
 * Зі знімком: `CASE m.id WHEN <хто переходив> THEN CASE WHEN дата < перехід₁ THEN from₁ … ELSE m.team_id END
 * … ELSE m.team_id END` — переходи кожного відсортовані за датою, тож перша гілка, де дата раніша за перехід,
 * і дає `from` найранішого переходу після дати (правило `teamAt`).
 */
export function teamAtSql(alias: string, dateExpr: string): string {
  if (snapshot) {
    if (!snapshot.size) return `${alias}.team_id`;
    const arms = [...snapshot].map(([id, moves]) =>
      `WHEN ${intLit(id)} THEN CASE ${moves.map((mv) => `WHEN (${dateExpr}) < ${dateLit(mv.effectiveFrom)} THEN ${intLit(mv.fromTeamId)}`).join(" ")} ELSE ${alias}.team_id END`);
    return `(CASE ${alias}.id ${arms.join(" ")} ELSE ${alias}.team_id END)`;
  }
  // Запасна форма (знімка немає). `NOT IN (…)` без кореляції — хешований підплан, один на запит;
  // `EXISTS` окремо від `SELECT from_team_id`, бо `from_team_id` буває NULL («був без команди»).
  const later = `FROM manager_team_moves mv WHERE mv.manager_id = ${alias}.id AND mv.effective_from > (${dateExpr})`;
  return `(CASE WHEN ${alias}.id NOT IN (SELECT mv0.manager_id FROM manager_team_moves mv0) THEN ${alias}.team_id`
    + ` WHEN EXISTS (SELECT 1 ${later}) THEN (SELECT mv.from_team_id ${later} ORDER BY mv.effective_from LIMIT 1)`
    + ` ELSE ${alias}.team_id END)`;
}

/**
 * Умова «рядок належить команді `teamRef` на свою дату» — заміна `m.team_id = $n` у запитах, де
 * в рядка є дата (анкер грошей, дата створення, день події).
 * Без переходів — рівно `m.team_id = $n`. З переходами перша половина — дешевий фільтр по самій
 * `managers` (планувальник відсікає чужих ДО зʼєднання з угодами, як і раніше); друга — саме правило.
 */
export function teamOnDateSql(alias: string, dateExpr: string, teamRef: string): string {
  if (snapshot && !snapshot.size) return `${alias}.team_id = ${teamRef}`;
  if (snapshot) {
    /**
     * 📐 РОЗЩЕПЛЕНО НАВМИСНО (заміряно 02.10.2026 на проді з одним фіктивним переходом у знімку): умова
     * `CASE … IS NOT DISTINCT FROM $t` на ВСІХ рядках позбавляла планувальник статистики по `team_id` —
     * звіт менеджера по команді 3.5 → 13 с, Огляд команди «холодний» 4 → 20 с. Тепер ті, хто не переходив,
     * ідуть рівно старою умовою `m.team_id = $t`, а `CASE` перевіряється лише для одиниць, що переходили.
     */
    const ids = moverIds(snapshot);
    return `((${alias}.team_id = ${teamRef} AND ${alias}.id <> ALL(${ids}))`
      + ` OR (${alias}.id = ANY(${ids}) AND ${teamAtSql(alias, dateExpr)} IS NOT DISTINCT FROM ${teamRef}))`;
  }
  return `((${alias}.team_id = ${teamRef} OR ${alias}.id IN (SELECT mv1.manager_id FROM manager_team_moves mv1))`
    + ` AND ${teamAtSql(alias, dateExpr)} IS NOT DISTINCT FROM ${teamRef})`;
}

/**
 * Умова з'єднання з `teams` за командою на дату: `JOIN teams t ON ${teamJoinSql("t", "m", дата)}`.
 * Без переходів — рівно `t.id = m.team_id`. З переходами розщеплено, як `teamOnDateSql`: зʼєднання по
 * виразу `CASE` для всіх рядків коштувало «переданим заявкам» Огляду команди 0.4 → 5.6 с (заміряно 02.10.2026).
 */
export function teamJoinSql(teamAlias: string, alias: string, dateExpr: string): string {
  if (snapshot && !snapshot.size) return `${teamAlias}.id = ${alias}.team_id`;
  if (snapshot) {
    const ids = moverIds(snapshot);
    return `((${teamAlias}.id = ${alias}.team_id AND ${alias}.id <> ALL(${ids}))`
      + ` OR (${alias}.id = ANY(${ids}) AND ${teamAlias}.id = ${teamAtSql(alias, dateExpr)}))`;
  }
  return `${teamAlias}.id = ${teamAtSql(alias, dateExpr)}`;
}

/**
 * Умова «менеджер був у команді `teamRef` хоч один день `[fromRef, toRef]`» — для РОСТЕРІВ
 * періоду: у вересневому Звіті команди Яцика Хомік мусить стояти, хоч сьогодні вона вже не там.
 * Команда змінюється лише в дати переходів, тож досить перевірити початок періоду й кожен
 * перехід усередині нього. `IS NOT DISTINCT FROM`, а не `=`: «на початку був без команди» дає
 * NULL, і під `NOT (…)` чи в `SELECT` він читався б не як «ні» (спіймано `#1352`).
 */
export function inTeamDuringSql(alias: string, teamRef: string, fromRef: string, toRef: string): string {
  return `(${teamAtSql(alias, `${fromRef}::date`)} IS NOT DISTINCT FROM ${teamRef}`
    + ` OR EXISTS (SELECT 1 FROM manager_team_moves mv2 WHERE mv2.manager_id = ${alias}.id AND mv2.to_team_id = ${teamRef}`
    + ` AND mv2.effective_from > ${fromRef}::date AND mv2.effective_from <= ${toRef}::date))`;
}

type Db = { query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

export type MoveSource = "settings" | "kommo";
export type RecordResult =
  | { kind: "none" }                         // команда не змінилась
  | { kind: "inserted" | "updated" | "cancelled"; effectiveFrom: string }
  | { kind: "rejected"; reason: string };

/**
 * Записати перехід менеджера з ПОТОЧНОЇ команди в `toTeamId` з дати `effectiveFrom`.
 * Викликати в тій самій транзакції, що й зміну `managers.team_id`: ДО неї (`from` читається з
 * `managers`) або після, передавши `fromTeamId` явно (синк уже переписав рядок upsert-ом).
 *   • дата раніша за останній перехід → `rejected` (ланцюг розірвався б);
 *   • перехід того ж дня вже є → це виправлення: міняємо його `to`; якщо `to` повернувся до
 *     `from`, переходу не було зовсім — рядок видаляється (`cancelled`);
 *   • інакше новий рядок.
 */
export async function recordTeamMove(db: Db, p: {
  managerId: number; toTeamId: number | null; effectiveFrom: string;
  source: MoveSource; setBy?: number | null; note?: string | null;
  /** Команда ДО зміни; не передано — читається з `managers`. */
  fromTeamId?: number | null;
}): Promise<RecordResult> {
  let fromTeamId = p.fromTeamId;
  if (fromTeamId === undefined) {
    const cur = (await db.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [p.managerId])).rows[0];
    if (!cur) return { kind: "rejected", reason: "менеджера немає" };
    fromTeamId = cur.team_id;
  }
  if (fromTeamId === p.toTeamId) return { kind: "none" };
  const last = (await db.query<{ id: string; from_team_id: number | null; ef: string }>(
    `SELECT id, from_team_id, to_char(effective_from, 'YYYY-MM-DD') AS ef FROM manager_team_moves
      WHERE manager_id = $1 ORDER BY effective_from DESC LIMIT 1`, [p.managerId])).rows[0];
  if (last && last.ef > p.effectiveFrom) {
    return { kind: "rejected", reason: `останній перехід уже з ${last.ef} — раніша дата розірвала б історію` };
  }
  if (last && last.ef === p.effectiveFrom) {
    if (last.from_team_id === p.toTeamId) {
      await db.query(`DELETE FROM manager_team_moves WHERE id = $1`, [last.id]);
      return { kind: "cancelled", effectiveFrom: p.effectiveFrom };
    }
    await db.query(
      `UPDATE manager_team_moves SET to_team_id = $2, source = $3, set_by = $4, note = $5, recorded_at = now() WHERE id = $1`,
      [last.id, p.toTeamId, p.source, p.setBy ?? null, p.note ?? null]);
    return { kind: "updated", effectiveFrom: p.effectiveFrom };
  }
  await db.query(
    `INSERT INTO manager_team_moves (manager_id, from_team_id, to_team_id, effective_from, source, set_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.managerId, fromTeamId, p.toTeamId, p.effectiveFrom, p.source, p.setBy ?? null, p.note ?? null]);
  return { kind: "inserted", effectiveFrom: p.effectiveFrom };
}

export type RedateResult =
  | { kind: "updated"; oldFrom: string; effectiveFrom: string; fromTeamId: number | null; toTeamId: number | null }
  | { kind: "same" }                         // дата та сама — змінювати нічого
  | { kind: "rejected"; reason: string };

/**
 * 🗓 ВИПРАВИТИ ДАТУ ОСТАННЬОГО ПЕРЕХОДУ (05.10.2026). Без цього дату неможливо поправити взагалі:
 * повторний вибір тієї ж команди переходу не пише (команда не змінилась), а «з CRM» знімає
 * перевизначення й віддає людину синку. Так 05.10 Хомік записалась «з 05.10» замість «з 01.10».
 *
 * Лише ОСТАННІЙ перехід і лише в межах, що не розривають ланцюг:
 *   • останній перехід мусить вести в ПОТОЧНУ команду (`to == managers.team_id`) — інакше синк
 *     уже переписав команду, і правити дату переходу, якого фактично немає, означало б брехати;
 *   • нова дата не пізніше `today` і СТРОГО пізніше попереднього переходу (у той самий день —
 *     це вже один перехід, а не два; `UNIQUE (manager_id, effective_from)`).
 * Викликати в транзакції; після COMMIT — `refreshTeamMoves`.
 */
export async function redateLastTeamMove(db: Db, p: {
  managerId: number; effectiveFrom: string; today: string; setBy?: number | null;
}): Promise<RedateResult> {
  if (p.effectiveFrom > p.today) return { kind: "rejected", reason: "дата пізніше сьогодні" };
  const moves = (await db.query<{ id: string; f: number | null; t: number | null; ef: string }>(
    `SELECT id, from_team_id AS f, to_team_id AS t, to_char(effective_from, 'YYYY-MM-DD') AS ef
       FROM manager_team_moves WHERE manager_id = $1 ORDER BY effective_from DESC LIMIT 2 FOR UPDATE`, [p.managerId])).rows;
  const last = moves[0];
  if (!last) return { kind: "rejected", reason: "у менеджера немає жодного переходу" };
  const cur = (await db.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [p.managerId])).rows[0];
  if (!cur || cur.team_id !== last.t) {
    return { kind: "rejected", reason: "останній перехід уже не відповідає поточній команді (її змінив синк або інший запис)" };
  }
  if (last.ef === p.effectiveFrom) return { kind: "same" };
  const prev = moves[1];
  if (prev && prev.ef >= p.effectiveFrom) {
    return { kind: "rejected", reason: `попередній перехід — з ${prev.ef}; нова дата мусить бути пізніше` };
  }
  await db.query(
    `UPDATE manager_team_moves SET effective_from = $2, set_by = $3, recorded_at = now() WHERE id = $1`,
    [last.id, p.effectiveFrom, p.setBy ?? null]);
  return { kind: "updated", oldFrom: last.ef, effectiveFrom: p.effectiveFrom, fromTeamId: last.f, toTeamId: last.t };
}
