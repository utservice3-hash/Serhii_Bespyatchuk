import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { matchMeetings, parseMeetings, kyivParts, type TldvMeeting, type SlotRow } from "./tldv.js";

/**
 * 🎥 ЗАПИСИ СПІВБЕСІД tl;dv (23.09.2026, прохід 7) — гейти `#704`–`#707`.
 * Номери з запасом над `#702` — борг 17: перед мержем перемірити перетин.
 */
const M = (p: Partial<TldvMeeting> & { id: string }): TldvMeeting =>
  ({ name: "Співбесіда", happenedAt: null, duration: 30, url: null, organizer: "ivan@uts.ua", invitees: [], ...p });
const S = (p: Partial<SlotRow> & { id: number }): SlotRow =>
  ({ interview_date: "2026-09-22", interview_time: "14:30", full_name: "Климчук Анастасія", email: null, tldv_meeting_id: null, ...p });

/**
 * #704 — ЧИЯ ЗУСТРІЧ: певний збіг лише за поштою учасника; збіг за часом — «підказка», а не привʼязка;
 * два рядки в тому самому вікні — «кілька», не перший-ліпший; уже привʼязаний рядок у кандидати не береться;
 * зустріч без збігів — «не впізнано». Вікно ±30 хв: 15:00 біля 14:30 — так, 15:01 — ні.
 * 🧨 Червоніє, якщо привʼязувати за часом автоматично або брати першого з двох.
 */
test("#704 tl;dv: певний збіг лише за поштою; час — підказка; двоє в вікні — «кілька»", () => {
  const rows = [
    S({ id: 1, email: "anastasia@gmail.com" }),
    S({ id: 2, interview_time: "15:00", full_name: "Муляк Анастасія" }),
    S({ id: 3, interview_time: "15:01", full_name: "Пізній" }),
    S({ id: 4, interview_time: "14:30", full_name: "Уже з записом", tldv_meeting_id: "old" }),
  ];
  const at = (t: string) => `2026-09-22T${t}:00+03:00`;
  const r = matchMeetings([
    M({ id: "a", invitees: ["Anastasia@Gmail.com", "ivan@uts.ua"], happenedAt: at("14:30") }),
    M({ id: "b", happenedAt: at("14:30") }),
    M({ id: "c", happenedAt: at("09:00") }),
    M({ id: "d", happenedAt: null }),
  ], rows);
  assert.deepEqual(r.map((x) => [x.meeting.id, x.how, x.interviewId]), [
    ["a", "email", 1], ["b", "many", null], ["c", "none", null], ["d", "none", null],
  ], "🔴 не те зіставлення: " + JSON.stringify(r.map((x) => [x.meeting.id, x.how, x.nearIds])));
  assert.deepEqual(r[1].nearIds.sort(), [1, 2], "🔴 у підказці не ті рядки (або взято вже привʼязаний / 15:01)");
  // Дзеркало: один рядок у вікні — «час», і його теж НЕ привʼязуємо самі.
  const one = matchMeetings([M({ id: "e", happenedAt: at("14:40") })], [S({ id: 9 })])[0];
  assert.deepEqual([one.how, one.interviewId, one.nearIds], ["time", null, [9]], "🔴 один збіг за часом має бути підказкою");
  assert.equal(kyivParts("2026-09-22T21:30:00Z")?.day, "2026-09-23", "🔴 київський день зустрічі рахується не за Києвом");
});

/**
 * #705 — РОЗБІР ВІДПОВІДІ tl;dv в ОДНОМУ місці: id, назва, час, тривалість у хвилинах, посилання, пошти
 * учасників; без `url` — збираємо з id; без id — рядок викидаємо; чужі поля не ламають розбір.
 * 🧨 Червоніє, якщо читати тривалість як хвилини (в API секунди) або не діставати пошту з обʼєкта учасника.
 */
test("#705 tl;dv: розбір відповіді — секунди в хвилини, пошти учасників, посилання з id", () => {
  const body = { results: [
    { id: "m1", name: "Співбесіда", happenedAt: "2026-09-22T11:30:00Z", duration: 2460,
      organizer: { email: "ivan@uts.ua" }, invitees: [{ email: "a@b.com" }, "c@d.com", { name: "без пошти" }] },
    { id: "m2", url: "https://app.tldv.io/meetings/m2", invitees: [], extra: { чуже: true } },
    { name: "без id" },
  ] };
  const r = parseMeetings(body);
  assert.equal(r.length, 2, "🔴 рядок без id не викинуто");
  assert.deepEqual([r[0].duration, r[0].organizer, r[0].invitees], [41, "ivan@uts.ua", ["a@b.com", "c@d.com"]]);
  assert.equal(r[0].url, "https://app.tldv.io/meetings/m1", "🔴 посилання не зібрано з id");
  assert.equal(r[1].url, "https://app.tldv.io/meetings/m2");
  assert.deepEqual(parseMeetings({}), [], "дзеркало: порожня відповідь — порожній список, не падіння");
});

async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const hr = (await c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ('ivan@uts.ua','x','manager','hr','Іван') RETURNING id`)).rows[0].id as number;
  const db = c as unknown as import("./secrets.js").Db;
  const h = await import("./hiring.js");
  const vac = await h.createVacancy(db as unknown as import("./hiring.js").Db, null, { title: "Менеджер з продажу" });
  return { c, db, hr, h, vac, store: await import("./tldvStore.js"), done: async () => { await c.end(); s.dispose(); } };
}

/**
 * #706 — ЖИВИЙ SQL: певний збіг привʼязується сам (посилання в рядок, подія в історію кандидата), непевний
 * лишається чекати людини; повторний прогін нічого не дублює й не перепривʼязує; РУЧНЕ посилання не затирається;
 * «не співбесіда» ховається й повертається.
 * 🧨 Червоніє, якщо автоматика перезапише ручне посилання або привʼяже підказку за часом.
 */
test("#706 ЖИВИЙ SQL: певний збіг привʼязується сам, непевний чекає; ручне посилання не затирається", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    const mk = async (name: string, phone: string, email: string | null, time: string) => {
      const id = await s.h.createCandidate(s.db as never, null, { fullName: name, phone, vacancyId: s.vac, email });
      const iv = await s.h.createInterview(s.db as never, null, { interviewDate: "2026-09-22", interviewTime: time });
      await s.c.query(`UPDATE hiring_interviews SET candidate_id = $2 WHERE id = $1`, [iv, id]);
      return { id, iv };
    };
    const a = await mk("Климчук Анастасія", "0501110001", "anastasia@gmail.com", "14:30");
    const b = await mk("Муляк Анастасія", "0501110002", null, "15:00");
    await s.c.query(`UPDATE hiring_interviews SET record_url = 'https://ручне' WHERE id = $1`, [b.iv]);
    const meets = [
      { id: "m1", name: "Співбесіда", happenedAt: "2026-09-22T11:30:00+03:00", duration: 41, url: "https://app.tldv.io/meetings/m1", organizer: "ivan@uts.ua", invitees: ["anastasia@gmail.com"] },
      { id: "m2", name: "Zoom meeting", happenedAt: "2026-09-22T15:05:00+03:00", duration: 12, url: "https://app.tldv.io/meetings/m2", organizer: "ivan@uts.ua", invitees: [] },
    ];
    const rows = await s.store.slotRows(s.db, "2026-09-20", "2026-09-23");
    const r1 = await s.store.absorb(s.db, meets, rows);
    assert.deepEqual([r1.seen, r1.linked, r1.pending], [2, 1, 1], "🔴 не той підсумок: " + JSON.stringify(r1));
    const ivA = (await s.c.query(`SELECT record_url, tldv_meeting_id FROM hiring_interviews WHERE id = $1`, [a.iv])).rows[0];
    assert.deepEqual(ivA, { record_url: "https://app.tldv.io/meetings/m1", tldv_meeting_id: "m1" }, "🔴 запис не потрапив у рядок");
    assert.ok((await s.c.query(`SELECT 1 FROM hiring_events WHERE candidate_id = $1 AND kind = 'record'`, [a.id])).rowCount, "🔴 немає події в історії");
    const pend = await s.store.pendingList(s.db, "2026-09-20", "2026-09-23");
    assert.deepEqual([pend.length, pend[0].id, pend[0].how], [1, "m2", "time"], "🔴 непевна зустріч не чекає рішення");
    assert.equal(pend[0].suggestions[0].interviewId, b.iv, "🔴 підказка не на той рядок");
    // Повтор: нічого не дублюється, ручне посилання лишається своїм.
    const r2 = await s.store.absorb(s.db, meets, await s.store.slotRows(s.db, "2026-09-20", "2026-09-23"));
    assert.deepEqual([r2.linked, r2.pending], [0, 1], "🔴 повторний прогін перепривʼязує");
    await s.store.linkMeeting(s.db, s.hr, "m2", b.iv, "manual");
    assert.equal((await s.c.query(`SELECT record_url FROM hiring_interviews WHERE id = $1`, [b.iv])).rows[0].record_url, "https://ручне",
      "🔴 автоматика затерла посилання, вставлене руками");
    assert.equal((await s.store.pendingList(s.db, "2026-09-20", "2026-09-23")).length, 0, "🔴 привʼязана зустріч досі чекає");
    // «Не співбесіда» — ховаємо й повертаємо.
    await s.store.absorb(s.db, [{ id: "m3", name: "Обід", happenedAt: "2026-09-22T09:00:00+03:00", duration: 5, url: null, organizer: "ivan@uts.ua", invitees: [] }], rows);
    await s.store.setIgnored(s.db, s.hr, "m3", true);
    assert.equal((await s.store.pendingList(s.db, "2026-09-20", "2026-09-23")).length, 0, "🔴 прихована зустріч досі в списку");
    await s.store.setIgnored(s.db, s.hr, "m3", false);
    assert.equal((await s.store.pendingList(s.db, "2026-09-20", "2026-09-23")).length, 1, "🔴 повернення не працює");
    await assert.rejects(s.store.setIgnored(s.db, s.hr, "m1", true), (e: unknown) => (e as { status?: number }).status === 404, "🔴 привʼязану зустріч дозволено сховати");
  } finally { await s.done(); }
});

/**
 * #707 — БЕЗ КЛЮЧА — ЧЕСНИЙ ПРОПУСК, А НЕ ПОРОЖНІЙ СПИСОК; таблиця зустрічей відібрана в ai_readonly і є у
 * FORBIDDEN_TABLES. 🧨 Червоніє, якщо джоба без ключа «успішно» нічого не робить або таблиця відкрита моделі.
 */
test("#707 tl;dv: без ключа — пропуск із причиною; tldv_meetings закрита для AI", async () => {
  const prev = process.env.TLDV_API_KEY;
  delete process.env.TLDV_API_KEY;
  try {
    const { syncTldv, getTldvStatus } = await import("../jobs/syncTldv.js");
    const r = await syncTldv();
    assert.deepEqual(r, { skipped: true, reason: "немає TLDV_API_KEY — записи співбесід не забираємо" }, "🔴 без ключа джоба вдала успіх");
    assert.equal(getTldvStatus().configured, false, "🔴 стан каже «підключено» без ключа");
  } finally { if (prev) process.env.TLDV_API_KEY = prev; }
  const src = (...p: string[]) => path.join(import.meta.dirname, "..", "..", "..", "backend", "src", ...p);
  const sql = readFileSync(src("db", "schema.sql"), "utf8");
  assert.ok(sql.indexOf("REVOKE ALL ON tldv_meetings FROM ai_readonly;") > sql.indexOf("CREATE TABLE IF NOT EXISTS tldv_meetings ("), "🔴 REVOKE немає або вище за CREATE");
  assert.match(readFileSync(src("ai", "metricTools.ts"), "utf8"), /"tldv_meetings",/, "🔴 немає у FORBIDDEN_TABLES");
});
