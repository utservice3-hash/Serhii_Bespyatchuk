import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #1080f — «ЗАКРИВАЄ ТОЙ, ХТО ПРИЙМАЄ» НА РОУТІ: обробники виконуються проти бази з нуля.
 *
 * `#1080`…`#1080e` перевіряють ПРАВИЛО (чиста функція). Тут — що роут справді його
 * застосовує, і що видача віддає ті самі права, за якими фронт малює меню. Кличемо
 * обробники В ПРОЦЕСІ з мок-`req`/`res` (той самий прийом, що `#400h`): без сервера,
 * без мережі, проти одноразового кластера. На проді нічого не створюється.
 *
 * Акаунти — ті, що вимагає ТЗ: виконавець, «Приймає», третя людина без прав, адмін;
 * плюс тімлід виконавця (рішення Романа 30.09: рухає, не закриває).
 * ⚠️ «Приймає» тут НЕ адмін навмисно. У проді Юлія — КВП з `admin_scope` і пройшла б
 * як адмін, тобто перевірка не торкнулась би гілки «Приймає» взагалі.
 *
 * 🧨 Червоніє, якщо: дати виконавцю `done` у PATCH; не пустити «Приймає» (він не
 * учасник за `canTouchTask`); віддати у видачі права, що розходяться з PATCH;
 * розповзтись правилом на інші типи задач чи системну задачу без автора.
 */
test("#1080f РОУТ: виконавець не закриває (403 з іменем), «Приймає» закриває, стороння людина — нічого, видача дзеркалить PATCH", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (7,'РПК-7'),(9,'РПК-9')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES
        (30,'Тімлід Сьомої',7,true),(40,'Виконавець Роман',7,true),(50,'Сторонній',9,true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,full_name) VALUES
        (1,'admin@uts.ua','x','admin',NULL,NULL,'Адмін'),
        (3,'lead@uts.ua','x','team_lead',30,7,NULL),
        (4,'exec@uts.ua','x','manager',40,7,NULL),
        (5,'other@uts.ua','x','manager',50,9,NULL),
        (6,'yulia@uts.ua','x','manager',NULL,NULL,'Юлія Приймає')`);

    const { tasksRouter } = await import("./tasks.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();

    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
    const layers = (tasksRouter as unknown as { stack: Layer[] }).stack.filter((l) => l.route);
    const AUTH: Record<string, unknown> = {
      admin: { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null },
      lead: { userId: 3, role: "team_lead", roleKey: "team_lead", managerId: 30, teamId: 7 },
      exec: { userId: 4, role: "manager", roleKey: "manager", managerId: 40, teamId: 7 },
      other: { userId: 5, role: "manager", roleKey: "manager", managerId: 50, teamId: 9 },
      yulia: { userId: 6, role: "manager", roleKey: "manager", managerId: -1, teamId: null },
    };
    async function call(method: string, p: string, o: { who?: string; params?: Record<string, string>; body?: unknown } = {}) {
      const layer = layers.find((l) => l.route!.path === p && l.route!.methods[method.toLowerCase()]);
      assert.ok(layer, `🔴 роут не знайдено: ${method} ${p}`);
      const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle as
        (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void>;
      const req = { auth: AUTH[o.who ?? "admin"], params: o.params ?? {}, body: o.body ?? {}, query: {}, headers: {}, originalUrl: p };
      let code = 200;
      let payload: unknown;
      const res = {
        headersSent: false,
        status(x: number) { code = x; return res; },
        json(b: unknown) { payload = b; return res; },
        send(b: unknown) { payload = b; return res; },
        type() { return res; },
        setHeader() { /* не потрібно */ },
      };
      await handler(req, res, (e?: unknown) => { if (e) throw e; });
      return { code, payload: payload as Record<string, unknown> };
    }
    type Row = { id: number; status: string; reviewerId: number | null; reviewerName: string | null;
      statusRights: { canChange: boolean; canDone: boolean; canChangeReviewer: boolean } };
    const listOf = async (who: string) => ((await call("GET", "/", { who })).payload as unknown as { tasks: Row[] }).tasks;
    const patch = (who: string, id: number, body: unknown) => call("PATCH", "/:id", { who, params: { id: String(id) }, body });
    const statusOf = async (id: number) => (await c.query<{ status: string }>(`SELECT status FROM tasks WHERE id=$1`, [id])).rows[0].status;

    // ── 1. СТВОРЕННЯ: автор-адмін ставить задачу виконавцю, приймає Юлія ──
    const made = await call("POST", "/", { who: "admin", body: { title: "ТЗ Юлії", assigneeId: 40, reviewerId: 6 } });
    assert.equal(made.code, 201, `створення з «Приймає»: ${JSON.stringify(made.payload)}`);
    const id = (made.payload as unknown as { id: number }).id;
    const ghost = await call("POST", "/", { who: "admin", body: { title: "х", assigneeId: 40, reviewerId: 999 } });
    assert.equal(ghost.code, 400, "🔴 неіснуючий «Приймає» дав не 400 — далі FK і 500");

    // ── 2. ВИДАЧА: «Приймає» бачить задачу, імʼя — людське ──
    const yRow = (await listOf("yulia")).find((r) => r.id === id);
    assert.ok(yRow, "🔴 «Приймає» не бачить задачу у своєму списку — закрити її він не зможе");
    assert.equal(yRow!.reviewerName, "Юлія Приймає");

    // ── 3. ВИКОНАВЕЦЬ: рухає до «на затвердження», але не закриває ──
    assert.equal((await patch("exec", id, { status: "in_progress" })).code, 204);
    assert.equal((await patch("exec", id, { status: "ready_for_approval" })).code, 204,
      "🔴 виконавець не може поставити «Готово на затвердження»");
    const denied = await patch("exec", id, { status: "done" });
    assert.equal(denied.code, 403, `🔴 ВИКОНАВЕЦЬ ЗАКРИВ ЗАДАЧУ САМ (код ${denied.code})`);
    assert.match(String(denied.payload.error), /Юлія Приймає/, "🔴 відмова не називає, хто може закрити");
    assert.equal(await statusOf(id), "ready_for_approval", "🔴 після 403 статус у базі змінився");
    // Тімлід виконавця — як виконавець: рухає, не закриває.
    assert.equal((await patch("lead", id, { status: "done" })).code, 403, "🔴 тімлід закрив задачу замість «Приймає»");
    // Виконавець не призначає приймати себе.
    assert.equal((await patch("exec", id, { reviewerId: 4 })).code, 403,
      "🔴 виконавець переписав «Приймає» на себе — правило обходиться одним PATCH");

    // ── 4. СТОРОННЯ ЛЮДИНА: нічого ──
    assert.equal((await patch("other", id, { status: "in_progress" })).code, 403, "🔴 стороння людина змінила статус");

    // ── 5. «ПРИЙМАЄ»: не учасник за canTouchTask, але закриває й повертає ──
    assert.equal((await patch("yulia", id, { title: "перейменую" })).code, 403,
      "🔴 «Приймає» отримав право правити задачу цілком, а не лише статус");
    // 🪞 Власна папка — можна: група особиста й доступу не змінює.
    const yGroup = (await call("POST", "/groups", { who: "yulia", body: { name: "Прийняти" } })).payload as unknown as { id: number };
    assert.equal((await patch("yulia", id, { groupId: yGroup.id })).code, 204, "🔴 «Приймає» не може покласти задачу у власну папку");
    assert.equal((await patch("yulia", id, { status: "ball_on_executor" })).code, 204, "🔴 «Приймає» не може повернути в роботу");
    assert.equal((await patch("exec", id, { status: "ready_for_approval" })).code, 204);
    const closed = await patch("yulia", id, { status: "done" });
    assert.equal(closed.code, 204, `🔴 «ПРИЙМАЄ» НЕ МОЖЕ ЗАКРИТИ (код ${closed.code}): ${JSON.stringify(closed.payload)}`);
    assert.equal(await statusOf(id), "done");
    assert.equal((await call("POST", "/:id/comments", { who: "yulia", params: { id: String(id) }, body: { body: "Прийнято" } })).code, 201,
      "🔴 «Приймає» не може написати, чому повертає чи приймає");

    // Історія знає, ХТО прийняв, — знімком ролі.
    const hist = ((await call("GET", "/:id/history", { params: { id: String(id) } })).payload as unknown as
      { history: { toStatus: string; actorRole: string | null; changedByName: string }[] }).history;
    const accepted = hist.filter((h) => h.toStatus === "done");
    assert.deepEqual(accepted.map((h) => [h.actorRole, h.changedByName]), [["reviewer", "Юлія Приймає"]],
      "🔴 історія не відмічає, хто прийняв");
    assert.ok(hist.some((h) => h.actorRole === "executor"), "роль виконавця не записалась");

    // ── 6. АДМІН: усе ──
    assert.equal((await patch("admin", id, { status: "in_progress" })).code, 204);
    assert.equal((await patch("admin", id, { status: "done" })).code, 204, "🔴 адмін не може закрити");

    // ── 7. ВИДАЧА == PATCH: права з GET передбачають відповідь PATCH для КОЖНОГО глядача ──
    await c.query(`UPDATE tasks SET status='ready_for_approval' WHERE id=$1`, [id]);
    const mismatches: string[] = [];
    for (const who of ["admin", "lead", "exec", "other", "yulia"]) {
      const row = (await listOf(who)).find((r) => r.id === id);
      const promisedDone = row?.statusRights.canDone ?? false;
      await c.query(`UPDATE tasks SET status='ready_for_approval' WHERE id=$1`, [id]);
      const r = await patch(who, id, { status: "done" });
      if (promisedDone !== (r.code === 204)) mismatches.push(`${who}: меню обіцяє done=${promisedDone}, PATCH дав ${r.code}`);
    }
    assert.deepEqual(mismatches, [], "🔴 сірий пункт у меню і 403 розійшлись:\n  " + mismatches.join("\n  "));

    // ── 7b. ВИПАДОК 4172/4310/4312: автор = виконавець, приймає інша людина ──
    const own = (await call("POST", "/", { who: "exec", body: { title: "Роман за ТЗ Юлії", assigneeId: 40, reviewerId: 6 } })).payload as unknown as { id: number };
    assert.equal((await patch("exec", own.id, { status: "ready_for_approval" })).code, 204);
    assert.equal((await patch("exec", own.id, { status: "done" })).code, 403,
      "🔴 АВТОР-ВИКОНАВЕЦЬ ЗАКРИВ ЗАДАЧУ, ЯКУ ПРИЙМАЄ ЮЛІЯ — правило не діє там, заради чого писалось");
    assert.equal((await patch("exec", own.id, { reviewerId: 4 })).code, 403,
      "🔴 АВТОР-ВИКОНАВЕЦЬ ПЕРЕПИСАВ «ПРИЙМАЄ» НА СЕБЕ — правило обходиться одним PATCH");
    assert.equal((await patch("yulia", own.id, { status: "done" })).code, 204);

    // ── 8. ЗАМОВЧУВАННЯ: «Приймає» не обрано — приймає автор ──
    const plain = (await call("POST", "/", { who: "lead", body: { title: "Без приймаючого", assigneeId: 40 } })).payload as unknown as { id: number };
    const plainRow = (await listOf("lead")).find((r) => r.id === plain.id)!;
    assert.equal(plainRow.reviewerId, 3, "🔴 без «Приймає» видача не показала автора");
    assert.equal((await patch("exec", plain.id, { status: "done" })).code, 403);
    assert.equal((await patch("lead", plain.id, { status: "done" })).code, 204, "🔴 автор не може закрити задачу без «Приймає»");

    // ── 9. ПРАВИЛО НЕ РОЗПОВЗЛОСЬ: задача іншого типу і системна задача ──
    // ⚠️ Не `reactivation_client`: закрити його PATCH-ем не можна й без цього правила —
    // CHECK `tasks_reactivation_close_reason` вимагає причину, якої PATCH не несе.
    // Тип поза правилом тут — денна KPI-задача з автором (дитина плану тімліда).
    const kid = await c.query<{ id: number }>(
      `INSERT INTO tasks (title, status, assignee_id, created_by, task_type) VALUES ('День плану','not_started',40,1,'daily_kpi') RETURNING id`);
    assert.equal((await patch("exec", kid.rows[0].id, { status: "done" })).code, 204,
      "🔴 виконавець не може закрити задачу поза правилом (daily_kpi) — правило розповзлось на всі типи");
    const sys = await c.query<{ id: number }>(
      `INSERT INTO tasks (title, status, assignee_id, created_by, task_type) VALUES ('Пропущений дзвінок','not_started',40,NULL,'simple') RETURNING id`);
    assert.equal((await patch("exec", sys.rows[0].id, { status: "done" })).code, 204,
      "🔴 менеджер не може закрити системну задачу без автора");
    assert.equal((await patch("admin", kid.rows[0].id, { reviewerId: 6 })).code, 400,
      "🔴 «Приймає» призначено задачі не звичайного типу");

    const { pool } = await import("../db/pool.js");
    await pool.end();
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/** Код фронта без коментарів — гейт не має задовольнятись текстом у коментарі (урок `#400l`). */
function codeOf(...rel: string[]): string {
  return readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", ...rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * #1080g — ФРОНТ ДЗЕРКАЛИТЬ, А НЕ МОВЧИТЬ: меню над карткою, права з сервера, причина відмови.
 *
 * ① МЕНЮ НАД КАРТКОЮ. Заміряно на проді 30.09.2026: у бічній картці поповер статусу
 *   монтувався (`zIndex: 1000`) ПІД карткою (`zIndex: 2600`) — клік «нічого не робив».
 *   Порівнюємо ЧИСЛА з обох файлів, а не наявність рядка.
 * ② ОБИДВА МІСЦЯ (рядок і картка) передають у меню права з сервера й імʼя «Приймає».
 * ③ Сірий «Готово»: `disabled` за `canDone`.
 * ④ Тост відмови бере причину з ТІЛА відповіді (`response.data.error`), а не
 *   «Request failed with status code 403».
 *
 * 🧨 Червоніє, якщо повернути `STATUS_MENU_Z` нижче картки, прибрати `rights=` з
 * будь-якого з двох місць або повернути `err.message` як єдине джерело тексту.
 */
test("#1080g ФРОНТ: меню статусу вище за картку, права й «Приймає» в обох місцях, тост із причиною сервера", () => {
  const picker = codeOf("components", "StatusPicker.tsx");
  const section = codeOf("pages", "dashboard", "sections", "TasksSection.tsx");
  const dash = codeOf("pages", "Dashboard.tsx");

  // ① Числа, а не рядки.
  const menuZ = Number(picker.match(/export const STATUS_MENU_Z = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(menuZ), "🔴 не знайдено STATUS_MENU_Z — предмет гейта зник");
  assert.match(picker, /zIndex: STATUS_MENU_Z\b/, "🔴 поповер не використовує STATUS_MENU_Z");
  const cardZ = [...section.matchAll(/overflowY: "auto", padding: 24, zIndex: (\d+)/g)].map((m) => Number(m[1]));
  assert.equal(cardZ.length, 1, `🔴 не знайдено картки задачі (знайдено ${cardZ.length}) — предмет гейта зник`);
  assert.ok(menuZ > cardZ[0], `🔴 МЕНЮ СТАТУСУ (${menuZ}) ПІД КАРТКОЮ (${cardZ[0]}) — клік у картці знову «нічого не робить»`);

  // ② Обидва місця.
  const pickers = section.match(/<StatusPicker [^>]*>/g) ?? [];
  assert.equal(pickers.length, 2, `🔴 очікували два меню статусу (рядок і картка), знайдено ${pickers.length}`);
  for (const p of pickers) {
    assert.match(p, /rights=\{\w+\.statusRights\}/, `🔴 меню без прав із сервера: ${p.slice(0, 120)}`);
    assert.match(p, /reviewerName=\{\w+\.reviewerName\}/, `🔴 меню без імені «Приймає»: ${p.slice(0, 120)}`);
  }

  // ③ Сірий «Готово».
  assert.match(picker, /const off = s === "done" && !canDone/, "🔴 «Готово» не сіріє без права закривати");
  assert.match(picker, /disabled=\{off\}/, "🔴 сірий пункт лишився клікабельним");
  assert.match(picker, /disabled=\{!canChange\}/, "🔴 без прав на статус кнопка відкриває меню-пустушку");

  // ④ Причина з тіла відповіді.
  const commit = dash.slice(dash.indexOf("async function commitTask("), dash.indexOf("function patchTaskLocal("));
  assert.ok(commit.length > 0, "🔴 commitTask не знайдено");
  assert.match(commit, /const reason = serverReason\(err\)/, "🔴 commitTask не бере причину відмови з serverReason");
  const reasonFn = dash.slice(dash.indexOf("function serverReason("), dash.indexOf("function serverReason(") + 400);
  assert.match(reasonFn, /response\?\.data\?\.error/, "🔴 тост відмови не бере причину з відповіді сервера");
});

/**
 * #1080h — «ПРИЙМАЄ» ОТРИМУЄ СИГНАЛ, КОЛИ ЗАДАЧА ЧЕКАЄ ЙОГО ПРИЙНЯТТЯ (рішення Романа 30.09.2026).
 *
 * Функцію фронта транспілюємо й кличемо (прийом `missedCallsTab.test.ts`), фікстури — по
 * обидва боки кожної умови. Окремо: виклик справді стоїть в ефекті сповіщень `Dashboard.tsx`
 * — функція без виклику була б зеленою і німою.
 *
 * 🧨 Червоніє, якщо прибрати будь-яку з умов (перехід, «я — Приймає», «я не виконавець»,
 * лише звичайні задачі, мовчання на першому опитуванні) або сам виклик.
 */
test("#1080h СПОВІЩЕННЯ «ПРИЙМАЄ»: перехід на затвердження дзвонить тому, хто приймає, — і лише йому", async () => {
  const ts = (await import("typescript")).default;
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "acceptanceNotify.ts"), "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const N = await import(`data:text/javascript,${encodeURIComponent(js)}`) as {
    isAcceptanceAlert: (t: Record<string, unknown>, prev: string | undefined, me: { userId: number | null; managerId: number | null }) => boolean;
    acceptanceAlertText: (title: string, executor?: string | null) => string;
  };
  const YULIA = { userId: 6, managerId: null };
  const EXEC = { userId: 4, managerId: 40 };
  const task = { id: 1, title: "ТЗ Юлії", status: "ready_for_approval", taskType: "simple", reviewerId: 6, assigneeId: 40, assigneeUserId: null };

  assert.equal(N.isAcceptanceAlert(task, "in_progress", YULIA), true, "🔴 «ПРИЙМАЄ» НЕ ОТРИМАВ СИГНАЛУ про задачу на затвердженні");
  assert.equal(N.isAcceptanceAlert(task, "in_progress", EXEC), false, "🔴 сигнал отримав виконавець, а не «Приймає»");
  // Третя людина — ні виконавець, ні «Приймає» (саботаж S15 спершу лишав гейт зеленим без цього рядка).
  assert.equal(N.isAcceptanceAlert(task, "in_progress", { userId: 5, managerId: 50 }), false,
    "🔴 сигнал отримала стороння людина, яку ніхто не призначав приймати");
  assert.equal(N.isAcceptanceAlert({ ...task, reviewerId: 4, assigneeId: 40 }, "in_progress", EXEC), false,
    "🔴 людина, що сама себе приймає, отримала сигнал про власний клік");
  assert.equal(N.isAcceptanceAlert({ ...task, assigneeId: null, assigneeUserId: 6 }, "in_progress", YULIA), false,
    "🔴 виконавець-акаунт, що сам себе приймає, отримав сигнал");
  assert.equal(N.isAcceptanceAlert(task, undefined, YULIA), false, "🔴 перше завантаження дзвонить про все, що вже висить");
  assert.equal(N.isAcceptanceAlert(task, "ready_for_approval", YULIA), false, "🔴 дзвонить без переходу — на кожному опитуванні");
  assert.equal(N.isAcceptanceAlert({ ...task, status: "done" }, "ready_for_approval", YULIA), false, "🔴 дзвонить не на той статус");
  assert.equal(N.isAcceptanceAlert({ ...task, taskType: "daily_kpi" }, "in_progress", YULIA), false, "🔴 дзвонить про тип поза правилом");
  assert.match(N.acceptanceAlertText("ТЗ Юлії", "Роман"), /Чекає вашого прийняття — Роман: ТЗ Юлії/);

  const dash = codeOf("pages", "Dashboard.tsx");
  assert.match(dash, /if \(isAcceptanceAlert\(t, was, \{ userId: auth\?\.userId, managerId: auth\?\.managerId \}\)\)/,
    "🔴 функцію сповіщення «Приймає» НЕ ВИКЛИКАЮТЬ в ефекті сповіщень — вона зелена й німа");
});
