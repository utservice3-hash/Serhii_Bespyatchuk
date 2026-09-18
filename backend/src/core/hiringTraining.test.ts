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

/** Кандидат, доведений до «кандидат + команда» тімлідом команди 1 — рівно шлях макета. */
async function toCandidate(db: import("./hiring.js").Db, name: string, phone: string, email: string | null = null) {
  const h = await import("./hiring.js");
  const vac = await h.createVacancy(db, null, { title: `Сейлз ${phone}` });
  const id = await h.createCandidate(db, null, { fullName: name, phone, email, vacancyId: vac });
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
 * #534 — ЖИВИЙ SQL «МЕНЕДЖЕРА» І ПИТАНЬ. 1 із 2 кроків — ні; 2 із 2 — роль акаунта «Менеджер», статус
 * «менеджер»; загальна зміна статусу в «менеджер» для картки з акаунтом — ні; повернення останньої зміни
 * повертає роль «Кандидат». HR рішення не приймає. Питання ставить лише кандидат, бачить лише свої;
 * відповідає тімлід своєї команди, один раз.
 * 🧨 Червоніє, якщо перевести з недопройденим курсом, лишити роль «Кандидат» у менеджера, пропустити
 * загальний перехід або показати кандидату чужі питання.
 */
test("#534 ЖИВИЙ SQL: «менеджер» після всіх кроків міняє роль і скасовується; питання тімліду", async (t) => {
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
    assert.equal((await s.c.query("SELECT email FROM users WHERE id=$1", [uid])).rows[0].email, `candidate-${id}@hiring.uts.local`, "🔴 без пошти логін не службовий");
    await tr.noteCandidateLogin(s.db, uid);
    await s.c.query("INSERT INTO training_progress (user_id, material_id, status, finished_at) VALUES ($1,$2,'done',now())", [uid, m1]);

    const row = (await tr.trainingBoard(s.db, "edit", null))[0];
    assert.deepEqual([row.done, row.total, row.percent, row.current_step], [1, 2, 50, "Скрипт першого дзвінка"], "🔴 прогрес на дошці не збігається з кроками навчання");
    await assert.rejects(tr.promoteCandidate(s.db, null, id, "готова", true, "lead", 1), code(409), "🔴 менеджер з недопройденим навчанням");
    await s.c.query("INSERT INTO training_progress (user_id, material_id, status, finished_at) VALUES ($1,$2,'done',now())", [uid, m2]);
    await assert.rejects(tr.promoteCandidate(s.db, null, id, "готова", false, "edit", null), code(403), "🔴 рекрутер вирішив замість тімліда");
    await assert.rejects(h.changeStatus(s.db, null, id, { to: "manager", comment: "в обхід" }, "lead", 1), code(409), "🔴 «менеджер» загальним переходом при акаунті навчання");
    await tr.promoteCandidate(s.db, null, id, "готова до роботи", true, "lead", 1);
    const mgr = (await s.c.query(`SELECT c.status, u.role_override, u.is_active FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([mgr.status, mgr.role_override, mgr.is_active], ["manager", "manager", true], "🔴 переведення не змінило роль акаунта");
    assert.deepEqual(await tr.closeExpiredAccess(s.db, new Date(Date.now() + 30 * 24 * H)), { checked: 0, closed: 0 }, "🔴 джоба чіпає менеджера");

    await h.changeStatus(s.db, null, id, { to: "training", comment: "помилковий клік" }, "lead", 1);
    const undo = (await s.c.query(`SELECT c.status, u.role_override FROM hiring_candidates c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [id])).rows[0];
    assert.deepEqual([undo.status, undo.role_override], ["training", "candidate"], "🔴 скасування «менеджера» лишило роль «Менеджер»");

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
