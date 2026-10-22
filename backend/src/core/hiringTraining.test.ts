import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CANDIDATE_ACCESS, accessDeadline, accessToClose, trainingDay, trainingHealth, promoteVerdict, canDecideTraining,
  inviteState, newInviteToken, hashInviteToken, looksLikeInviteToken, candidateLogin, passwordProblem, kyivMidnightAfter,
} from "./hiringTrainingRules.js";

/**
 * 🎓 НАЙМ, ПРОХІД 2a (17.09.2026) — гейти `#530`–`#537`: акаунт кандидата, запрошення, строк доступу,
 * «застряг», переведення в менеджери, питання тімліду.
 * Номери з запасом над `#527` (найвищий у гілках найму) — борг 17: перед мержем перемірити перетин.
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
const H = 3_600_000;
const at = (s: string) => new Date(s);

/**
 * #530 — СТРОК ДОСТУПУ ПО ОБИДВА БОКИ МЕЖІ. Без входу: рівно 48 год від створення (хвилина до — відкрито,
 * хвилина після — закрити). Після входу: три КИЇВСЬКІ дні, рахуючи день входу — вхід о 23:30 і о 00:10
 * наступного дня дають різні межі, а не «72 год від входу». Продовження додає рівно добу.
 * 🧨 Червоніє, якщо рахувати 72 год від входу, забути продовження або брати UTC-день замість київського.
 */
test("#530 СТРОК: 48 год без входу, три київські дні від першого входу, продовження — рівно доба", () => {
  const created = at("2026-09-15T09:00:00Z");
  const base = { accountCreatedAt: created, firstLoginAt: null, extendedDays: 0, closedAt: null };
  assert.equal(accessToClose({ ...base, now: new Date(created.getTime() + 48 * H - 60_000) }), null, "🔴 закрито раніше 48 год");
  assert.equal(accessToClose({ ...base, now: new Date(created.getTime() + 48 * H + 60_000) }), "no_login", "🔴 без входу доступ не закрився");
  assert.equal(accessToClose({ ...base, extendedDays: 1, now: new Date(created.getTime() + 48 * H + 60_000) }), null, "🔴 продовження не подіяло");
  assert.equal(accessDeadline({ ...base, extendedDays: 1 }).getTime() - accessDeadline(base).getTime(), 24 * H);

  // 23:30 Києва 15.09 (= 20:30Z) → межа — північ 18.09 Києва (= 17.09 21:00Z)
  const late = { ...base, firstLoginAt: at("2026-09-15T20:30:00Z") };
  assert.equal(accessDeadline(late).toISOString(), "2026-09-17T21:00:00.000Z", "🔴 три дні рахуються не київськими днями від дня входу");
  // 00:10 Києва 16.09 (= 15.09 21:10Z) — уже наступний київський день, хоч UTC-дата та сама
  const early = { ...base, firstLoginAt: at("2026-09-15T21:10:00Z") };
  assert.equal(accessDeadline(early).toISOString(), "2026-09-18T21:00:00.000Z", "🔴 день входу взято за UTC, а не за Києвом");
  assert.equal(accessToClose({ ...late, now: at("2026-09-17T20:59:00Z") }), null);
  assert.equal(accessToClose({ ...late, now: at("2026-09-17T21:01:00Z") }), "expired", "🔴 після трьох днів доступ не закрився");
  assert.equal(accessToClose({ ...late, closedAt: at("2026-09-16T00:00:00Z"), now: at("2026-09-20T00:00:00Z") }), null, "🔴 джоба закриває вже закритий доступ");
  // перехід на зимовий час 25.10.2026: північ 26.10 Києва — це 25.10 22:00Z (UTC+2), а не 21:00Z
  assert.equal(kyivMidnightAfter(at("2026-10-24T10:00:00Z"), 2).toISOString(), "2026-10-25T22:00:00.000Z", "🔴 перехід часу зсунув межу дня");

  assert.equal(trainingDay({ firstLoginAt: null, extendedDays: 0, now: at("2026-09-16T10:00:00Z") }), 0);
  assert.equal(trainingDay({ firstLoginAt: late.firstLoginAt, extendedDays: 0, now: at("2026-09-15T20:40:00Z") }), 1);
  assert.equal(trainingDay({ firstLoginAt: late.firstLoginAt, extendedDays: 0, now: at("2026-09-16T08:00:00Z") }), 2, "🔴 другий київський день рахується як перший");
  assert.equal(trainingDay({ firstLoginAt: late.firstLoginAt, extendedDays: 0, now: at("2026-09-17T12:00:00Z") }), 3);
});

/**
 * #531 — «ЗАСТРЯГ» І РІШЕННЯ. 23 год без руху — ще ні, 24 — так; пройдений курс не «застрягає».
 * «Менеджер» — лише зі статусу «на навчанні» і лише коли пройдено ВСЕ; порожній курс (0 із 0) — не «все».
 * Рішення — тімлід або адмін-рівень, рекрутер (HR) — ні (макет).
 * 🧨 Червоніє, якщо зсунути поріг, дозволити «менеджера» з недопройденим або порожнім курсом, чи дати рішення HR.
 */
test("#531 ЗАСТРЯГ І РІШЕННЯ: доба без руху, «менеджер» лише після всіх кроків, рішення — тімлід", () => {
  const now = at("2026-09-16T12:00:00Z"), first = at("2026-09-15T08:00:00Z");
  const h = (hours: number, done = 3, total = 12) =>
    trainingHealth({ closedReason: null, firstLoginAt: first, lastActivityAt: new Date(now.getTime() - hours * H), done, total, now });
  assert.equal(CANDIDATE_ACCESS.stuckHours, 24);
  assert.equal(h(23), "ok", "🔴 застряг раніше доби");
  assert.equal(h(24), "stuck", "🔴 доба без руху не підсвічена");
  assert.equal(h(40, 12, 12), "done", "🔴 пройдений курс позначено «застряг»");
  assert.equal(trainingHealth({ closedReason: null, firstLoginAt: null, lastActivityAt: null, done: 0, total: 12, now }), "no_login");
  assert.equal(trainingHealth({ closedReason: "expired", firstLoginAt: first, lastActivityAt: null, done: 0, total: 12, now }), "closed");

  assert.equal(promoteVerdict({ status: "training", closedReason: null, done: 12, total: 12 }).ok, true);
  assert.equal(promoteVerdict({ status: "training", closedReason: null, done: 11, total: 12 }).ok, false, "🔴 менеджер з недопройденим навчанням");
  assert.equal(promoteVerdict({ status: "training", closedReason: null, done: 0, total: 0 }).ok, false, "🔴 порожній курс зараховано як пройдений");
  assert.equal(promoteVerdict({ status: "candidate", closedReason: null, done: 12, total: 12 }).ok, false);
  assert.equal(promoteVerdict({ status: "training", closedReason: "expired", done: 12, total: 12 }).ok, false);

  assert.equal(canDecideTraining({ roleKey: "team_lead", adminScope: false }), true);
  assert.equal(canDecideTraining({ roleKey: "opdir", adminScope: true }), true);
  assert.equal(canDecideTraining({ roleKey: "hr", adminScope: false }), false, "🔴 рекрутер вирішує замість тімліда");
});

/**
 * #532 — ЗАПРОШЕННЯ. Стан по обидва боки строку; використане й замінене — не чинні. У базу йде ХЕШ,
 * а не токен; токен — 256 біт у base64url. Логін — пошта кандидата, якщо вільна, інакше службова адреса.
 * 🧨 Червоніє, якщо зберігати токен як є, продовжити строк чи пустити повторно.
 */
test("#532 ЗАПРОШЕННЯ: 72 год, одноразове, у базі хеш; логін — вільна пошта або службова адреса", () => {
  const exp = at("2026-09-18T09:00:00Z");
  const st = (now: string, used: string | null = null, revoked: string | null = null) =>
    inviteState({ expiresAt: exp, usedAt: used ? at(used) : null, revokedAt: revoked ? at(revoked) : null, now: at(now) });
  assert.equal(CANDIDATE_ACCESS.inviteHours, 72);
  assert.equal(st("2026-09-18T08:59:00Z"), "valid");
  assert.equal(st("2026-09-18T09:00:00Z"), "expired", "🔴 прострочене посилання чинне");
  assert.equal(st("2026-09-16T00:00:00Z", "2026-09-15T12:00:00Z"), "used", "🔴 використане посилання чинне");
  assert.equal(st("2026-09-16T00:00:00Z", null, "2026-09-15T12:00:00Z"), "revoked");

  const tok = newInviteToken();
  assert.ok(looksLikeInviteToken(tok), "🔴 токен не 256 біт у base64url");
  assert.notEqual(newInviteToken(), tok, "🔴 токен не випадковий");
  assert.match(hashInviteToken(tok), /^[0-9a-f]{64}$/);
  assert.ok(!hashInviteToken(tok).includes(tok), "🔴 у базу йде токен замість хешу");
  assert.equal(looksLikeInviteToken("../etc/passwd"), false);

  assert.equal(candidateLogin({ email: " Yana@Gmail.com ", candidateId: 7, emailTaken: false }), "yana@gmail.com");
  assert.equal(candidateLogin({ email: "yana@gmail.com", candidateId: 7, emailTaken: true }), "candidate-7@hiring.uts.local", "🔴 зайнята пошта стала логіном");
  assert.equal(candidateLogin({ email: null, candidateId: 7, emailTaken: false }), "candidate-7@hiring.uts.local");
  assert.ok(passwordProblem("1234567"), "🔴 короткий пароль прийнято");
  assert.ok(passwordProblem("abcdefgh"), "🔴 пароль без цифр прийнято");
  assert.equal(passwordProblem("uts2026yana"), null);
});

/** Спільна фікстура: схема з нуля, дві команди, клієнт напряму (не пул). */
async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК · Дмитрук'),(2,'РНК · Безпамʼятний') ON CONFLICT DO NOTHING");
  return { c, db: c as unknown as import("./hiring.js").Db, done: async () => { await c.end(); scratch.dispose(); } };
}

/** Кандидат, доведений до «кандидат + команда» тімлідом команди 1 — рівно шлях макета.
 *  Без пошти акаунт не створюється (#1620), тож фікстура без явної пошти бере `c<телефон>@gmail.com`. */
async function toCandidate(db: import("./hiring.js").Db, name: string, phone: string, email: string | null = null) {
  const h = await import("./hiring.js");
  const vac = await h.createVacancy(db, null, { title: `Сейлз ${phone}` });
  const id = await h.createCandidate(db, null, { fullName: name, phone, email: email ?? `c${phone}@gmail.com`, vacancyId: vac });
  for (const to of ["planned", "done"]) await h.changeStatus(db, null, id, { to, comment: "так" }, "edit", null);
  await h.changeStatus(db, null, id, { to: "lead", comment: "до тімліда", teamId: 1 }, "edit", null);
  await h.changeStatus(db, null, id, { to: "candidate", comment: "беремо" }, "lead", 1);
  return id;
}
const code = (s: number) => (e: { status?: number }) => e.status === s;

/**
 * #533 — ЖИВИЙ SQL ЦИКЛУ АКАУНТА. «Кандидат + команда» створює акаунт із роллю «Кандидат» тією ж
 * транзакцією; запрошення віддає токен один раз, у базі — хеш; нове гасить старе; пароль ставиться
 * один раз; перший вхід → «на навчанні»; джоба закриває прострочене й вимикає акаунт; продовжити
 * закрите не можна, «Відновити» — можна; відмова закриває доступ; тімлід чужої команди не бачить.
 * 🧨 Червоніє, якщо акаунт не створюється, токен лягає в базу як є, запрошення працює двічі,
 * джоба не вимикає акаунт або відмова лишає доступ відкритим.
 */
test("#533 ЖИВИЙ SQL: акаунт при «кандидат + команда», запрошення, перший вхід, джоба, відновлення, відмова", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  const tr = await import("./hiringTraining.js");
  const bcrypt = (await import("bcryptjs")).default;
  try {
    const id = await toCandidate(s.db, "Білик Яна", "0970000201", "yana.bilyk@gmail.com");
    const acc = (await s.c.query(`SELECT c.user_id, u.email, u.role_override, u.is_active, u.team_id
      FROM hiring_candidates c JOIN users u ON u.id = c.user_id WHERE c.id = $1`, [id])).rows[0];
    assert.ok(acc, "🔴 статус «кандидат + команда» не створив акаунт");
    assert.deepEqual([acc.email, acc.role_override, acc.is_active, acc.team_id], ["yana.bilyk@gmail.com", "candidate", true, 1], "🔴 акаунт не з роллю «Кандидат» чи не в команді");

    const inv1 = await tr.issueInvite(s.db, null, id, "lead", 1);
    const inv2 = await tr.issueInvite(s.db, null, id, "edit", null);
    const stored = (await s.c.query("SELECT token_hash FROM hiring_invites ORDER BY id")).rows.map((r) => r.token_hash as string);
    assert.ok(!stored.includes(inv1.token) && !stored.includes(inv2.token), "🔴 токен запрошення лежить у базі як є");
    await assert.rejects(tr.readInvite(s.db, inv1.token), code(410), "🔴 старе запрошення чинне після нового");
    assert.equal((await tr.readInvite(s.db, inv2.token)).login, "yana.bilyk@gmail.com");
    await assert.rejects(tr.acceptInvite(s.db, inv2.token, "коротко"), code(400));
    const uid = await tr.acceptInvite(s.db, inv2.token, "uts2026yana");
    const hash = (await s.c.query("SELECT password_hash FROM users WHERE id=$1", [uid])).rows[0].password_hash;
    assert.ok(await bcrypt.compare("uts2026yana", hash), "🔴 пароль за запрошенням не встановився");
    await assert.rejects(tr.acceptInvite(s.db, inv2.token, "inshyi2026pass"), code(410), "🔴 запрошення спрацювало двічі");

    await tr.noteCandidateLogin(s.db, uid);
    await tr.noteCandidateLogin(s.db, uid); // повторний вхід нічого не додає
    const started = (await s.c.query("SELECT status, first_login_at IS NOT NULL AS f FROM hiring_candidates WHERE id=$1", [id])).rows[0];
    assert.deepEqual([started.status, started.f], ["training", true], "🔴 перший вхід не запустив навчання");
    assert.equal((await s.c.query("SELECT count(*)::int n FROM hiring_events WHERE candidate_id=$1 AND to_status='training'", [id])).rows[0].n, 1, "🔴 повторний вхід задублював старт навчання");

    const board = await tr.trainingBoard(s.db, "lead", 1);
    assert.deepEqual(board.map((r) => [r.id, r.health]), [[id, "ok"]]);
    assert.deepEqual(await tr.trainingBoard(s.db, "lead", 2), [], "🔴 тімлід чужої команди бачить кандидата на навчанні");

    assert.deepEqual(await tr.closeExpiredAccess(s.db, new Date()), { checked: 1, closed: 0 }, "🔴 джоба закрила доступ до строку");
    assert.deepEqual(await tr.closeExpiredAccess(s.db, new Date(Date.now() + 5 * 24 * H)), { checked: 1, closed: 1 });
    const closed = (await s.c.query(`SELECT c.access_closed_reason, u.is_active FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([closed.access_closed_reason, closed.is_active], ["expired", false], "🔴 джоба не вимкнула акаунт");
    await assert.rejects(tr.extendAccess(s.db, null, id, "lead", 1), code(409), "🔴 продовжено вже закритий доступ");
    await assert.rejects(tr.issueInvite(s.db, null, id, "edit", null), code(409), "🔴 запрошення на закритий доступ");

    await tr.restoreAccess(s.db, null, id);
    const back = (await s.c.query(`SELECT c.access_closed_at, u.is_active FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([back.access_closed_at, back.is_active], [null, true], "🔴 «Відновити доступ» не відкрив акаунт");
    assert.deepEqual(await tr.closeExpiredAccess(s.db, new Date()), { checked: 1, closed: 0 }, "🔴 відновлений доступ одразу закрився знову");

    const reason = (await s.c.query("SELECT id FROM hiring_refusal_reasons WHERE side='company' ORDER BY id LIMIT 1")).rows[0].id;
    await h.refuseCandidate(s.db, null, id, { reasonId: reason, note: "не впорався" }, "lead", 1);
    const refused = (await s.c.query(`SELECT c.access_closed_reason, u.is_active FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([refused.access_closed_reason, refused.is_active], ["refused", false], "🔴 відмова лишила доступ до навчання відкритим");
  } finally { await s.done(); }
});

/**
 * #2231 — ЖИВИЙ SQL: «МЕНЕДЖЕР» ПІСЛЯ ВСІХ КРОКІВ — РОЛЬ ІЗ KOMMO, А НЕ ВРУЧНУ (замінив `#534`, 21.10.2026).
 * «Менеджер» — лише тімлідом і лише після всіх кроків; загальна зміна статусу в «менеджер» для картки з акаунтом —
 * ні. Kommo вже привʼязано до акаунта (HR вписала робочу пошту, синк узяв цей акаунт) — переведення знімає ручну
 * роль «Кандидат»: діє роль із Kommo, акаунт активний, картка в «Співробітниках» отримує Kommo. Ручна «Менеджер»
 * НЕ ставиться (вона перекрила б підвищення в Kommo до тімліда). Повернення останньої зміни повертає «Кандидат».
 * HR рішення не приймає. Питання ставить лише кандидат, бачить лише свої; відповідає тімлід своєї команди, один раз.
 * 🧨 Червоніє, якщо перевести з недопройденим курсом, лишити «Кандидат» при привʼязаному Kommo, поставити ручну
 * «Менеджер», не дати картці Kommo, пропустити загальний перехід або показати кандидату чужі питання.
 */
test("#2231 ЖИВИЙ SQL: «менеджер» після всіх кроків — роль із Kommo, картка з Kommo, скасовується; питання тімліду", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  const tr = await import("./hiringTraining.js");
  try {
    const course = (await s.c.query("INSERT INTO training_courses (title, audience, published) VALUES ('Старт кандидата','candidate',true) RETURNING id")).rows[0].id;
    await s.c.query("UPDATE training_courses SET published = false WHERE id <> $1", [course]); // лише курс кандидата
    const mod = (await s.c.query("INSERT INTO training_folders (name, course_id) VALUES ('День 1', $1) RETURNING id", [course])).rows[0].id;
    const [m1, m2] = (await s.c.query("INSERT INTO training_materials (folder_id, title, kind, position) VALUES ($1,'Продукт UTS','text',1),($1,'Скрипт першого дзвінка','text',2) RETURNING id", [mod])).rows.map((r) => r.id as number);

    const id = await toCandidate(s.db, "Гнатюк Анастасія", "0980000202");
    const uid = (await s.c.query("SELECT user_id FROM hiring_candidates WHERE id=$1", [id])).rows[0].user_id as number;
    assert.equal((await s.c.query("SELECT email FROM users WHERE id=$1", [uid])).rows[0].email, "c0980000202@gmail.com", "🔴 логін не пошта з картки");
    await tr.noteCandidateLogin(s.db, uid);
    await s.c.query("INSERT INTO training_progress (user_id, material_id, status, finished_at) VALUES ($1,$2,'done',now())", [uid, m1]);

    const row = (await tr.trainingBoard(s.db, "edit", null))[0];
    assert.deepEqual([row.done, row.total, row.percent, row.current_step], [1, 2, 50, "Скрипт першого дзвінка"], "🔴 прогрес на дошці не збігається з кроками навчання");
    await assert.rejects(tr.promoteCandidate(s.db, null, id, "готова", true, "lead", 1), code(409), "🔴 менеджер з недопройденим навчанням");
    await s.c.query("INSERT INTO training_progress (user_id, material_id, status, finished_at) VALUES ($1,$2,'done',now())", [uid, m2]);
    await assert.rejects(tr.promoteCandidate(s.db, null, id, "готова", false, "edit", null), code(403), "🔴 рекрутер вирішив замість тімліда");
    await assert.rejects(h.changeStatus(s.db, null, id, { to: "manager", comment: "в обхід" }, "lead", 1), code(409), "🔴 «менеджер» загальним переходом при акаунті навчання");

    // Kommo вже привʼязано до ЦЬОГО акаунта — так робить синк, коли пошта кандидата = пошта в Kommo (#2232).
    await s.c.query("INSERT INTO managers (id,name,team_id,is_active,kommo_user_id,email) VALUES (5301,'Гнатюк Анастасія',1,true,5301,'c0980000202@gmail.com')");
    await s.c.query("UPDATE users SET role='manager', manager_id=5301 WHERE id=$1", [uid]);
    assert.equal((await tr.trainingBoard(s.db, "edit", null)).find((x) => x.id === id)?.kommo_name, "Гнатюк Анастасія", "🔴 дошка не показує, що Kommo привʼязано");
    await tr.promoteCandidate(s.db, null, id, "готова до роботи", true, "lead", 1);
    const mgr = (await s.c.query(`SELECT c.status, u.role_override, COALESCE(u.role_override, u.role) AS eff, u.is_active FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([mgr.status, mgr.role_override, mgr.eff, mgr.is_active], ["manager", null, "manager", true], "🔴 переведення не зняло «Кандидат» або поставило ручну роль замість ролі з Kommo");
    const card = (await s.c.query("SELECT user_id, manager_id FROM employees WHERE candidate_id=$1", [id])).rows[0];
    assert.deepEqual([card?.user_id, card?.manager_id], [uid, 5301], "🔴 картка в «Співробітниках» не на цьому акаунті або без Kommo");
    assert.deepEqual(await tr.closeExpiredAccess(s.db, new Date(Date.now() + 30 * 24 * H)), { checked: 0, closed: 0 }, "🔴 джоба чіпає менеджера");

    await h.changeStatus(s.db, null, id, { to: "training", comment: "помилковий клік" }, "lead", 1);
    const undo = (await s.c.query(`SELECT c.status, u.role_override FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([undo.status, undo.role_override], ["training", "candidate"], "🔴 скасування «менеджера» не повернуло роль «Кандидат»");

    // питання
    const other = await toCandidate(s.db, "Кушнір Олеся", "0930000203");
    const otherUid = (await s.c.query("SELECT user_id FROM hiring_candidates WHERE id=$1", [other])).rows[0].user_id as number;
    const stranger = (await s.c.query("INSERT INTO users (email, password_hash, role) VALUES ('m@uts.ua','x','manager') RETURNING id")).rows[0].id;
    await assert.rejects(tr.askQuestion(s.db, stranger, { question: "а я?" }), code(403), "🔴 питання тімліду поставив не кандидат");
    const q = await tr.askQuestion(s.db, uid, { question: "Скільки знижки можна дати?", materialId: m2 });
    await tr.askQuestion(s.db, otherUid, { question: "Чуже питання" });
    assert.deepEqual((await tr.myQuestions(s.db, uid)).map((r) => r.id), [q], "🔴 кандидат бачить чужі питання");
    await assert.rejects(tr.answerQuestion(s.db, null, id, q, "до 3%", true, "lead", 2), code(404), "🔴 відповів тімлід чужої команди");
    await assert.rejects(tr.answerQuestion(s.db, null, id, q, "до 3%", false, "edit", null), code(403), "🔴 відповів не тімлід");
    await tr.answerQuestion(s.db, null, id, q, "До 3%, більше — через мене", true, "lead", 1);
    await assert.rejects(tr.answerQuestion(s.db, null, id, q, "ще раз", true, "lead", 1), code(409));
    assert.equal((await tr.myQuestions(s.db, uid))[0].answer, "До 3%, більше — через мене");
  } finally { await s.done(); }
});

/**
 * #538 — ЛОГІН І ПАРОЛЬ ВИДАЮТЬСЯ ОДИН РАЗ І НІДЕ НЕ ЛИШАЮТЬСЯ (рішення власника 18.09.2026).
 * Пароль приходить у відповіді, у базі — лише bcrypt-хеш; в історії кандидата його немає ні
 * в якому вигляді. Друга видача дає ІНШИЙ пароль (старий перестає працювати) і гасить
 * невикористане запрошення — двох живих шляхів входу не буває. Закритий доступ входу не видає.
 * 🧨 Червоніє, якщо покласти пароль у подію, лишити старий пароль робочим, лишити запрошення
 * чинним поруч із паролем або видати вхід при закритому доступі.
 */
test("#538 ВХІД: пароль один раз, у базі хеш, в історії його немає; друга видача — новий", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const tr = await import("./hiringTraining.js");
  const h = await import("./hiring.js");
  const bcrypt = (await import("bcryptjs")).default;
  try {
    const id = await toCandidate(s.db, "Мазур Іванна", "0500000204", "ivanna.mazur@gmail.com");
    const inv = await tr.issueInvite(s.db, null, id, "edit", null);
    const first = await tr.issueCandidatePassword(s.db, null, id, "edit", null);
    assert.equal(first.login, "ivanna.mazur@gmail.com");
    assert.ok(first.password.length >= 8, "🔴 пароль закороткий");
    const row = (await s.c.query(`SELECT u.password_hash, u.is_active FROM hiring_candidates c JOIN users u ON u.id = c.user_id WHERE c.id = $1`, [id])).rows[0];
    assert.notEqual(row.password_hash, first.password, "🔴 пароль лежить у базі як є");
    assert.ok(await bcrypt.compare(first.password, row.password_hash), "🔴 виданим паролем не увійти");

    const hist = (await s.c.query(`SELECT comment FROM hiring_events WHERE candidate_id = $1`, [id])).rows.map((r) => String(r.comment));
    assert.ok(hist.some((x) => x.includes("видано логін і пароль")), "🔴 видачі немає в історії");
    assert.ok(!hist.some((x) => x.includes(first.password)), "🔴 пароль потрапив в історію кандидата");

    await assert.rejects(tr.readInvite(s.db, inv.token), code(410), "🔴 запрошення лишилось чинним поруч із паролем");

    const second = await tr.issueCandidatePassword(s.db, null, id, "edit", null);
    assert.notEqual(second.password, first.password, "🔴 друга видача повернула той самий пароль");
    const row2 = (await s.c.query(`SELECT u.password_hash FROM hiring_candidates c JOIN users u ON u.id = c.user_id WHERE c.id = $1`, [id])).rows[0];
    assert.equal(await bcrypt.compare(first.password, row2.password_hash), false, "🔴 старий пароль лишився робочим");

    // 🔴 Доступ закриваємо СТРОКОМ, а статус лишається «кандидат + команда». Спершу тут стояла
    // відмова — і гейт був зеленим навіть без перевірки доступу, бо вхід відсікала перевірка
    // статусу. Спіймано саботажем.
    assert.deepEqual(await tr.closeExpiredAccess(s.db, new Date(Date.now() + 5 * 24 * H)), { checked: 1, closed: 1 });
    assert.equal((await s.c.query("SELECT status FROM hiring_candidates WHERE id=$1", [id])).rows[0].status, "candidate");
    await assert.rejects(tr.issueCandidatePassword(s.db, null, id, "edit", null), code(409), "🔴 вхід видано при закритому доступі");
    void h;
  } finally { await s.done(); }
});

/** #535 — ХЕШІ ЗАПРОШЕНЬ І ПИТАННЯ КАНДИДАТА ЗАКРИТІ ВІД МОДЕЛІ: REVOKE після GRANT і CREATE + FORBIDDEN_TABLES. */
test("#535 НАЙМ: hiring_invites і hiring_training_questions відібрані в ai_readonly і є в FORBIDDEN_TABLES", () => {
  const sql = SRC("db/schema.sql");
  const grantAt = sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;");
  const list = /FORBIDDEN_TABLES\s*=\s*\[([\s\S]*?)\]/.exec(SRC("ai/metricTools.ts"));
  for (const table of ["hiring_invites", "hiring_training_questions"]) {
    const createAt = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    assert.ok(grantAt > 0 && createAt > 0, `🔴 не знайдено GRANT або CREATE ${table}`);
    const ok = [...sql.matchAll(/REVOKE ALL ON ([^;]*?) FROM ai_readonly;/g)]
      .some((m) => new RegExp(`\\b${table}\\b`).test(m[1]) && m.index! > grantAt && m.index! > createAt);
    assert.ok(ok, `🔴 ${table} не відібрана в ai_readonly після GRANT і CREATE`);
    assert.ok(list && list[1].includes(`"${table}"`), `🔴 ${table} не в FORBIDDEN_TABLES`);
  }
});

/**
 * #536 — ЗАКРИТИЙ ДОСТУП ДІЄ НА ЖИВИЙ ТОКЕН, А ЗАПРОШЕННЯ — ЄДИНИЙ ПУБЛІЧНИЙ ВХІД.
 * Токен живе 12 год, тож без перевірки в `requireAuth` кандидат вчився б після закриття ще пів доби.
 * Перевірка — лише для ролі «Кандидат» і стоїть ДО пропуску далі. Роути запрошення — без `requireAuth`
 * і записані в реєстр публічних винятків; вхід видають тією самою функцією, що й логін.
 * 🧨 Червоніє, якщо прибрати перевірку, поставити її після `next()` або завести другу копію складу токена.
 */
test("#536 ДОСТУП: вимкнений кандидат відсікається на живому токені; запрошення публічне й видає той самий вхід", async () => {
  const mw = SRC("auth/middleware.ts");
  const fnStart = mw.indexOf("export function requireAuth(");
  const fnEnd = mw.indexOf("\n}\n", fnStart);
  const body = mw.slice(fnStart, fnEnd);
  const branch = body.indexOf('if (req.auth.roleKey === "candidate")');
  assert.ok(branch > 0, "🔴 requireAuth не перевіряє закритий доступ кандидата");
  const lastNext = body.lastIndexOf("next();");
  assert.ok(branch < lastNext, "🔴 перевірка кандидата стоїть після пропуску далі");
  const seg = body.slice(branch, lastNext);
  assert.match(seg, /SELECT is_active FROM users WHERE id = \$1/, "🔴 гілка кандидата не читає is_active");
  assert.match(seg, /return;\s*\}\s*$/, "🔴 гілка кандидата не зупиняє обробку до відповіді БД");

  const auth = SRC("routes/auth.ts");
  for (const m of ["get", "post"])
    assert.match(auth, new RegExp(`authRouter\\.${m}\\("/invite/:token", async \\(req, res\\)`), `🔴 ${m.toUpperCase()} /invite/:token відсутній або з requireAuth`);
  assert.equal((auth.match(/signToken\(\{/g) ?? []).length, 1, "🔴 друга копія складу токена входу");
  assert.match(auth, /res\.json\(\{ token: await issueLoginToken\(u, /, "🔴 запрошення видає вхід не спільною функцією");
  const { ROUTE_BOUNDARY_EXEMPTIONS } = await import("../auth/gates.js");
  for (const method of ["GET", "POST"])
    assert.ok(ROUTE_BOUNDARY_EXEMPTIONS.some((e) => e.method === method && e.path === "/api/auth/invite/:token" && e.permanent),
      `🔴 ${method} /api/auth/invite/:token не записано в публічні винятки`);
});

/**
 * #537 — ДЖОБА ЗАКРИТТЯ ДОСТУПУ ПІД НАГЛЯДОМ, ЧАСТОТА == КРОНУ, Є СТАРТОВИЙ ПРОГІН.
 * Хвилини крону беремо в самої бібліотеки (як `#458`), а не з тексту.
 * 🧨 Червоніє, якщо прибрати джобу з крону, з нагляду або розвести частоти.
 */
test("#537 ДЖОБА: hiringAccess у кроні, під наглядом із частотою крону і в стартових прогонах", async () => {
  const src = SRC("index.ts");
  const call = src.indexOf('runJob("hiringAccess", () => closeExpiredCandidateAccess())');
  assert.ok(call > 0, "🔴 джоба закриття доступу не запускається з крону");
  const spec = [...src.slice(0, call).matchAll(/cron\.schedule\("([^"]+)"/g)].pop()?.[1];
  assert.ok(spec && src.indexOf("});", src.lastIndexOf(`cron.schedule("${spec}"`, call)) > call, "🔴 не знайдено крон джоби");
  const { createRequire } = await import("node:module");
  const TimeMatcher = createRequire(import.meta.url)("node-cron/src/time-matcher.js") as new (p: string) => { match(d: Date): boolean };
  const tm = new TimeMatcher(`0 ${spec}`);
  const minutes = Array.from({ length: 60 }, (_, i) => i).filter((i) => tm.match(new Date(2026, 8, 17, 10, i, 0)));
  const gaps = minutes.map((x, i) => ((minutes[(i + 1) % minutes.length] - x + 60) % 60) || 60);
  assert.equal(new Set(gaps).size, 1, `🔴 крон «${spec}» стріляє нерівно`);
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  const row = MONITORED_JOBS.find((j) => j.name === "hiringAccess");
  assert.ok(row, "🔴 джоба не під наглядом — її мовчання ніхто не побачить");
  assert.equal(row.everyMin, gaps[0], `🔴 нагляд чекає раз на ${row.everyMin} хв, а крон стріляє раз на ${gaps[0]}`);
  assert.match(src, /\["hiringAccess", \(\) => closeExpiredCandidateAccess\(\)\]/, "🔴 немає стартового прогону — після рестарту вікно мовчання до пів години");
});

/**
 * #572 — ПРИВʼЯЗАТИ НАЯВНИЙ АКАУНТ (18.09.2026: `test-candidate@uts.ua` зробили в «Налаштуваннях» і на
 * «На навчанні» його не було). Лише «редагування»; лише акаунт із роллю «Кандидат», не привʼязаний до
 * іншої картки; картка — без акаунта. Після привʼязки людина видна на дошці навчання.
 * 🧨 Червоніє, якщо дозволити тімліду, чужу роль, акаунт з іншої картки або перезаписати наявний акаунт.
 */
test("#572 ЖИВИЙ SQL: привʼязка наявного акаунта — лише HR, лише вільний кандидатський, після — на дошці навчання", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const tr = await import("./hiringTraining.js");
  try {
    const a = await toCandidate(s.db, "Тестова Анна", "0970000301");
    const b = await toCandidate(s.db, "Тестова Богдана", "0970000302");
    await s.c.query(`UPDATE hiring_candidates SET user_id = NULL WHERE id IN ($1, $2)`, [a, b]);
    const manual = (await s.c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ('test-candidate@uts.ua','x','manager','candidate','Тест') RETURNING id`)).rows[0].id as number;
    const manager = (await s.c.query(`INSERT INTO users (email, password_hash, role, full_name) VALUES ('m@uts.ua','x','manager','Менеджер') RETURNING id`)).rows[0].id as number;
    assert.ok((await tr.freeCandidateAccounts(s.db)).some((u) => u.id === manual), "🔴 ручного акаунта немає серед вільних");
    await assert.rejects(tr.linkCandidateAccount(s.db, null, a, manual, "lead"), code(403), "🔴 тімлід привʼязав акаунт");
    await assert.rejects(tr.linkCandidateAccount(s.db, null, a, manager, "edit"), code(409), "🔴 привʼязано акаунт менеджера");
    const r = await tr.linkCandidateAccount(s.db, null, a, manual, "edit");
    assert.equal(r.login, "test-candidate@uts.ua");
    assert.equal((await s.c.query(`SELECT user_id FROM hiring_candidates WHERE id = $1`, [a])).rows[0].user_id, manual);
    await assert.rejects(tr.linkCandidateAccount(s.db, null, b, manual, "edit"), code(409), "🔴 один акаунт на двох картках");
    await assert.rejects(tr.linkCandidateAccount(s.db, null, a, manual, "edit"), code(409), "🔴 перезаписано наявний акаунт картки");
    assert.ok(!(await tr.freeCandidateAccounts(s.db)).some((u) => u.id === manual), "🔴 привʼязаний акаунт досі «вільний»");
    const board = await tr.trainingBoard(s.db, "edit", null);
    assert.ok(board.some((row) => (row as { id: number }).id === a), "🔴 після привʼязки кандидата немає на дошці навчання");
  } finally { await s.done(); }
});

/** Кандидат на етапі «з тімлідом» команди 1, з поштою або без — для гейтів 12.10.2026. */
async function toLead(db: import("./hiring.js").Db, name: string, phone: string, email: string | null) {
  const h = await import("./hiring.js");
  const vac = await h.createVacancy(db, null, { title: `Сейлз ${phone}` });
  const id = await h.createCandidate(db, null, { fullName: name, phone, email, vacancyId: vac });
  for (const to of ["planned", "done"]) await h.changeStatus(db, null, id, { to, comment: "так" }, "edit", null);
  await h.changeStatus(db, null, id, { to: "lead", comment: "до тімліда", teamId: 1 }, "edit", null);
  return id;
}

/**
 * #1620 — ЖИВИЙ SQL: АКАУНТ КАНДИДАТА — З ПОШТОЮ І ОДРАЗУ З ВХОДОМ. Заміряно на проді 12.10.2026: з 15 акаунтів
 * 13 мали службовий логін `candidate-N@hiring.uts.local`, видано 0 паролів, жоден кандидат не увійшов, 14 закрились
 * «не зайшов за 48 год». Тепер: без пошти перехід у «кандидат + команда» — 400 ДО зміни статусу (статус і акаунт
 * не чіпаються); пошта з діалогу (тімлід, який картку не редагує) стає логіном; перехід, що створив акаунт,
 * повертає логін і пароль, і пароль справжній (bcrypt), а в історії його немає; повторний перехід при вже
 * наявному акаунті пароль НЕ перевидає.
 * 🧨 Червоніє, якщо повернути службовий логін для картки без пошти або не віддати вхід при створенні акаунта.
 */
test("#1620 ЖИВИЙ SQL: «кандидат + команда» без пошти — 400; з поштою — логін = пошта, вхід видається одразу", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  const bcrypt = (await import("bcryptjs")).default;
  try {
    const id = await toLead(s.db, "Сичевський Павло", "0970001620", null);
    await assert.rejects(h.changeStatus(s.db, null, id, { to: "candidate", comment: "беремо" }, "lead", 1), code(400), "🔴 акаунт без пошти створився");
    const still = (await s.c.query("SELECT status, user_id FROM hiring_candidates WHERE id=$1", [id])).rows[0];
    assert.deepEqual([still.status, still.user_id], ["lead", null], "🔴 відмова без пошти лишила напівзроблений перехід");
    assert.equal((await s.c.query("SELECT count(*)::int n FROM users WHERE email LIKE '%hiring.uts.local'")).rows[0].n, 0, "🔴 створено службовий логін");

    const cred = await h.changeStatus(s.db, null, id, { to: "candidate", comment: "беремо", email: " Pavlo.S@Gmail.com " }, "lead", 1);
    assert.ok(cred, "🔴 перехід, що створив акаунт, не віддав вхід");
    assert.equal(cred!.login, "pavlo.s@gmail.com", "🔴 логін не пошта з діалогу");
    const u = (await s.c.query("SELECT u.email, u.password_hash FROM hiring_candidates c JOIN users u ON u.id = c.user_id WHERE c.id=$1", [id])).rows[0];
    assert.equal(u.email, "pavlo.s@gmail.com");
    assert.ok(await bcrypt.compare(cred!.password, u.password_hash), "🔴 виданий пароль не той, що в акаунті");
    const hist = (await s.c.query("SELECT string_agg(comment, ' | ') AS t FROM hiring_events WHERE candidate_id=$1", [id])).rows[0].t as string;
    assert.ok(!hist.includes(cred!.password), "🔴 пароль потрапив в історію");
    assert.match(hist, /видано логін і пароль/, "🔴 видача входу не лишила сліду");

    // Повторний перехід при наявному акаунті — без нового пароля (повернення з «на навчанні» і назад).
    await h.changeStatus(s.db, null, id, { to: "training", comment: "на навчання" }, "lead", 1);
    await h.changeStatus(s.db, null, id, { to: "candidate", comment: "помилковий клік" }, "lead", 1);
    const again = await h.changeStatus(s.db, null, id, { to: "training", comment: "знову" }, "lead", 1);
    assert.equal(again, null);
    assert.ok(await bcrypt.compare(cred!.password, (await s.c.query("SELECT u.password_hash FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1", [id])).rows[0].password_hash),
      "🔴 повернення статусу перевидало пароль");
  } finally { await s.done(); }
});

/**
 * #1621 — ЖИВИЙ SQL: ЛОГІН ЙДЕ ЗА ПОШТОЮ КАРТКИ. Службовий логін (так на проді 13 акаунтів) лікується тим, що в
 * картку вносять пошту; зміна пошти — новий логін; пошта, зайнята іншим користувачем, — 409 і нічого не змінено;
 * акаунт, що вже став менеджером, логін за карткою не міняє.
 * 🧨 Червоніє, якщо логін не синхронізується або перезаписує чужу пошту.
 */
test("#1621 ЖИВИЙ SQL: пошта в картці міняє логін кандидата; зайнята — 409; менеджера не чіпає", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  try {
    const id = await toCandidate(s.db, "Гузь Павло", "0970001621");
    const uid = (await s.c.query("SELECT user_id FROM hiring_candidates WHERE id=$1", [id])).rows[0].user_id as number;
    await s.c.query("UPDATE users SET email = $1 WHERE id = $2", [`candidate-${id}@hiring.uts.local`, uid]); // як на проді
    const login = async () => (await s.c.query("SELECT email FROM users WHERE id=$1", [uid])).rows[0].email as string;
    await h.updateCandidateFields(s.db, null, id, { email: "Pavlo.Guz@gmail.com" });
    assert.equal(await login(), "pavlo.guz@gmail.com", "🔴 службовий логін не замінився поштою картки");
    await s.c.query("INSERT INTO users (email, password_hash, role) VALUES ('busy@gmail.com','x','manager')");
    await assert.rejects(h.updateCandidateFields(s.db, null, id, { email: "busy@gmail.com" }), code(409), "🔴 логін перезаписав чужу пошту");
    assert.equal(await login(), "pavlo.guz@gmail.com");
    await h.updateCandidateFields(s.db, null, id, { phone: "0970001699" }); // інше поле — логін не чіпається
    assert.equal(await login(), "pavlo.guz@gmail.com");
    await s.c.query("UPDATE users SET role_override = 'manager' WHERE id=$1", [uid]);
    await h.updateCandidateFields(s.db, null, id, { email: "new.one@gmail.com" });
    assert.equal(await login(), "pavlo.guz@gmail.com", "🔴 логін менеджера змінився з картки кандидата");
  } finally { await s.done(); }
});

/**
 * #2230 — ЖИВИЙ SQL: «ВИЙШОВ НА РОБОТУ» НЕ ВИМИКАЄ АКАУНТ (замінив `#1622`, алгоритм «один акаунт» 21.10.2026).
 * Лише HR/керівництво, лише з «кандидат + команда» / «на навчанні», з коментарем. Статус «менеджер», щоденний звіт
 * рахує «Вийшли на роботу», людина в реєстрі співробітників НА ЦЬОМУ Ж акаунті. Акаунт лишається активним:
 * Kommo ще не привʼязано — роль «Кандидат» (менеджером людину зробить синк, `#2232`); уже привʼязано — роль із
 * Kommo одразу, картка з Kommo. «Повернути останню зміну» повертає все, включно з роллю «Кандидат»; «Відновити
 * доступ» менеджеру — 409; уже закритий доступ (48 год) — причина стає «вийшов на роботу», а вмикає вхід Kommo.
 * 🧨 Червоніє, якщо дати це тімліду, вимагати навчання, ВИМКНУТИ акаунт, лишити «Кандидат» при привʼязаному Kommo,
 * забути роль при поверненні або не рахувати у звіті.
 */
test("#2230 ЖИВИЙ SQL: «Вийшов на роботу» — HR, статус «менеджер», звіт, реєстр, акаунт лишається, роль із Kommo, скасовно", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  const tr = await import("./hiringTraining.js");
  try {
    const id = await toCandidate(s.db, "Сичевський Павло", "0970001622");
    const uid = (await s.c.query("SELECT user_id FROM hiring_candidates WHERE id=$1", [id])).rows[0].user_id as number;
    await assert.rejects(tr.markStartedWork(s.db, null, id, "вийшов", "lead"), code(403), "🔴 тімлід відмітив вихід на роботу");
    await assert.rejects(tr.markStartedWork(s.db, null, id, "  ", "edit"), code(400), "🔴 без коментаря");
    const early = await toLead(s.db, "Рано Ще", "0970001623", "rano@gmail.com");
    await assert.rejects(tr.markStartedWork(s.db, null, early, "вийшов", "edit"), code(409), "🔴 вихід на роботу з етапу «з тімлідом»");

    // ① Kommo ще не привʼязано: акаунт живий, роль «Кандидат» — до синку.
    await tr.markStartedWork(s.db, null, id, "вийшов 06.10 у РПК", "edit");
    const r = (await s.c.query(`SELECT c.status, c.access_closed_reason, u.is_active, u.role_override FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([r.status, r.access_closed_reason, r.is_active, r.role_override], ["manager", "started", true, "candidate"], "🔴 «вийшов на роботу» вимкнув акаунт або змінив роль без Kommo");
    const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
    assert.equal((await h.dailyReport(s.db, day, day))[0].toManager, 1, "🔴 «Вийшли на роботу» не порахувало");
    const card = (await s.c.query("SELECT user_id, manager_id FROM employees WHERE candidate_id=$1", [id])).rows;
    assert.deepEqual(card.map((x) => [x.user_id, x.manager_id]), [[uid, null]], "🔴 людини немає в реєстрі або картка не на цьому акаунті");
    assert.equal((await tr.trainingBoard(s.db, "edit", null)).find((x) => x.id === id)?.health, "manager", "🔴 дошка не показує «став менеджером»");
    await assert.rejects(tr.restoreAccess(s.db, null, id), code(409), "🔴 «Відновити доступ» спрацював для менеджера");

    await h.changeStatus(s.db, null, id, { to: "candidate", comment: "помилково" }, "edit", null);
    const back = (await s.c.query(`SELECT c.status, c.access_closed_reason, u.is_active, u.role_override FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([back.status, back.access_closed_reason, back.is_active, back.role_override], ["candidate", null, true, "candidate"], "🔴 повернення не скасувало вихід на роботу");
    assert.equal((await s.c.query("SELECT count(*)::int n FROM employees WHERE candidate_id=$1", [id])).rows[0].n, 0, "🔴 повернення лишило людину в реєстрі");

    // ② Kommo вже привʼязано (синк узяв акаунт за робочою поштою): одразу роль із Kommo і картка з Kommo.
    await s.c.query("INSERT INTO managers (id,name,team_id,is_active,kommo_user_id,email) VALUES (5302,'Сичевський Павло',1,true,5302,'c0970001622@gmail.com')");
    await s.c.query("UPDATE users SET role='manager', manager_id=5302 WHERE id=$1", [uid]);
    await tr.markStartedWork(s.db, null, id, "вийшов знову", "edit");
    const k = (await s.c.query(`SELECT u.is_active, u.role_override, COALESCE(u.role_override, u.role) AS eff, e.manager_id FROM hiring_candidates c JOIN users u ON u.id=c.user_id JOIN employees e ON e.candidate_id=c.id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([k.is_active, k.role_override, k.eff, k.manager_id], [true, null, "manager", 5302], "🔴 при привʼязаному Kommo лишився «Кандидат» або картка без Kommo");
    await h.changeStatus(s.db, null, id, { to: "candidate", comment: "помилково" }, "edit", null);
    assert.equal((await s.c.query("SELECT role_override FROM users WHERE id=$1", [uid])).rows[0].role_override, "candidate", "🔴 повернення не відновило роль «Кандидат» після зняття");

    // ③ Доступ уже закрито «не зайшов за 48 год» (так 14 із 15 на проді) — вихід на роботу все одно відмічається;
    //    вхід лишається закритим, доки не привʼяжеться Kommo, — тоді активність бере з Kommo.
    const closed = await toCandidate(s.db, "Закритий Доступ", "0970001624");
    const cuid = (await s.c.query("SELECT user_id FROM hiring_candidates WHERE id=$1", [closed])).rows[0].user_id as number;
    await tr.closeCandidateAccess(s.db, closed, "no_login", null);
    await tr.markStartedWork(s.db, null, closed, "вийшов", "edit");
    const cl = (await s.c.query(`SELECT c.status, c.access_closed_reason, u.is_active, u.role_override FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [closed])).rows[0];
    assert.deepEqual([cl.status, cl.access_closed_reason, cl.is_active, cl.role_override], ["manager", "started", false, "candidate"]);
    await s.c.query("INSERT INTO managers (id,name,team_id,is_active,kommo_user_id,email) VALUES (5303,'Закритий Доступ',1,true,5303,'c0970001624@gmail.com')");
    await s.c.query("UPDATE users SET role='manager', manager_id=5303 WHERE id=$1", [cuid]);
    assert.equal(await tr.settleHiredAccount(s.db, cuid, null), "settled");
    const op = (await s.c.query("SELECT is_active, role_override FROM users WHERE id=$1", [cuid])).rows[0];
    assert.deepEqual([op.is_active, op.role_override], [true, null], "🔴 привʼязаний Kommo не відкрив вхід людині, що вийшла на роботу");
  } finally { await s.done(); }
});

/**
 * #2232 — ЖИВИЙ SQL: СИНК ЧІПЛЯЄ KOMMO ДО АКАУНТА КАНДИДАТА, А НЕ РОБИТЬ ДРУГИЙ (алгоритм «один акаунт», 21.10.2026).
 * Ті самі кроки, що `provisionUsers`, і ТІ САМІ запити: пошук `PROVISION_LOOKUP_SQL`, оновлення через
 * `isActiveAssignSql`, умова `syncShouldSettle`, потім `settleHiredAccount`. HR вписала кандидату робочу пошту —
 * логін змінився — синк знаходить цей акаунт (пошта в Kommo іншим регістром). Того, хто ще вчиться, синк
 * менеджером НЕ робить (дзеркало). Переведеного — робить: роль із Kommo (і тімлід — тімлідом), картка з Kommo.
 * Чужу ручну роль (КВП) не чіпає. Із двох акаунтів бере вже прив'язаний до цього Kommo.
 * 🧨 Червоніє, якщо шукати пошту з урахуванням регістру, знімати «Кандидат» без переведення, перезаписувати
 * будь-яку ручну роль, прибрати порядок пошуку або не дати картці Kommo.
 */
test("#2232 ЖИВИЙ SQL: синк чіпляє Kommo до акаунта кандидата за робочою поштою; переведеного робить робочим, того, хто вчиться, — ні", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  const tr = await import("./hiringTraining.js");
  const { PROVISION_LOOKUP_SQL, isActiveAssignSql, syncShouldSettle } = await import("./provisionRules.js");
  /** Один тік `provisionUsers` для одного менеджера — тими самими запитами. Повертає id акаунта або null. */
  const tick = async (m: { id: number; email: string; team_lead?: boolean }) => {
    const u = (await s.c.query(PROVISION_LOOKUP_SQL, [m.id, m.email])).rows[0] as { id: number; role_override: string | null; manager_id: number | null } | undefined;
    if (!u) return null;
    await s.c.query(`UPDATE users SET role = $1, team_id = $2, manager_id = $3, ${isActiveAssignSql("$4")} WHERE id = $5`,
      [m.team_lead ? "team_lead" : "manager", 1, m.id, true, u.id]);
    if (syncShouldSettle(u, m.id)) await tr.settleHiredAccount(s.db, u.id, null);
    return u.id;
  };
  const kommo = (id: number, name: string, email: string, lead = false) => s.c.query(
    "INSERT INTO managers (id,name,team_id,is_active,kommo_user_id,email,is_team_lead) VALUES ($1,$2,1,true,$5,$3,$4)", [id, name, email, lead, id]);
  const acc = async (uid: number) => (await s.c.query("SELECT role_override, COALESCE(role_override, role) AS eff, manager_id, is_active FROM users WHERE id=$1", [uid])).rows[0];
  try {
    // ① Ще вчиться: Kommo привʼязується до ЦЬОГО акаунта, але менеджером людина не стає (дзеркало).
    const learning = await toCandidate(s.db, "Вчиться Ще", "0970002232");
    const luid = (await s.c.query("SELECT user_id FROM hiring_candidates WHERE id=$1", [learning])).rows[0].user_id as number;
    await h.updateCandidateFields(s.db, null, learning, { email: "vsh@uts.ua" });
    await kommo(5321, "Вчиться Ще", "VSH@uts.ua");
    assert.equal(await tick({ id: 5321, email: "VSH@uts.ua" }), luid, "🔴 синк не знайшов акаунт кандидата за робочою поштою — зробив би другий");
    const l = await acc(luid);
    assert.deepEqual([l.manager_id, l.role_override], [5321, "candidate"], "🔴 синк зробив менеджером того, хто ще вчиться");

    // ② Переведений, а Kommo привʼязався потім (порядок, як у 8 із 8 на проді, лише без другого акаунта):
    //    тімлід у Kommo — тімлід у дашборді, картка отримує Kommo.
    const hired = await toCandidate(s.db, "Вийшла Вже", "0970002233");
    const huid = (await s.c.query("SELECT user_id FROM hiring_candidates WHERE id=$1", [hired])).rows[0].user_id as number;
    await tr.markStartedWork(s.db, null, hired, "вийшла", "edit");
    assert.equal((await acc(huid)).role_override, "candidate", "🔴 без Kommo роль змінилась");
    await h.updateCandidateFields(s.db, null, hired, { email: "vv@uts.ua" });
    await kommo(5322, "Вийшла Вже", "vv@uts.ua", true);
    assert.equal(await tick({ id: 5322, email: "vv@uts.ua", team_lead: true }), huid);
    const w = await acc(huid);
    assert.deepEqual([w.role_override, w.eff, w.is_active], [null, "team_lead", true], "🔴 синк не зробив переведену людину робочою або роль не з Kommo");
    assert.equal((await s.c.query("SELECT manager_id FROM employees WHERE user_id=$1", [huid])).rows[0]?.manager_id, 5322, "🔴 картка не отримала Kommo");
    assert.equal(syncShouldSettle({ role_override: null, manager_id: 5322 }, 5322), false, "🔴 наступні тіки кликали б settle на кожного менеджера");

    // ③ Чужа ручна роль: переведений, але адмін дав йому «КВП» — синк її не чіпає.
    const kvp = await toCandidate(s.db, "Ручна Роль", "0970002234");
    const kuid = (await s.c.query("SELECT user_id FROM hiring_candidates WHERE id=$1", [kvp])).rows[0].user_id as number;
    await tr.markStartedWork(s.db, null, kvp, "вийшла", "edit");
    await s.c.query("UPDATE users SET role_override='kvp' WHERE id=$1", [kuid]);
    await kommo(5323, "Ручна Роль", "c0970002234@gmail.com");
    await tick({ id: 5323, email: "c0970002234@gmail.com" });
    assert.equal((await acc(kuid)).role_override, "kvp", "🔴 синк перезаписав ручну роль, видану адміном");

    // ④ Два акаунти збігаються (з тією самою поштою — РАНІШЕ за id): береться прив'язаний до цього Kommo.
    const byMail = (await s.c.query("INSERT INTO users (email, password_hash, role) VALUES ('dup@uts.ua','x','manager') RETURNING id")).rows[0].id as number;
    await kommo(5324, "Дубль", "dup@uts.ua");
    const linked = (await s.c.query("INSERT INTO users (email, password_hash, role, manager_id) VALUES ('other@uts.ua','x','manager',5324) RETURNING id")).rows[0].id as number;
    assert.ok(byMail < linked, "фікстура: акаунт за поштою мусить бути ПЕРШИМ, інакше порядок нічого не доводить");
    assert.equal(await tick({ id: 5324, email: "dup@uts.ua" }), linked, "🔴 синк узяв акаунт за поштою, хоча є прив'язаний до цього Kommo");
  } finally { await s.done(); }
});

/**
 * #2232b — ПРОВОДКА: `provisionUsers` справді шукає через `PROVISION_LOOKUP_SQL` і кличе `settleHiredAccount` за
 * `syncShouldSettle` — `#2232` виконує ці частини окремо, і без проводки зелений `#2232` нічого не казав би про синк.
 * 🧨 Червоніє, якщо повернути власний запит пошуку або прибрати виклик.
 */
test("#2232b provisionUsers шукає через PROVISION_LOOKUP_SQL і кличе settleHiredAccount", () => {
  const src = SRC("db/userProvisioning.ts");
  assert.match(src, /pool\.query<[^>]*>\(\s*PROVISION_LOOKUP_SQL\b(?!_), \[m\.id, m\.email\]/, "🔴 синк шукає акаунт не тим запитом, який перевіряє #2232");
  assert.match(src, /if \(syncShouldSettle\(u, m\.id\)\) await settleHiredAccount\(pool, u\.id, null\);/, "🔴 синк не робить переведену людину робочою");
  assert.doesNotMatch(src, /FROM users WHERE manager_id = \$1 OR email = \$2/, "🔴 повернувся старий пошук без регістру й без порядку");
});

/**
 * #1623 — СТАРТОВА ВКЛАДКА ЗА РОЛЛЮ. Корінь «/» вів у «Звіт» усіх, хоча «Звіт» закритий Кандидату, HR, Бухгалтерії
 * й Бізнес-асистенту. Функцію фронту ВИКОНУЄМО (транспіляція), а не читаємо очима; і перевіряємо, що Dashboard її кличе.
 * По обидва боки: ролі зі «Звітом» лишаються на «Звіті»; без «Звіту» — своя або перша дозволена.
 * 🧨 Червоніє, якщо повернути «report» усім або прибрати виклик із Dashboard.
 */
test("#1623 СТАРТОВА ВКЛАДКА: кандидат → «Навчання», HR → «Найм», без «Звіту» — перша дозволена; решта — «Звіт»", async () => {
  const ts = (await import("typescript")).default;
  const FE = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages");
  const js = ts.transpileModule(readFileSync(path.join(FE, "dashboard", "homeSection.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { homeSection } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  const nav = ["report", "kvp", "receivables", "tasks", "hiring", "training", "documents", "ba", "bank"];
  assert.equal(homeSection({ roleKey: "candidate", screens: ["documents", "training"], navKeys: nav }), "training", "🔴 кандидат не на «Навчанні»");
  assert.equal(homeSection({ roleKey: "hr", screens: ["documents", "hiring", "tasks", "training"], navKeys: nav }), "hiring", "🔴 HR не на «Наймі»");
  assert.equal(homeSection({ roleKey: "____________", screens: ["bank", "receivables", "tasks"], navKeys: nav }), "receivables", "🔴 без «Звіту» — не перша дозволена в порядку меню");
  assert.equal(homeSection({ roleKey: "manager", screens: ["report", "tasks", "training"], navKeys: nav }), "report", "дзеркало: менеджер лишається на «Звіті»");
  assert.equal(homeSection({ roleKey: "admin", screens: ["report", "hiring"], navKeys: nav }), "report", "дзеркало: адмін лишається на «Звіті»");
  assert.equal(homeSection({ roleKey: "candidate", screens: ["documents"], navKeys: nav }), "documents", "🔴 вкладки ролі немає — треба першу дозволену");
  assert.equal(homeSection({ roleKey: "hr", navKeys: nav }), "report", "старий токен без вкладок — «Звіт», як було");
  const dash = readFileSync(path.join(FE, "Dashboard.tsx"), "utf8");
  assert.match(dash, /homeSection\(\{ roleKey: auth\?\.roleKey, screens: auth\?\.screens/, "🔴 Dashboard не кличе homeSection");
  assert.match(dash, /if \(!rawSection && home !== "report"\) navigate\(`\/\$\{home\}`/, "🔴 корінь «/» не веде на стартову вкладку ролі");
});

/**
 * #1950 — ЖИВИЙ SQL: «ЗМІНИТИ КОМАНДУ» В КАРТЦІ. Команду обирають лише на переходах до тімліда, а «↩ Повернути»
 * відкочує на один крок — помилкову команду (Баланчук: «Самостійний» замість «Хомік Team Lead») нічим було
 * виправити. Тепер: лише HR/керівництво (тімлід — 403), з коментарем, у наявну команду, не в ту саму; статус не
 * рухається; акаунт КАНДИДАТА переїжджає разом, акаунт з іншою роллю (менеджер — його веде Kommo) — ні; в історії
 * «стара → нова».
 * 🧨 Червоніє, якщо дати це тімліду, змінити статус, лишити акаунт кандидата в старій команді або чіпати менеджера.
 */
test("#1950 ЖИВИЙ SQL: «Змінити команду» — HR, будь-який статус, акаунт кандидата за нею, менеджера не чіпає", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  try {
    const id = await toCandidate(s.db, "Баланчук Ольга", "0970001950");
    const uid = (await s.c.query("SELECT user_id FROM hiring_candidates WHERE id=$1", [id])).rows[0].user_id as number;
    const state = async () => (await s.c.query(`SELECT c.status, c.team_id, u.team_id AS u_team FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual(await state(), { status: "candidate", team_id: 1, u_team: 1 });
    await assert.rejects(h.changeTeam(s.db, null, id, { teamId: 2, comment: "в іншу" }, "lead"), code(403), "🔴 тімлід змінив команду");
    await assert.rejects(h.changeTeam(s.db, null, id, { teamId: 2, comment: " " }, "edit"), code(400), "🔴 без коментаря");
    await assert.rejects(h.changeTeam(s.db, null, id, { teamId: 999, comment: "нема" }, "edit"), code(400), "🔴 неіснуюча команда");
    await assert.rejects(h.changeTeam(s.db, null, id, { teamId: 1, comment: "та сама" }, "edit"), code(400), "🔴 «зміна» на ту саму команду");

    await h.changeTeam(s.db, null, id, { teamId: 2, comment: "Команда Вікторії Хомік" }, "edit");
    assert.deepEqual(await state(), { status: "candidate", team_id: 2, u_team: 2 }, "🔴 команда кандидата чи його акаунта не змінилась, або зсунувся статус");
    const ev = (await s.c.query(`SELECT comment FROM hiring_events WHERE candidate_id=$1 AND kind='edit' ORDER BY id DESC LIMIT 1`, [id])).rows[0].comment as string;
    assert.match(ev, /команда: «РПК · Дмитрук» → «РНК · Безпамʼятний» · Команда Вікторії Хомік/, "🔴 в історії немає «стара → нова»");

    // Менеджер (роль не «кандидат») — робочу команду веде Kommo, акаунт не чіпаємо; картку — так.
    await s.c.query("UPDATE users SET role_override = 'manager' WHERE id = $1", [uid]);
    await h.changeTeam(s.db, null, id, { teamId: 1, comment: "назад" }, "edit");
    assert.deepEqual(await state(), { status: "candidate", team_id: 1, u_team: 2 }, "🔴 зміна команди в картці переписала команду менеджерського акаунта");
  } finally { await s.done(); }
});

/**
 * #2101 — ЖИВИЙ SQL: РУЧНЕ ВИПРАВЛЕННЯ ПЛИТКИ «ЩОДЕННОГО ЗВІТУ» (21.10.2026, рішення Романа). Ручне число замінює
 * авто ЛИШЕ за свій день і лише цю плитку; системне число лишається поруч (`auto`), плитка позначена (`manual`);
 * сума періоду бере ручне; `null` повертає авто; невідомий показник і відʼємне — 400.
 * 🧨 Червоніє, якщо ручне не застосовується, «зачіпає» сусідній день/плитку або «авто» не повертає системне число.
 */
test("#2101 ЖИВИЙ SQL: ручне число плитки — лише свій день і своя плитка, авто поруч, «авто» повертає систему", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  const { dailyTotals } = await import("./hiringRules.js");
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  try {
    await toCandidate(s.db, "Ручний Звіт", "0970002101"); // сьогодні: переходи до тімліда й «кандидат + команда»
    const before = (await h.dailyReport(s.db, day, day))[0];
    assert.equal(before.toLead, 1, "передумова: система нарахувала 1 перехід до тімліда");
    await assert.rejects(h.setDailyOverride(s.db, null, day, { metric: "noshow", value: 3 }), code(400), "🔴 виправлено показник, якого немає серед плиток");
    await assert.rejects(h.setDailyOverride(s.db, null, day, { metric: "toLead", value: -1 }), code(400), "🔴 відʼємне число");

    await h.setDailyOverride(s.db, null, day, { metric: "toLead", value: 4 });
    const [p, d] = await h.dailyReport(s.db, prev, day);
    assert.deepEqual([d.toLead, d.manual, d.auto], [4, ["toLead"], { toLead: 1 }], "🔴 ручне число не застосувалось або не видно системного");
    assert.equal(d.toCandidate, before.toCandidate, "🔴 ручне число зачепило сусідню плитку");
    assert.equal(p.manual, undefined, "🔴 ручне число зачепило сусідній день");
    assert.equal(dailyTotals([p, d]).toLead, 4 + p.toLead, "🔴 сума періоду не бере ручне число");

    await h.setDailyOverride(s.db, null, day, { metric: "toLead", value: 7 });
    assert.equal((await h.dailyReport(s.db, day, day))[0].toLead, 7, "🔴 повторне виправлення не переписало число");
    await h.setDailyOverride(s.db, null, day, { metric: "toLead", value: null });
    const back = (await h.dailyReport(s.db, day, day))[0];
    assert.deepEqual([back.toLead, back.manual], [1, undefined], "🔴 «авто» не повернуло число системи");
  } finally { await s.done(); }
});

/**
 * #2103 — ЖИВИЙ SQL: ПЛАН/ФАКТ ТИЖНЯ ПО 6 ПОКАЗНИКАХ (22.10.2026: Іван прибрав план із «резюме» й «холодного пошуку»).
 * Будь-який день → понеділок; неставлений план — `null`, а не 0; план на «резюме»/«холодний пошук» — 400; факт =
 * сума днів того самого звіту, РАЗОМ із денними й ТИЖНЕВИМИ ручними (#2104); `null` прибирає план.
 * 🧨 Червоніє, якщо факт не збігається зі звітом, план не на понеділок, «немає плану» стає нулем або вертається
 * план на резюме.
 */
test("#2103 ЖИВИЙ SQL: план тижня по 6 показниках — понеділок, «немає плану» ≠ 0, факт = звіт із ручними", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  const { weekStartOf, dailyTotals } = await import("./hiringRules.js");
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const mon = weekStartOf(day);
  try {
    assert.equal(weekStartOf("2026-10-25"), "2026-10-19", "🔴 неділя не належить тижню з понеділка 19.10");
    assert.equal(weekStartOf("2026-10-19"), "2026-10-19");
    await toCandidate(s.db, "План Тижня", "0970002103");
    await h.setDailyOverride(s.db, null, day, { metric: "done", value: 5 });
    await assert.rejects(h.setWeekPlan(s.db, null, day, { resumes: 10 }), code(400), "🔴 план на «оброблено резюме» повернувся");
    await assert.rejects(h.setWeekPlan(s.db, null, day, { coldSearch: 10 }), code(400), "🔴 план на «холодний пошук» повернувся");
    await h.setWeekPlan(s.db, null, day, { planned: 35, done: 30 });
    const w = await h.weekPlan(s.db, day);
    assert.equal(w.weekStart, mon, "🔴 план не на понеділок тижня");
    assert.deepEqual(Object.keys(w.plans).sort(), ["done", "planned", "toCandidate", "toLead", "toManager", "toTraining"], "🔴 не ті 6 показників плану");
    assert.deepEqual([w.plans.planned, w.plans.done, w.plans.toLead], [35, 30, null], "🔴 «немає плану» стало нулем або план загубився");
    const weekEnd = new Date(Date.parse(`${mon}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    const tot = dailyTotals(await h.dailyReport(s.db, mon, weekEnd));
    assert.deepEqual(w.fact, { planned: tot.planned, done: tot.done, toLead: tot.toLead, toCandidate: tot.toCandidate, toTraining: tot.toTraining, toManager: tot.toManager }, "🔴 факт тижня не збігається зі звітом");
    await h.setWeekOverride(s.db, null, day, { metric: "planned", value: 23 });
    assert.equal((await h.weekPlan(s.db, day)).fact.planned, 23, "🔴 факт плану не взяв тижневе ручне число");
    await h.setWeekPlan(s.db, null, day, { done: null });
    assert.equal((await h.weekPlan(s.db, day)).plans.done, null, "🔴 null не прибрав план");
  } finally { await s.done(); }
});

/**
 * #2104 — ЖИВИЙ SQL: ТИЖНЕВЕ РУЧНЕ ЧИСЛО (22.10.2026; Іван: «щоб можна було корегувати в розрізі „цей тиждень“,
 * „минулий тиждень“»). Діє лише коли період — один тиждень (від понеділка, не довше неділі): замінює суму тижня й
 * лише цю плитку, системне число поруч (`auto`), явку перераховано; інший період (два тижні, місяць) — сума днів;
 * сусідній тиждень не зачеплено; `null` повертає суму; невідомий показник — 400.
 * 🧨 Червоніє, якщо тижневе число не замінює суму, діє на місяць/інший тиждень або «авто» не повертає суму днів.
 */
test("#2104 ЖИВИЙ SQL: тижневе ручне число — лише вигляд одного тижня, своя плитка, авто поруч, «авто» повертає суму", async (t) => {
  const s = await scratchDb(t); if (!s) return;
  const h = await import("./hiring.js");
  const { weekStartOf, wholeWeekOf, dailyTotals } = await import("./hiringRules.js");
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const mon = weekStartOf(day);
  const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  try {
    assert.equal(wholeWeekOf(mon, day), mon, "🔴 «цей тиждень» (пн–сьогодні) не визнано тижнем");
    assert.equal(wholeWeekOf(mon, plus(mon, 6)), mon);
    assert.equal(wholeWeekOf(plus(mon, 1), plus(mon, 6)), null, "🔴 період не від понеділка визнано тижнем");
    assert.equal(wholeWeekOf(mon, plus(mon, 7)), null, "🔴 два тижні визнано одним");
    await toCandidate(s.db, "Тижневе Число", "0970002104");
    await assert.rejects(h.setWeekOverride(s.db, null, day, { metric: "noshow", value: 1 }), code(400), "🔴 невідомий показник");
    const auto = dailyTotals(await h.dailyReport(s.db, mon, plus(mon, 6)));
    await h.setWeekOverride(s.db, null, day, { metric: "done", value: 22 });
    await h.setWeekOverride(s.db, null, plus(day, 1), { metric: "resumes", value: 28 }); // інший день того ж тижня — той самий тиждень
    const w = await h.applyWeekOverride(s.db, mon, auto);
    assert.deepEqual([w.totals.done, w.totals.resumes, w.totals.planned], [22, 28, auto.planned], "🔴 тижневе число не замінило суму або зачепило іншу плитку");
    assert.deepEqual(w.auto, { done: auto.done, resumes: auto.resumes }, "🔴 не видно системного числа");
    assert.equal(w.totals.attendancePct, auto.planned ? Math.round((22 / auto.planned) * 100) : null, "🔴 явку не перераховано з ручного «проведено»");
    const other = await h.applyWeekOverride(s.db, plus(mon, 7), auto);
    assert.deepEqual(other.manual, [], "🔴 тижневе число зачепило наступний тиждень");
    await h.setWeekOverride(s.db, null, day, { metric: "done", value: null });
    const back = await h.applyWeekOverride(s.db, mon, auto);
    assert.deepEqual([back.totals.done, back.manual], [auto.done, ["resumes"]], "🔴 «авто» не повернуло суму днів");
  } finally { await s.done(); }
});
