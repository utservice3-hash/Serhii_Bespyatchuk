import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { teamMemberVerdict, teamSecretVisible, type TeamActor, type TeamTarget } from "./teamVaultRules.js";

/**
 * 👥 ТІМЛІД І СЕЙФ СВОЄЇ КОМАНДИ (29.09.2026) — гейти `#981`–`#983`.
 * Номери з запасом над `#964` (найвищий у main на момент роботи) — борг 17: перед мержем перемірити.
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
const KEY = randomBytes(32);

/**
 * #981 — ПРАВИЛО «СВОЯ КОМАНДА» ПО ОБИДВА БОКИ МЕЖІ. Дозвіл: тімлід → активний менеджер своєї команди
 * за CRM. Відмова: сам тімлід, інша команда, інший тімлід чи адмін, звільнений, неактивний, актор не
 * тімлід, тімлід без команди, людини немає. Картки — ні, паролі — так.
 * 🧨 Червоніє, якщо прибрати будь-яку з перевірок або пустити картки.
 */
test("#981 ПРАВИЛО: тімлід бачить активних менеджерів лише своєї команди, без себе, адмінів, звільнених і карток", () => {
  const lead: TeamActor = { userId: 1, role: "team_lead", teamId: 15 };
  const mate: TeamTarget = { userId: 2, role: "manager", teamId: 15, active: true, dismissed: false };
  assert.deepEqual(teamMemberVerdict(lead, mate), { ok: true }, "🔴 свого менеджера не видно");
  const no = (t: TeamTarget | null, a: TeamActor = lead) => assert.equal(teamMemberVerdict(a, t).ok, false, `🔴 пропущено: ${JSON.stringify({ a, t })}`);
  no({ ...mate, userId: 1 });                         // сам
  no({ ...mate, teamId: 6 });                          // чужа команда
  no({ ...mate, teamId: null });                       // без команди
  no({ ...mate, role: "team_lead" });                  // інший тімлід
  no({ ...mate, role: "admin" });                      // адмін
  no({ ...mate, role: "kvp" });                        // керівництво
  no({ ...mate, active: false });                      // вхід вимкнено
  no({ ...mate, dismissed: true });                    // звільнений
  no(null);                                            // людини немає
  no(mate, { ...lead, role: "manager" });              // актор — не тімлід
  no(mate, { ...lead, role: "admin" });                // адмін через ці двері — ні (у нього повний сейф)
  no(mate, { ...lead, teamId: null });                 // тімлід без команди
  assert.equal(teamSecretVisible("password"), true, "🔴 паролі не видно");
  assert.equal(teamSecretVisible("card"), false, "🔴 картки видно тімліду");
});

/**
 * #981b — ЖИВИЙ SQL: список, картка, показ і скидання на справжній схемі.
 * Тімлід команди A бачить свого менеджера й не бачить: чужого, себе, звільненого. Картка людини — без
 * карток. Скидання: новий хеш підходить до пароля, пароль лежить у сейфі шифром, попередній — історією.
 * Показ свого пароля з кодом дає те саме значення; чужий пароль і картка — 403 ще до коду.
 * 🧨 Червоніє, якщо зняти межу команди в будь-яких дверях, не покласти пароль у сейф чи пустити картки.
 */
test("#981b ЖИВИЙ SQL: своя команда в списку, картці, показі й скиданні; чужі й картки — 403", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id, name) VALUES (9101, 'Команда A'), (9102, 'Команда B')`);
    const mgr = async (name: string, team: number) => (await c.query(
      `INSERT INTO managers (name, kommo_user_id, team_id, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
      [name, String(Math.floor(Math.random() * 1e9)), team])).rows[0].id as number;
    const user = async (email: string, role: string, team: number, managerId: number | null) => (await c.query(
      `INSERT INTO users (email, password_hash, role, team_id, manager_id, full_name) VALUES ($1, 'x', $2, $3, $4, $5) RETURNING id`,
      [email, role, team, managerId, email.split("@")[0]])).rows[0].id as number;
    const lead = await user("lead@uts.ua", "team_lead", 9101, await mgr("Тімлід А", 9101));
    const mateM = await mgr("Свій Менеджер", 9101);
    const mate = await user("mate@uts.ua", "manager", 9101, mateM);
    const foreign = await user("foreign@uts.ua", "manager", 9102, await mgr("Чужий Менеджер", 9102));
    const goneM = await mgr("Звільнений", 9101);
    const gone = await user("gone@uts.ua", "manager", 9101, goneM);
    await c.query(`INSERT INTO manager_work_state (manager_id, state) VALUES ($1, 'dismissed')`, [goneM]);
    await c.query(`UPDATE users SET vault_chat_id = 555, vault_linked_at = now() WHERE id = $1`, [lead]);

    const db = c as unknown as import("./secrets.js").Db;
    const sec = await import("./secrets.js");
    const tv = await import("./teamVault.js");
    const bcrypt = (await import("bcryptjs")).default;
    const sent: string[] = [];
    const send = async (_chat: string | number, text: string) => { sent.push(text); return true; };

    const kommo = await sec.createSecret(db, KEY, lead, mate, { kind: "password", service: "kommo", login: "mate", value: "Kommo-Mate-1" });
    const card = await sec.createSecret(db, KEY, lead, mate, { kind: "card", value: "4149 4990 1234 4521" });
    const foreignSecret = await sec.createSecret(db, KEY, lead, foreign, { kind: "password", service: "kommo", value: "Kommo-Foreign-1" });

    const list = await tv.listTeamPeople(db, lead);
    assert.deepEqual(list.rows.map((p) => p.userId), [mate], "🔴 у списку тімліда не рівно свій менеджер");
    assert.deepEqual([list.rows[0].passwords, list.rows[0].dashboardKnown], [1, false], "🔴 картка порахована паролем або дашборд «відомий» без запису");
    for (const who of [foreign, gone, lead]) await assert.rejects(tv.teamPersonVault(db, lead, who), (e: { status?: number }) => e.status === 403, `🔴 картку ${who} відкрито тімліду`);
    assert.deepEqual((await tv.teamPersonVault(db, lead, mate)).items.map((i) => i.id), [kommo], "🔴 картка людини показує не лише паролі");

    await assert.rejects(tv.assertTeamSecret(db, lead, card), (e: { status?: number }) => e.status === 403, "🔴 картку пущено до показу");
    await assert.rejects(tv.assertTeamSecret(db, lead, foreignSecret), (e: { status?: number }) => e.status === 403, "🔴 чужий пароль пущено до показу");
    await assert.rejects(tv.resetTeamPassword(db, KEY, lead, foreign), (e: { status?: number }) => e.status === 403, "🔴 тімлід скинув пароль чужій людині");

    const first = await tv.resetTeamPassword(db, KEY, lead, mate);
    const again = await tv.resetTeamPassword(db, KEY, lead, mate);
    const hash = (await c.query(`SELECT password_hash FROM users WHERE id = $1`, [mate])).rows[0].password_hash as string;
    assert.ok(await bcrypt.compare(again.password, hash), "🔴 новий пароль не підходить до входу");
    assert.ok(!(await bcrypt.compare(first.password, hash)), "🔴 попередній пароль досі підходить");
    const dash = (await c.query(`SELECT id, superseded_at FROM employee_secrets WHERE user_id = $1 AND service = 'dashboard' ORDER BY id`, [mate])).rows;
    assert.deepEqual(dash.map((r) => r.superseded_at != null), [true, false], "🔴 у сейфі не рівно: стара версія історією, нова поточною");
    const raw = JSON.stringify((await c.query(`SELECT * FROM employee_secrets`)).rows) + JSON.stringify((await c.query(`SELECT * FROM access_audit`)).rows);
    assert.ok(!raw.includes(again.password), "🔴 пароль лежить у базі чи аудиті текстом");
    assert.equal((await tv.listTeamPeople(db, lead)).rows[0].dashboardKnown, true, "🔴 після скидання пароль дашборда «невідомий»");

    await tv.assertTeamSecret(db, lead, dash[1].id);
    await sec.sendRevealCode(db, lead, dash[1].id, send);
    const shownCode = /(\d{6})/.exec(sent.at(-1)!)![1];
    const out = await sec.revealSecret(db, KEY, lead, dash[1].id, { code: shownCode });
    assert.equal(out.value, again.password, "🔴 показ дав не той пароль, що скинуто");
  } finally { await c.end(); s.dispose(); }
});

/**
 * #982 — МЕЖІ НА МІСЦІ: право `view_team_secrets` на РОУТЕРІ, видане лише team_lead; вкладка `hiring`;
 * у дверях показу й коду межа команди стоїть ПЕРЕД `sendRevealCode`/`revealSecret`.
 * 🧨 Червоніє, якщо зняти право з роутера, видати його ще комусь або переставити межу після показу.
 */
test("#982 МЕЖІ: право на роутері лише в team_lead, вкладка hiring, межа команди перед показом і кодом", async () => {
  const r = SRC("routes/teamVault.ts");
  assert.match(r, /teamVaultRouter\.use\(requireAuth, requirePerm\("view_team_secrets"\)\);/, "🔴 роутер без права");
  for (const [door, op] of [["/:id/code", "sendRevealCode"], ["/:id/reveal", "revealSecret"]]) {
    const body = r.slice(r.indexOf(`teamVaultRouter.post("${door}"`));
    const at = body.indexOf("assertTeamSecret("), use = body.indexOf(`${op}(`);
    assert.ok(at > 0 && use > 0 && at < use, `🔴 ${door}: межа команди не стоїть перед ${op}`);
  }
  assert.match(r, /resetTeamPassword\(d, key\(\), me\(req\), userId\)/, "🔴 скидання не через resetTeamPassword (у ньому межа)");
  const sql = SRC("db/schema.sql");
  assert.match(sql, /UPDATE roles SET permissions = permissions \|\| '\{"view_team_secrets": true\}'::jsonb\s*\n\s*WHERE key = 'team_lead';/, "🔴 право видано не лише тімліду");
  assert.match(sql, /UPDATE roles SET permissions = permissions - 'view_team_secrets'\s*\n\s*WHERE key <> 'team_lead';/, "🔴 зняття в решти ролей прибрано");
  const { PERMISSION_CATALOG } = await import("../auth/permGrant.js");
  assert.ok((PERMISSION_CATALOG as readonly string[]).includes("view_team_secrets"), "🔴 права немає в каталозі");
  assert.match(SRC("auth/routeTab.ts"), /\{ test: pre\("\/api\/team-vault"\), tabs: \["hiring"\] \}/, "🔴 двері без вкладки");
});

/**
 * #983 — СКИДАННЯ АДМІНОМ ТЕЖ КЛАДЕ ПАРОЛЬ У СЕЙФ. Інакше пароль, скинутий у Налаштуваннях, тімлід
 * не побачив би, і «невідомий» на екрані брехав би про людину, якій щойно видали пароль.
 * 🧨 Червоніє, якщо прибрати `storeDashboardPassword` із роуту скидання.
 */
test("#983 СКИДАННЯ В НАЛАШТУВАННЯХ: той самий пароль іде в сейф", () => {
  const r = SRC("routes/settings.ts");
  const body = r.slice(r.indexOf('settingsRouter.post("/users/:id/reset-password"'));
  const end = body.indexOf("\n});");
  const handler = body.slice(0, end);
  assert.match(handler, /\bstoreDashboardPassword\(client as unknown as SecretsDb, vaultKey, req\.auth!\.userId, id, password\)/, "🔴 пароль зі скидання не йде в сейф");
  assert.ok(handler.indexOf("resetPassword(id)") < handler.indexOf("storeDashboardPassword("), "🔴 у сейф кладеться до скидання");
});
