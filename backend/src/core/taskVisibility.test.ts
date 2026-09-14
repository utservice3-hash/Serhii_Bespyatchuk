import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import {
  canSeeTask, canTouchTask, isPersonalTask, visibilityCondSql,
  PERSONAL_COLUMNS, PERSONAL_TASK_SQL, ASSIGNED_TASK_SQL,
  TASK_OWNER_JOINS, ASSIGNEE_TEAM_SQL,
  type TaskViewer, type TaskOwnerRow,
} from "./taskVisibility.js";

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

/** Глядачі: по одному на кожну робочу роль, якими міркують роути. */
const ADMIN: TaskViewer = { role: "admin", userId: 1, managerId: null, teamId: null, adminScope: true };
/** company БЕЗ admin_scope — HR і бухгалтерія: «бачать усе, змінюють лише своє». */
const HR: TaskViewer = { role: "company", userId: 2, managerId: -1, teamId: null, adminScope: false };
const LEAD: TaskViewer = { role: "team_lead", userId: 3, managerId: 30, teamId: 7, adminScope: false };
const MGR: TaskViewer = { role: "manager", userId: 4, managerId: 40, teamId: 7, adminScope: false };
const OTHER_MGR: TaskViewer = { role: "manager", userId: 5, managerId: 50, teamId: 9, adminScope: false };
const VIEWERS = [ADMIN, HR, LEAD, MGR, OTHER_MGR];

const row = (o: Partial<TaskOwnerRow>): TaskOwnerRow => ({
  assigneeId: null, assigneeUserId: null, createdBy: null, assigneeTeamId: null, ...o,
});

/** Набір задач, що покриває кожну гілку правила ПО ОБИДВА боки межі. */
const TASKS: { name: string; t: TaskOwnerRow }[] = [
  { name: "особиста адміна", t: row({ createdBy: ADMIN.userId }) },
  { name: "особиста менеджера", t: row({ createdBy: MGR.userId }) },
  { name: "особиста HR", t: row({ createdBy: HR.userId }) },
  { name: "менеджеру своєї команди, автор — тімлід", t: row({ assigneeId: 40, assigneeTeamId: 7, createdBy: LEAD.userId }) },
  { name: "менеджеру чужої команди, автор — адмін", t: row({ assigneeId: 50, assigneeTeamId: 9, createdBy: ADMIN.userId }) },
  { name: "МЕНЕДЖЕР СТВОРИВ КОЛЕЗІ", t: row({ assigneeId: 50, assigneeTeamId: 9, createdBy: MGR.userId }) },
  { name: "акаунту-бухгалтеру, автор — тімлід", t: row({ assigneeUserId: 2, createdBy: LEAD.userId }) },
  { name: "акаунту-менеджеру без картки, автор — адмін", t: row({ assigneeUserId: 4, createdBy: ADMIN.userId }) },
];

/**
 * #400 — ХТО МОЖЕ ЗМІНИТИ, ТОЙ МУСИТЬ БАЧИТИ (`canTouch ⊆ canSee`).
 *
 * 🔴 ЦЕ НЕ ТЕОРЕТИЧНА КРАСА, А ЗАМІРЯНИЙ ДЕФЕКТ. До 14.09.2026 умова видимості
 * жила в `routes/tasks.ts` двома копіями — SQL у `GET /` і функція
 * `canTouchTask` — і для РОЛІ МЕНЕДЖЕРА вони розійшлись: автор задачі, яку він
 * створив колезі, проходив PATCH (`created_by === userId`) і НЕ отримував її у
 * списку (там `created_by` працював лише для задач БЕЗ виконавця). Людина
 * ставила задачу колезі, задача зникала з її екрана, а сервер її правки
 * приймав. Рядок «МЕНЕДЖЕР СТВОРИВ КОЛЕЗІ» у наборі вище — саме цей випадок.
 *
 * 🧨 Червоніє, якщо прибрати `mine` з гілки менеджера в `canSeeTask` — тобто
 * повернути стару розбіжність.
 */
test("#400 МЕЖА ЗАДАЧІ: хто може ЗМІНИТИ, той БАЧИТЬ — по всіх ролях і всіх видах задач", () => {
  const broken: string[] = [];
  for (const v of VIEWERS) {
    for (const { name, t } of TASKS) {
      if (canTouchTask(v, t) && !canSeeTask(v, t)) broken.push(`${v.role}#${v.userId} → ${name}`);
    }
  }
  assert.deepEqual(broken, [],
    "🔴 Є задачі, які роль може ЗМІНИТИ, але не БАЧИТЬ. Саме так автор-менеджер "
    + "втрачав із екрана задачу, поставлену колезі, і правив її навпомацки:\n  " + broken.join("\n  "));

  // Доказ, що перевірці Є що знаходити: набір справді містить випадок, де автор
  // НЕ є виконавцем (без нього інваріанта трималася б сама собою).
  const authored = TASKS.filter((x) => x.t.createdBy === MGR.userId && x.t.assigneeId !== MGR.managerId);
  assert.ok(authored.length > 0, "🔴 у наборі немає задачі «менеджер створив не собі» — гейт нічого не стереже");
  // І прямо: цей випадок менеджер-автор ТЕПЕР бачить.
  assert.ok(canSeeTask(MGR, authored[0].t), "автор-менеджер не бачить задачу, яку створив колезі");
});

/**
 * #400b — 🪞 ОСОБИСТА ЗАДАЧА ПРИВАТНА НАВІТЬ ВІД НАСКРІЗНОГО, І ЦЕ ДВОБІЧНО.
 *
 * Одностороннє «чужий не бачить» зеленіло б і тоді, коли особисті задачі не
 * видно НІКОМУ — тобто коли фіча мертва. Тому обидва боки в одному гейті.
 */
test("#400b 🪞 ОСОБИСТА ЗАДАЧА: автор бачить — решта, включно з наскрізним, НЕ бачить", () => {
  const personal = row({ createdBy: MGR.userId });
  assert.ok(isPersonalTask(personal), "задача без жодного виконавця мусить бути особистою");
  assert.ok(canSeeTask(MGR, personal), "🔴 автор не бачить власну особисту задачу — фіча мертва");
  assert.ok(canTouchTask(MGR, personal), "автор не може змінити власну особисту задачу");
  for (const v of [ADMIN, HR, LEAD, OTHER_MGR]) {
    assert.equal(canSeeTask(v, personal), false, `🔴 ${v.role} бачить чужу особисту задачу`);
    assert.equal(canTouchTask(v, personal), false, `🔴 ${v.role} може змінити чужу особисту задачу`);
  }
});

/**
 * #400c — ВИКОНАВЕЦЬ-АКАУНТ НЕ РОБИТЬ ЗАДАЧУ ОСОБИСТОЮ.
 *
 * 🔴 Стара інваріанта «особиста == `assignee_id IS NULL`» після появи
 * `assignee_user_id` стала хибною: задача бухгалтеру має `assignee_id` NULL.
 * Якби визначення лишилось старим, така задача була б приватною творцю — тобто
 * зникла б з очей самого ВИКОНАВЦЯ. Гейт тримає обидві половини.
 */
test("#400c ВИКОНАВЕЦЬ-АКАУНТ: задача не особиста, видна виконавцю й наглядачу, чужому менеджеру — ні", () => {
  const toAccount = row({ assigneeUserId: HR.userId, createdBy: LEAD.userId });
  assert.equal(isPersonalTask(toAccount), false, "🔴 задача, призначена акаунту, вважається особистою");
  assert.ok(canSeeTask(HR, toAccount), "🔴 виконавець-акаунт не бачить власну задачу");
  assert.ok(canTouchTask(HR, toAccount), "виконавець-акаунт не може рухати власну задачу");
  assert.ok(canSeeTask(ADMIN, toAccount), "наскрізний не бачить призначену задачу");
  assert.ok(canSeeTask(LEAD, toAccount), "автор-тімлід не бачить задачу, яку поставив");
  assert.equal(canSeeTask(OTHER_MGR, toAccount), false, "🔴 сторонній менеджер бачить чужу задачу");

  // Кожна колонка власності поодинці мусить виводити задачу з «особистих» —
  // інакше перелік `PERSONAL_COLUMNS` розійдеться з `isPersonalTask`.
  for (const c of PERSONAL_COLUMNS) {
    const only = row({ [c.field]: 99 } as Partial<TaskOwnerRow>);
    assert.equal(isPersonalTask(only), false,
      `🔴 заповнена лише ${c.column} — задача все одно «особиста», отже перелік колонок і функція розійшлись`);
  }
  assert.ok(isPersonalTask(row({})), "порожній рядок мусить бути особистим — інакше перевірка вище тривіальна");
});

/**
 * #400e — ВЬЮ `ai_tasks` І КОД ОПИСУЮТЬ ОДНЕ Й ТЕ САМЕ «НЕ ОСОБИСТА».
 *
 * Приватність особистих задач від моделі тримає вью в схемі, а видимість на
 * екрані — код. Два визначення в одній системі вже давали «чипи новий/постійний»
 * і вічний банер джоби, тож тут вони звіряються текстом схеми проти переліку
 * `PERSONAL_COLUMNS`. 🧨 Червоніє, якщо додати третю колонку власності в код і
 * не змінити вью — і якщо звузити вью назад до `assignee_id IS NOT NULL`.
 */
test("#400e ВЬЮ ai_tasks == визначенню «не особиста» з ядра", () => {
  const sql = readFileSync(SCHEMA, "utf8");
  const m = sql.match(/CREATE OR REPLACE VIEW ai_tasks AS[\s\S]*?WHERE([\s\S]*?);/);
  assert.ok(m, "🔴 у schema.sql не знайдено вью ai_tasks — перевіряти нема чого");
  const where = m![1];
  for (const c of PERSONAL_COLUMNS) {
    assert.match(where, new RegExp(`\\b${c.column}\\b`),
      `🔴 вью ai_tasks не згадує ${c.column}: приватність задач і код розійшлися`);
  }
  // Дзеркало: вираз «не особиста» з ядра мусить називати ті самі колонки.
  for (const c of PERSONAL_COLUMNS) {
    assert.match(ASSIGNED_TASK_SQL, new RegExp(`\\b${c.column}\\b`));
    assert.match(PERSONAL_TASK_SQL, new RegExp(`\\b${c.column}\\b`));
  }
});

/**
 * #400f — СУПУТНИКИ ЗАДАЧ ЗАКРИТІ ВІД МОДЕЛІ НА ДВОХ РУБЕЖАХ.
 *
 * `GRANT SELECT ON ALL TABLES` у схемі накриває кожну нову таблицю, тож
 * `task_comments` (зміст обговорення) і `task_files` (назви вкладень) відкрились
 * би `ai_readonly` САМІ — при тому, що сира `tasks` від неї відібрана. Заборона
 * на заголовок без заборони на розмову — це заборона, що нічого не стереже.
 * 🧨 Червоніє, якщо прибрати таблицю з REVOKE у схемі або з `FORBIDDEN_TABLES`.
 */
test("#400f СУПУТНИКИ ЗАДАЧ: закриті і в схемі (REVOKE), і в переліку застосунку", () => {
  const COMPANIONS = ["task_comments", "task_files", "task_status_log", "task_views", "task_groups"];
  const sql = readFileSync(SCHEMA, "utf8");
  const revoke = sql.match(/REVOKE ALL ON users[\s\S]*?FROM ai_readonly;/);
  assert.ok(revoke, "🔴 у schema.sql не знайдено блоку REVOKE для ai_readonly");
  const missingSql = COMPANIONS.filter((t) => !new RegExp(`\\b${t}\\b`).test(revoke![0]));
  assert.deepEqual(missingSql, [],
    `🔴 таблиці не відібрані в ai_readonly — модель прочитає обговорення особистих задач: ${missingSql.join(", ")}`);

  const tools = readFileSync(path.join(import.meta.dirname, "..", "ai", "metricTools.js"), "utf8");
  const list = tools.match(/FORBIDDEN_TABLES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(list, "🔴 у metricTools не знайдено FORBIDDEN_TABLES");
  const missingApp = COMPANIONS.filter((t) => !new RegExp(`"${t}"`).test(list![1]));
  assert.deepEqual(missingApp, [],
    `🔴 таблиці не в FORBIDDEN_TABLES — рубіж застосунку відсутній: ${missingApp.join(", ")}`);
});

/**
 * #400g — КОЖЕН ЧИТАЧ `task_files` НЕСЕ `deleted_at IS NULL`.
 *
 * Видалення вкладення МʼЯКЕ (рішення ТЗ §3.4: бекап файлів у нас немає, тож
 * помилковий клік має відновлюватись `UPDATE`, а не з нізвідки). Ціна — умова
 * в кожному читачі; забути її означає повернути видалені файли на екран.
 * 🧨 Червоніє, якщо додати запит по `task_files` без цієї умови.
 */
test("#400g ЧИТАЧІ task_files НЕСУТЬ deleted_at IS NULL — мʼяке видалення не протікає", () => {
  const raw = readFileSync(path.join(import.meta.dirname, "..", "routes", "tasks.js"), "utf8");
  // 🔴 КОМЕНТАРІ ЗРІЗАЮТЬСЯ ДО ПОШУКУ. Перша редакція цього гейта червоніла на
  // власному доккоментарі «`task_files.task_id` має ON DELETE CASCADE»: бектики
  // в тексті виглядають як шаблонний рядок. Предмет гейта — ЗАПИТ, а не згадка;
  // той самий приймач стоїть у воротах `#17`.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const blocks = [...src.matchAll(/`([^`]*task_files[^`]*)`/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 4, `🔴 знайдено лише ${blocks.length} запитів по task_files — розбір зламався`);
  const naked = blocks
    // Вставка й мʼяке видалення самі собою умови не потребують.
    .filter((b) => !/INSERT INTO task_files/.test(b) && !/UPDATE task_files SET deleted_at/.test(b))
    // Збір імен перед видаленням ЗАДАЧІ свідомо бере й мʼяко видалені: інакше
    // їхні байти лишились би на диску без жодного рядка, який про них знає.
    .filter((b) => !/SELECT stored_name FROM task_files WHERE task_id/.test(b))
    .filter((b) => !/deleted_at IS NULL/.test(b))
    .map((b) => b.replace(/\s+/g, " ").slice(0, 90));
  assert.deepEqual(naked, [],
    "🔴 запит по task_files без `deleted_at IS NULL` — видалені вкладення повернуться на екран:\n  "
    + naked.join("\n  "));
});

/**
 * #400d — 🪞 СХЕМА З НУЛЯ: SQL-УМОВА ВИДИМОСТІ == JS-ПРАВИЛУ, НА СПРАВЖНІХ РЯДКАХ.
 *
 * 🔴 НАВІЩО БАЗА, ЯКЩО Є ФІКСТУРИ ВИЩЕ. Бо фікстури перевіряють JS-правило, а на
 * екран людині відповідає SQL — і саме там живуть помилки, яких `tsc` не бачить
 * (SQL у шаблонному рядку не типізується взагалі; так уже їхав `d.id = e.deal_id`
 * і `day` без `AS`). Тут обидві реалізації біжать по ОДНИХ І ТИХ САМИХ рядках в
 * ОДНУ мить, і порівнюються множини id — тобто це не «схоже число», а рівність.
 *
 * Заодно перевіряються межі БД, які інакше спливли б 500-ю на проді: CHECK
 * «виконавець один», унікальність назви групи у власника і `ON DELETE SET NULL`
 * (видалення папки не сміє забирати задачі).
 */
test("#400d 🪞 СХЕМА З НУЛЯ: SQL-скоуп == JS-правилу; CHECK одного виконавця; група не тягне задачі", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (7,'РПК-7'),(9,'РПК-9')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES
        (30,'Тімлід',7,true), (40,'Менеджер',7,true), (50,'Чужий менеджер',9,true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,full_name) VALUES
        (1,'admin@uts.ua','x','admin',NULL,NULL,'Адмін'),
        (2,'hr@uts.ua','x','manager',NULL,NULL,'Бухгалтер'),
        (3,'lead@uts.ua','x','team_lead',30,7,'Тімлід'),
        (4,'mgr@uts.ua','x','manager',40,7,'Менеджер'),
        (5,'other@uts.ua','x','manager',50,9,'Чужий')`);

    // Ті самі вісім задач, що у фікстурі вище — тепер рядками в базі.
    for (const [i, { t: x }] of TASKS.entries()) {
      await c.query(
        `INSERT INTO tasks (id, title, assignee_id, assignee_user_id, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [100 + i, `задача ${i}`, x.assigneeId, x.assigneeUserId, x.createdBy]
      );
    }

    // Для кожної ролі: множина id із SQL проти множини id із JS.
    for (const v of VIEWERS) {
      const params: unknown[] = [];
      const push = (val: unknown) => { params.push(val); return params.length; };
      const cond = visibilityCondSql(v, push);
      const sqlRows = await c.query<{ id: number }>(
        `SELECT t.id FROM tasks t${TASK_OWNER_JOINS} WHERE ${cond} ORDER BY t.id`, params);
      const fromSql = sqlRows.rows.map((r) => r.id).sort((a, b) => a - b);

      // JS-бік рахується з ТИХ САМИХ рядків, узятих одним запитом.
      const all = await c.query<{ id: number; assignee_id: number | null; assignee_user_id: number | null; created_by: number | null; team: number | null }>(
        `SELECT t.id, t.assignee_id, t.assignee_user_id, t.created_by, ${ASSIGNEE_TEAM_SQL} AS team
           FROM tasks t${TASK_OWNER_JOINS} ORDER BY t.id`);
      const fromJs = all.rows
        .filter((r) => canSeeTask(v, {
          assigneeId: r.assignee_id, assigneeUserId: r.assignee_user_id,
          createdBy: r.created_by, assigneeTeamId: r.team,
        }))
        .map((r) => r.id).sort((a, b) => a - b);

      assert.deepEqual(fromSql, fromJs,
        `🔴 ${v.role}#${v.userId}: SQL-скоуп розійшовся з JS-правилом. SQL=${fromSql} JS=${fromJs}`);
      // Порожньо для всіх означало б, що порівнюються дві порожнечі.
      if (v.adminScope) assert.ok(fromSql.length > 0, "наскрізний не бачить НІЧОГО — порівняння тривіальне");
    }

    // CHECK «виконавець один»: обидва поля разом неможливі.
    await assert.rejects(
      c.query(`INSERT INTO tasks (title, assignee_id, assignee_user_id) VALUES ('обидва',40,4)`),
      /tasks_one_assignee/, "🔴 задача з двома виконавцями пройшла — CHECK знято");

    // Група особиста: однакова назва в одного власника неможлива, у різних — так.
    // 🔴 id НЕ задаємо вручну: явний id=1 не рухає SERIAL, і наступна вставка
    // падає на PRIMARY KEY замість потрібного унікального індексу — гейт тоді
    // зеленів би «не з тієї причини».
    const mine = await c.query<{ id: number }>(
      `INSERT INTO task_groups (owner_id,name) VALUES (4,'Дашборд') RETURNING id`);
    const gid = mine.rows[0].id;
    await assert.rejects(
      c.query(`INSERT INTO task_groups (owner_id,name) VALUES (4,'дашборд')`),
      /uq_task_groups_owner_name/, "🔴 дубль назви групи у власника пройшов (регістр не має значення)");
    // 🪞 В ІНШОГО власника та сама назва — законна: групи особисті.
    await c.query(`INSERT INTO task_groups (owner_id,name) VALUES (5,'Дашборд')`);

    // 🪞 Видалення ПАПКИ не забирає задачу — вона повертається в «Без групи».
    await c.query(`UPDATE tasks SET group_id = $1 WHERE id = 101`, [gid]);
    await c.query(`DELETE FROM task_groups WHERE id = $1`, [gid]);
    const kept = await c.query<{ id: number; group_id: number | null }>(
      `SELECT id, group_id FROM tasks WHERE id = 101`);
    assert.equal(kept.rowCount, 1, "🔴 видалення групи знесло ЗАДАЧУ — робота людини втрачена прибиранням на екрані");
    assert.equal(kept.rows[0].group_id, null, "задача лишилась у видаленій групі");
  } finally {
    await c.end();
    scratch.dispose();
  }
});
