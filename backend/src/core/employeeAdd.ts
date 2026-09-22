/**
 * 👤 НОВА ЛЮДИНА В РЕЄСТРІ + 📎 ПАКЕТНЕ ЗАВАНТАЖЕННЯ ДОКУМЕНТІВ (22.09.2026, питання Івана: «а щоб додати нового
 * співробітника туди, логіка яка?» і «я додам офери, які були відсутні — їх треба перенести»).
 *
 * Три шляхи в реєстр, і всі дають той самий ключ `import_key = nameKey(ПІБ)`, тож повторний імпорт таблиці
 * знайде ту саму людину, а не створить другу:
 *   • імпорт таблиці (`employees.ts`);
 *   • «+ Співробітник» вручну (`createEmployee`);
 *   • кандидат став «Менеджер» у наймі (`ensureEmployeeFromCandidate`) — статусом або «Перевести в менеджери».
 * Повернення кандидата з «Менеджер» прибирає запис, СТВОРЕНИЙ цим переходом, лише якщо до нього ще нічого не
 * прикріпили (доступи, документи, фото, звільнення); інакше запис лишається — дані людини не губимо.
 * Тримають #646–#649.
 */
import { nameKey, parseDate, ImportError } from "./employeeImport.js";
import type { Db } from "./secrets.js";

const FIELDS = ["position", "team_label", "phone", "email", "telegram", "birth_date", "hired_at", "note"] as const;
const DATES = new Set(["birth_date", "hired_at"]);
const todayKyiv = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

async function audit(db: Db, actorId: number | null, id: number, label: string, action: string, details: Record<string, unknown>) {
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), $2, 'user', $3, $4, $5)`,
    [actorId, action, `e${id}`, label, details]);
}

/** «+ Співробітник». ПІБ обовʼязкове; така сама людина вже є — 409 з її id, щоб екран відкрив наявну картку. */
export async function createEmployee(db: Db, actorId: number, b: Record<string, unknown>) {
  const full = typeof b.full_name === "string" ? b.full_name.replace(/\s+/g, " ").trim() : "";
  if (full.split(" ").length < 2) throw new ImportError(400, "Вкажіть прізвище та імʼя");
  const v: Record<string, string | null> = {};
  for (const k of FIELDS) {
    let s = b[k] == null ? null : String(b[k]).trim() || null;
    if (s && DATES.has(k)) { const d = parseDate(s); if (!d) throw new ImportError(400, `Дата «${s}» не розпізнана`); s = d; }
    if (k === "email" && s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ImportError(400, "Пошта не схожа на адресу");
    if (s && s.length > 300) throw new ImportError(400, "Задовге значення");
    v[k] = s;
  }
  const key = nameKey(full);
  const dup = (await db.query<{ id: number; status: string }>(`SELECT id, status FROM employees WHERE import_key = $1`, [key])).rows[0];
  if (dup) throw Object.assign(new ImportError(409, `«${full}» уже є в реєстрі`), { existingId: dup.id });
  const id = (await db.query<{ id: number }>(
    `INSERT INTO employees (full_name, import_key, status, position, team_label, phone, email, telegram, birth_date, hired_at, note, source, created_by)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10, 'manual', $11) RETURNING id`,
    [full, key, v.position, v.team_label, v.phone, v.email, v.telegram, v.birth_date, v.hired_at ?? todayKyiv(), v.note, actorId])).rows[0].id;
  await audit(db, actorId, id, full, "employees.create", { via: "manual" });
  return { id };
}

/**
 * Кандидат став «Менеджер» → людина в реєстрі. Уже привʼязана — нічого. Та сама людина вже є в реєстрі (за ПІБ) —
 * привʼязуємо, нічого не перезаписуючи. Інакше новий запис: команда кандидата, посада з вакансії, прийнято сьогодні.
 */
export async function ensureEmployeeFromCandidate(db: Db, actorId: number | null, candidateId: number) {
  if ((await db.query(`SELECT 1 FROM employees WHERE candidate_id = $1`, [candidateId])).rowCount) return { created: false, linked: false };
  const c = (await db.query<{ full_name: string; phone: string | null; email: string | null; telegram: string | null; user_id: number | null; team: string | null; position: string | null }>(
    `SELECT c.full_name, c.phone, c.email, c.telegram, c.user_id, t.name AS team,
            (SELECT COALESCE(NULLIF(v.position, ''), v.title) FROM hiring_candidate_vacancies cv JOIN hiring_vacancies v ON v.id = cv.vacancy_id
              WHERE cv.candidate_id = c.id ORDER BY cv.vacancy_id LIMIT 1) AS position
       FROM hiring_candidates c LEFT JOIN teams t ON t.id = c.team_id WHERE c.id = $1`, [candidateId])).rows[0];
  if (!c) return { created: false, linked: false };
  const key = nameKey(c.full_name);
  const same = (await db.query<{ id: number; user_id: number | null; candidate_id: number | null }>(
    `SELECT id, user_id, candidate_id FROM employees WHERE import_key = $1`, [key])).rows[0];
  // Акаунт привʼязуємо, лише якщо він ще нічий у реєстрі (`employees.user_id` унікальний).
  const freeUser = c.user_id != null && !(await db.query(`SELECT 1 FROM employees WHERE user_id = $1`, [c.user_id])).rowCount ? c.user_id : null;
  if (same) {
    if (same.candidate_id != null) return { created: false, linked: false };
    await db.query(`UPDATE employees SET candidate_id = $2, user_id = COALESCE(user_id, $3), updated_at = now() WHERE id = $1`, [same.id, candidateId, freeUser]);
    await audit(db, actorId, same.id, c.full_name, "employees.link_candidate", { candidateId });
    return { created: false, linked: true, id: same.id };
  }
  const id = (await db.query<{ id: number }>(
    `INSERT INTO employees (full_name, import_key, status, position, team_label, phone, email, telegram, hired_at, user_id, candidate_id, source, created_by)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10, 'hiring', $11) RETURNING id`,
    [c.full_name.replace(/\s+/g, " ").trim(), key, c.position, c.team, c.phone, c.email, c.telegram, todayKyiv(), freeUser, candidateId, actorId])).rows[0].id;
  await audit(db, actorId, id, c.full_name, "employees.create", { via: "hiring", candidateId });
  return { created: true, linked: false, id };
}

/** Повернення з «Менеджер»: прибрати запис, СТВОРЕНИЙ переходом, лише якщо до нього нічого не прикріпили. */
export async function undoEmployeeFromCandidate(db: Db, actorId: number | null, candidateId: number) {
  const e = (await db.query<{ id: number; full_name: string; source: string; photo_file: string | null }>(
    `SELECT id, full_name, source, photo_file FROM employees WHERE candidate_id = $1`, [candidateId])).rows[0];
  if (!e) return { removed: false };
  const attached = e.photo_file != null || !!(await db.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM employee_secrets WHERE employee_id = $1)
                 OR EXISTS (SELECT 1 FROM doc_files WHERE employee_id = $1)
                 OR EXISTS (SELECT 1 FROM employee_offboarding WHERE employee_id = $1)
                 OR EXISTS (SELECT 1 FROM exit_interviews WHERE employee_id = $1)`, [e.id])).rowCount;
  if (e.source !== "hiring" || attached) {
    // Людина лишається (дані не губимо); лише знімаємо привʼязку, щоб повторний «Менеджер» не плутав.
    await db.query(`UPDATE employees SET candidate_id = NULL, updated_at = now() WHERE id = $1`, [e.id]);
    return { removed: false };
  }
  await db.query(`DELETE FROM employees WHERE id = $1`, [e.id]);
  await audit(db, actorId, e.id, e.full_name, "employees.remove_undo", { candidateId });
  return { removed: true };
}

/**
 * 📎 Пакетне завантаження: чий це файл — за ПІБ у НАЗВІ файла. Слова назви (без розширення, «_», «-», «.» як
 * пробіли) мусять містити прізвище І імʼя людини; однофамільців не вгадуємо — лише ЄДИНИЙ збіг. Немає або кілька
 * — «не впізнано», людину обирають вручну. Робить це рівно один раз, тут, для прев'ю й запису. Тримає #648.
 */
export interface MatchPerson { id: number; full_name: string; status: string }
export type FileMatch = { file: string; employeeId: number | null; how: "name" | "none" | "ambiguous"; candidates: number[] };
export function matchFilesToEmployees(files: string[], people: MatchPerson[]): FileMatch[] {
  const words = (s: string) => nameKey(s.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_.\-–—]+/g, " ")).split(" ").filter(Boolean);
  return files.map((file) => {
    const w = new Set(words(file));
    const hits = people.filter((p) => { const [a, b] = nameKey(p.full_name).split(" "); return !!a && !!b && w.has(a) && w.has(b); });
    // Той самий ПІБ у працюючого і звільненого — перевага працюючому; двоє працюючих — неоднозначно.
    const pool = hits.length > 1 && hits.some((p) => p.status !== "dismissed") ? hits.filter((p) => p.status !== "dismissed") : hits;
    if (pool.length === 1) return { file, employeeId: pool[0].id, how: "name" as const, candidates: [pool[0].id] };
    return { file, employeeId: null, how: pool.length ? "ambiguous" as const : "none" as const, candidates: pool.map((p) => p.id) };
  });
}

export async function matchFiles(db: Db, files: unknown) {
  if (!Array.isArray(files) || !files.length || files.length > 300) throw new ImportError(400, "Від 1 до 300 файлів");
  const names = files.map((f) => String(f ?? "").slice(0, 300));
  const people = (await db.query<MatchPerson>(`SELECT id, full_name, status FROM employees`)).rows;
  return matchFilesToEmployees(names, people);
}
