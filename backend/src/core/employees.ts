/**
 * 🗂 РЕЄСТР СПІВРОБІТНИКІВ + ІМПОРТ ТАБЛИЦІ — ОПЕРАЦІЇ З БАЗОЮ (18.09.2026, задача №3898).
 * Правила розбору — `employeeImport.ts`; шифр і сейф — `secrets.ts`.
 *
 * Прев'ю й імпорт рахуються ОДНІЄЮ функцією (`plan`), тож «що показали» і «що записали» не
 * розходяться. 🔴 Прев'ю не віддає жодного значення секрету — лише скільки їх і куди підуть.
 */
import { parseCsv, buildRows, guessTarget, validateMapping, shortKey, ImportError, SECRETISH, headersAt, detectHeaderRow, parseDate, type PlainRow } from "./employeeImport.js";
import { prepareSecret, insertSecrets, SecretError, type Db } from "./secrets.js";
import { SecretKeyMissing } from "./secretBox.js";
import { DOC_COUNTS_SQL } from "./employeeDocs.js";

const MAX_ROWS = 3000, MAX_COLS = 120;
const NAME = `COALESCE(NULLIF(u.full_name, ''), m.name, u.email)`;

type Annotated = { r: PlainRow; m: Match; duplicate: boolean; isNew: boolean };
type Match = { userId: number | null; account: string | null; how: "email" | "name" | "linked" | "none" | "ambiguous" | "taken" };

async function loadContext(db: Db) {
  const users = (await db.query<{ id: number; email: string; name: string }>(
    `SELECT u.id, lower(u.email) AS email, ${NAME} AS name FROM users u LEFT JOIN managers m ON m.id = u.manager_id
      WHERE COALESCE(u.role_override, u.role) <> 'candidate'`)).rows;
  const existing = (await db.query<{ id: number; import_key: string; user_id: number | null }>(
    `SELECT id, import_key, user_id FROM employees`)).rows;
  return { users, existing };
}

function matcher(ctx: Awaited<ReturnType<typeof loadContext>>) {
  const byEmail = new Map(ctx.users.map((u) => [u.email, u]));
  const byShort = new Map<string, typeof ctx.users>();
  for (const u of ctx.users) { const k = shortKey(u.name); byShort.set(k, [...(byShort.get(k) ?? []), u]); }
  const byKey = new Map(ctx.existing.map((e) => [e.import_key, e]));
  const linkedTo = new Map(ctx.existing.filter((e) => e.user_id != null).map((e) => [e.user_id!, e.import_key]));
  const users = new Map(ctx.users.map((u) => [u.id, u]));
  return (r: PlainRow, claimed: Map<number, string>): Match => {
    const own = byKey.get(r.key);
    if (own?.user_id != null) return { userId: own.user_id, account: users.get(own.user_id)?.name ?? null, how: "linked" };
    let u: { id: number; name: string } | undefined, how: Match["how"] = "none";
    const e = r.fields.email?.toLowerCase();
    if (e && byEmail.has(e)) { u = byEmail.get(e); how = "email"; }
    else {
      // «Рівно один» — серед УСІХ акаунтів, а не серед тих, хто спитав (правило 2).
      const c = byShort.get(r.short) ?? [];
      if (c.length === 1) { u = c[0]; how = "name"; } else if (c.length > 1) return { userId: null, account: null, how: "ambiguous" };
    }
    if (!u) return { userId: null, account: null, how: "none" };
    const other = linkedTo.get(u.id) ?? claimed.get(u.id);
    if (other && other !== r.key) return { userId: null, account: u.name, how: "taken" };
    return { userId: u.id, account: u.name, how };
  };
}

const MATCH_NOTE: Record<Match["how"], string> = {
  email: "за поштою", name: "за прізвищем та імʼям", linked: "уже привʼязаний",
  none: "акаунта в дашборді немає", ambiguous: "кілька акаунтів із таким ПІБ — привʼяжіть вручну",
  taken: "цей акаунт уже привʼязаний до іншої людини",
};

/** Спільний розрахунок для прев'ю й імпорту. */
async function plan(db: Db, csv: unknown, mapping: unknown, headerRowIn?: unknown) {
  if (typeof csv !== "string" || !csv.trim()) throw new ImportError(400, "Файл порожній");
  const table = parseCsv(csv);
  if (table.length < 2) throw new ImportError(400, "У файлі немає рядків під заголовком");
  if (table.length - 1 > MAX_ROWS) throw new ImportError(400, `Забагато рядків: ${table.length - 1} (межа ${MAX_ROWS})`);
  // Рядок заголовків: названий людиною (1-based, як у Google) або знайдений сам.
  const candidates = detectHeaderRow(table);
  const asked = Number(headerRowIn);
  const headerRow = Number.isInteger(asked) && asked >= 1 && asked <= Math.min(15, table.length - 1) ? asked - 1 : (candidates[0]?.row ?? 0);
  const headers = headersAt(table, headerRow);
  if (headers.length > MAX_COLS) throw new ImportError(400, `Забагато колонок: ${headers.length}`);
  const chosen = Array.isArray(mapping) && mapping.length === headers.length ? mapping.map(String) : headers.map(guessTarget);
  const body = table.slice(headerRow + 1);
  const columns = headers.map((header, index) => ({
    index, header, target: chosen[index] ?? "skip", secretish: SECRETISH.test(header),
    filled: body.filter((r) => (r[index] ?? "").trim() !== "").length,
  }));
  const headerInfo = { headerRow: headerRow + 1, headerCandidates: candidates.map((c) => ({ row: c.row + 1, fields: c.fields })) };
  let mappingError: string | null = null;
  try { validateMapping(headers, chosen); } catch (e) { if (e instanceof ImportError) mappingError = e.message; else throw e; }
  if (mappingError) return { columns, mappingError, rows: [] as Annotated[], skipped: 0, ...headerInfo };
  const match = matcher(await loadContext(db));
  const built = buildRows(table, chosen, headerRow);
  const skipped = body.filter((r) => r.some((c) => c.trim() !== "")).length - built.length;
  const seenKeys = new Set<string>(), claimed = new Map<number, string>();
  const existingKeys = new Set((await db.query<{ import_key: string }>(`SELECT import_key FROM employees`)).rows.map((r) => r.import_key));
  // Та сама людина двічі (повторний прийом, дубль рядка) — ОБʼЄДНУЄМО в перший рядок, а не відкидаємо:
  // інакше паролі з другого рядка губляться. Якщо одна з появ без дати звільнення — людина працює зараз,
  // і її поля (дати, посада) беруть гору; решта полів доповнює порожні. Секрети — усі; повтор сервісу
  // отримує мітку «рядок N», щоб у сейфі лягли обидва.
  const firstOf = new Map<string, PlainRow>();
  function mergeInto(a: PlainRow, b: PlainRow) {
    const bCurrent = !b.fields.dismissed_at && a.fields.dismissed_at;
    for (const [k, v] of Object.entries(b.fields)) if (k !== "dismissed_at" && v != null && (bCurrent || a.fields[k] == null)) a.fields[k] = v;
    // Звільнення: хоч одна поява без дати — людина працює; обидві з датою — пізніша.
    const da = a.fields.dismissed_at, db = b.fields.dismissed_at;
    a.fields.dismissed_at = !da || !db ? null : da > db ? da : db;
    a.extra = { ...b.extra, ...a.extra };
    for (const sec of b.secrets) {
      const clash = a.secrets.some((x) => x.kind === sec.kind && x.service === sec.service && (x.label ?? "") === (sec.label ?? ""));
      a.secrets.push(clash ? { ...sec, label: `${sec.label ? sec.label + " · " : ""}рядок ${b.line}` } : sec);
    }
    a.problems.push(...b.problems);
  }
  function annotate(r: PlainRow): Annotated {
    const duplicate = seenKeys.has(r.key); seenKeys.add(r.key);
    if (duplicate) mergeInto(firstOf.get(r.key)!, r); else firstOf.set(r.key, r);
    const m = duplicate ? { userId: null, account: null, how: "none" as const } : match(r, claimed);
    if (m.userId != null && !duplicate) claimed.set(m.userId, r.key);
    return { r, m, duplicate, isNew: !existingKeys.has(r.key) };
  }
  return { columns, mappingError, rows: built.map(annotate), skipped, ...headerInfo };
}

/** Прев'ю: колонки зі здогадом, люди із зіставленням. Значень секретів тут немає. */
export async function previewImport(db: Db, csv: unknown, mapping: unknown, headerRow?: unknown) {
  const p = await plan(db, csv, mapping, headerRow);
  const rows = p.rows.map(({ r, m, duplicate, isNew }) => ({
    line: r.line, name: r.full_name, position: r.fields.position ?? null, team: r.fields.team_label ?? null,
    state: duplicate ? "duplicate" : isNew ? "new" : "update",
    account: m.account, match: m.how, matchNote: duplicate ? "повтор цієї ж людини — обʼєднано з першим рядком (паролі теж)" : MATCH_NOTE[m.how],
    secrets: r.secrets.length, secretsLost: 0, secretsNoAccount: m.userId == null && !duplicate ? r.secrets.length : 0, problems: r.problems,
  }));
  const t = (f: (x: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  return {
    columns: p.columns, mappingError: p.mappingError, rows, headerRow: p.headerRow, headerCandidates: p.headerCandidates,
    totals: {
      rows: rows.length, new: t((x) => x.state === "new"), update: t((x) => x.state === "update"), duplicate: t((x) => x.state === "duplicate"),
      withAccount: t((x) => x.state !== "duplicate" && x.account != null && x.match !== "taken"),
      noAccount: t((x) => x.state !== "duplicate" && (x.match === "none" || x.match === "ambiguous" || x.match === "taken")),
      secrets: rows.reduce((s, x) => s + (x.state === "duplicate" ? 0 : x.secrets), 0),
      secretsLost: 0,
      secretsNoAccount: rows.reduce((s, x) => s + x.secretsNoAccount, 0),
      problems: t((x) => x.problems.length > 0),
      skipped: p.skipped,
    },
  };
}

/**
 * Імпорт. Одна транзакція (її відкриває роут). Людина — upsert за ПІБ, порожнє в файлі НЕ затирає
 * заповнене в реєстрі. Секрет пишеться, лише якщо в людини є акаунт і такого запису в сейфі ще немає:
 * те, що хтось уже змінив у дашборді, імпорт не перезаписує.
 */
export async function commitImport(db: Db, key: Buffer | null, actorId: number, csv: unknown, mapping: unknown, sheet: unknown, headerRow?: unknown) {
  const status = sheet === "dismissed" ? "dismissed" : sheet === "active" ? "active" : null;
  if (!status) throw new ImportError(400, "Вкажіть, це аркуш працюючих чи звільнених");
  const p = await plan(db, csv, mapping, headerRow);
  if (p.mappingError) throw new ImportError(400, p.mappingError);
  if (!key && p.rows.some((x) => x.r.secrets.length > 0 && !x.duplicate)) throw new SecretKeyMissing();
  // Один імпорт за раз: другий клік, поки йде перший, отримує 409, а не паралельний прохід (18.09.2026 кнопку
  // натиснули двічі, бо екран мовчав). Блокування живе до кінця транзакції. Тримає #571.
  const locked = (await db.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext('employees.import')) AS ok`)).rows[0]?.ok;
  if (!locked) throw new ImportError(409, "Імпорт уже триває — дочекайтесь його завершення");
  // Наявні записи сейфу — один запит на весь імпорт, а не по одному на кожен пароль. Тримає #570.
  const have = new Set((await db.query<{ k: string }>(
    `SELECT CASE WHEN user_id IS NOT NULL THEN 'u' || user_id ELSE 'e' || employee_id END || '|' || kind || '|' || service || '|' || COALESCE(label, '') AS k
       FROM employee_secrets WHERE superseded_at IS NULL AND deleted_at IS NULL`)).rows.map((r) => r.k));
  const c = { rows: 0, created: 0, updated: 0, duplicate: 0, linked: 0, secretsCreated: 0, secretsExisting: 0, secretsNoAccount: 0, secretsInvalid: 0 };
  for (const { r, m, duplicate } of p.rows) {
    if (duplicate) { c.duplicate++; continue; }
    c.rows++;
    const f = r.fields;
    const st = f.dismissed_at ? "dismissed" : status;
    const up = (await db.query<{ id: number; inserted: boolean; user_id: number | null }>(
      `INSERT INTO employees (full_name, import_key, user_id, status, position, team_label, phone, email, telegram,
                              birth_date, hired_at, dismissed_at, dismiss_reason, note, extra, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (import_key) DO UPDATE SET
         full_name = EXCLUDED.full_name, user_id = COALESCE(employees.user_id, EXCLUDED.user_id),
         -- 🚪 Людину, яку звільняють кнопками (employee_offboarding), таблиця не перемикає: стан і дату веде звільнення.
         status = CASE WHEN EXISTS (SELECT 1 FROM employee_offboarding o WHERE o.employee_id = employees.id) THEN employees.status ELSE EXCLUDED.status END,
         position = COALESCE(EXCLUDED.position, employees.position), team_label = COALESCE(EXCLUDED.team_label, employees.team_label),
         phone = COALESCE(EXCLUDED.phone, employees.phone), email = COALESCE(EXCLUDED.email, employees.email),
         telegram = COALESCE(EXCLUDED.telegram, employees.telegram), birth_date = COALESCE(EXCLUDED.birth_date, employees.birth_date),
         hired_at = COALESCE(EXCLUDED.hired_at, employees.hired_at), dismissed_at = CASE WHEN EXISTS (SELECT 1 FROM employee_offboarding o WHERE o.employee_id = employees.id) THEN employees.dismissed_at
                             ELSE COALESCE(EXCLUDED.dismissed_at, employees.dismissed_at) END,
         dismiss_reason = COALESCE(EXCLUDED.dismiss_reason, employees.dismiss_reason), note = COALESCE(EXCLUDED.note, employees.note),
         extra = employees.extra || EXCLUDED.extra, updated_at = now()
       RETURNING id, (xmax = 0) AS inserted, user_id`,
      [r.full_name, r.key, m.userId, st, f.position ?? null, f.team_label ?? null, f.phone ?? null, f.email ?? null, f.telegram ?? null,
        f.birth_date ?? null, f.hired_at ?? null, f.dismissed_at ?? null, f.dismiss_reason ?? null, f.note ?? null, r.extra, actorId])).rows[0];
    if (up.inserted) c.created++; else c.updated++;
    if (up.user_id != null) c.linked++;
    // Людина з акаунтом — записи на акаунті; без акаунта — на людині реєстру (рішення Романа 18.09.2026).
    const ownerKey = up.user_id != null ? `u${up.user_id}` : `e${up.id}`;
    const batch: ReturnType<typeof prepareSecret>[] = [];
    for (const s of r.secrets) {
      if (up.user_id == null) c.secretsNoAccount++;
      const k = `${ownerKey}|${s.kind}|${s.kind === "card" ? "card" : s.service}|${s.label ?? ""}`;
      if (have.has(k)) { c.secretsExisting++; continue; }
      try {
        batch.push(prepareSecret({ kind: s.kind, service: s.service, label: s.label, value: s.value,
          login: s.login ?? (s.service === "mail" ? f.email ?? null : null) }));
        have.add(k);
      } catch (e) {
        if (e instanceof SecretError && e.status === 400) { c.secretsInvalid++; continue; }
        throw e;
      }
    }
    if (batch.length) {
      const owner = { userId: up.user_id, employeeId: up.user_id == null ? up.id : null, name: m.account ?? r.full_name, ref: up.user_id != null ? String(up.user_id) : `e${up.id}` };
      c.secretsCreated += (await insertSecrets(db, key, actorId, owner, batch)).length;
    }
  }
  // 🔴 В аудит — лише лічильники й назви колонок, жодного значення. `target_type` — 'user' (той, хто
  // імпортував): CHECK аудиту не розширюємо, його читають «Налаштування → Журнал доступів».
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), 'employees.import', 'user', $1::text, $2, $3)`,
    [actorId, `імпорт таблиці: ${status === "active" ? "працюючі" : "звільнені"}`,
      { counts: c, headerRow: p.headerRow, columns: p.columns.map((x) => ({ header: x.header, target: x.target })) }]);
  return c;
}

const EDITABLE = ["full_name", "position", "team_label", "phone", "email", "telegram", "birth_date", "hired_at", "dismissed_at", "dismiss_reason", "note", "status"] as const;
const DATES = new Set(["birth_date", "hired_at", "dismissed_at"]);

/**
 * Редагування людини реєстру (18.09.2026). Лише названі поля; дата — «РРРР-ММ-ДД» чи «ДД.ММ.РРРР», порожнє → null.
 * Статус і дата звільнення узгоджуються: «працює» стирає дату звільнення, нова дата звільнення ставить
 * «звільнений» (якщо статус не названо явно). `import_key` НЕ змінюється — повторний імпорт знайде ту саму людину.
 * В аудит — назви змінених полів, без значень. Тримає #569.
 */
export async function updateEmployee(db: Db, actorId: number, id: number, body: Record<string, unknown>) {
  const cur = (await db.query<Record<string, unknown>>(
    `SELECT id, full_name, position, team_label, phone, email, telegram, birth_date::text AS birth_date, hired_at::text AS hired_at,
            dismissed_at::text AS dismissed_at, dismiss_reason, note, status FROM employees WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw new ImportError(404, "Співробітника не знайдено");
  // 🚪 Звільнення кнопками (`core/offboarding.ts`) веде статус і дату саме: правка форми обійшла б
  // стан менеджера й акаунт. Тримає #622.
  const offboarding = !!(await db.query(`SELECT 1 FROM employee_offboarding WHERE employee_id = $1`, [id])).rowCount;
  const next: Record<string, unknown> = {};
  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    const raw = body[k];
    let v: string | null = raw == null ? null : String(raw).trim() || null;
    if (k === "full_name" && !v) throw new ImportError(400, "ПІБ не може бути порожнім");
    if (k === "status" && v !== "active" && v !== "dismissed") throw new ImportError(400, "Статус: працює або звільнений");
    if (DATES.has(k) && v) { const d = parseDate(v); if (!d) throw new ImportError(400, `Дата «${v}» не розпізнана`); v = d; }
    if (k === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new ImportError(400, "Пошта не схожа на адресу");
    if (v != null && v.length > 300) throw new ImportError(400, "Задовге значення");
    next[k] = v;
  }
  if (offboarding && (("status" in next && next.status !== cur.status) || ("dismissed_at" in next && next.dismissed_at !== cur.dismissed_at)))
    throw new ImportError(409, "Людину звільняють кнопками — статус і дату змінюйте через «Завершити звільнення» або «Повернути»");
  if ("status" in next && next.status === "active") next.dismissed_at = null;
  else if (!("status" in next) && next.dismissed_at) next.status = "dismissed";
  const changed = Object.keys(next).filter((k) => String(next[k] ?? "") !== String(cur[k] ?? ""));
  if (!changed.length) return { changed: [] as string[] };
  const sets = changed.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await db.query(`UPDATE employees SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...changed.map((k) => next[k])]);
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), 'employees.update', 'user', $2, $3, $4)`,
    [actorId, `e${id}`, cur.full_name, { changed }]);
  return { changed };
}

/** Реєстр: люди, акаунт, скільки записів у сейфі. */
export async function listEmployees(db: Db) {
  return (await db.query(
    `SELECT e.id, CASE WHEN e.user_id IS NOT NULL THEN e.user_id::text ELSE 'e' || e.id END AS ref, e.full_name, e.status, e.position, e.team_label, e.phone, e.email, e.telegram,
            e.birth_date::text AS birth_date, e.hired_at::text AS hired_at, e.dismissed_at::text AS dismissed_at,
            e.dismiss_reason, e.note, e.extra, e.user_id, ${NAME} AS account_name, u.is_active AS account_active,
            e.manager_id, km.name AS kommo_name, o.stage AS offboarding, o.last_day::text AS last_day, ${DOC_COUNTS_SQL},
            (SELECT count(*)::int FROM employee_secrets s WHERE (s.user_id = e.user_id OR s.employee_id = e.id) AND s.superseded_at IS NULL AND s.deleted_at IS NULL) AS secrets,
            e.updated_at
       FROM employees e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN managers m ON m.id = u.manager_id
       LEFT JOIN managers km ON km.id = e.manager_id LEFT JOIN employee_offboarding o ON o.employee_id = e.id
      ORDER BY (e.status = 'dismissed'), e.full_name`)).rows;
}

export { ImportError };
