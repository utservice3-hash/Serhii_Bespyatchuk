import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 📅 «+ СПІВБЕСІДА» — наявний або новий кандидат (18.09.2026, «Графік — розклад») — гейти `#580`–`#582`.
 * Номери з запасом над `#579` — борг 17: перед мержем перемірити перетин.
 */

async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const db = c as unknown as import("./hiring.js").Db;
  const h = await import("./hiring.js");
  const vac = await h.createVacancy(db, null, { title: "Менеджер з продажу" });
  return { c, db, h, vac, done: async () => { await c.end(); s.dispose(); } };
}
const status = async (s: NonNullable<Awaited<ReturnType<typeof scratch>>>, id: number) =>
  (await s.c.query(`SELECT status FROM hiring_candidates WHERE id = $1`, [id])).rows[0].status as string;

/**
 * #580 — НОВИЙ КАНДИДАТ ІЗ ДІАЛОГУ: один кандидат «заплановано» з вакансією, рядок графіка привʼязаний;
 * той самий номер удруге — рядок для НАЯВНОГО кандидата (подія «повторний відгук»), дубля немає;
 * без ПІБ, телефону чи вакансії — 400.
 * 🧨 Червоніє, якщо прибрати пошук за телефоном або не привʼязати вакансію.
 */
test("#580 ЖИВИЙ SQL: + Співбесіда з новим кандидатом — один кандидат із вакансією, повтор номера — без дубля", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    const bad = (e: unknown) => (e as { status?: number }).status === 400;
    await assert.rejects(s.h.createInterviewFor(s.db, null, { interviewDate: "2026-09-18", newCandidate: { fullName: "Нова Олена", phone: "0501112233" } }), bad, "🔴 без вакансії прийнято");
    await assert.rejects(s.h.createInterviewFor(s.db, null, { interviewDate: "2026-09-18", newCandidate: { fullName: "Нова Олена", vacancyId: s.vac } }), bad, "🔴 без телефону прийнято");
    const a = await s.h.createInterviewFor(s.db, null, { interviewDate: "2026-09-18", interviewTime: "11:00", responsible: "Іван",
      newCandidate: { fullName: "Нова Олена", phone: "+38 (050) 111-22-33", source: "work.ua", vacancyId: s.vac } });
    assert.ok(a.candidateId && !a.repeat);
    assert.equal(await status(s, a.candidateId!), "planned");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM hiring_candidate_vacancies WHERE candidate_id = $1 AND vacancy_id = $2`, [a.candidateId, s.vac])).rows[0].n, 1, "🔴 вакансію не привʼязано");
    assert.equal((await s.c.query(`SELECT candidate_id FROM hiring_interviews WHERE id = $1`, [a.id])).rows[0].candidate_id, a.candidateId);
    const b = await s.h.createInterviewFor(s.db, null, { interviewDate: "2026-09-19", newCandidate: { fullName: "Олена Нова", phone: "0501112233", vacancyId: s.vac } });
    assert.deepEqual([b.candidateId, b.repeat], [a.candidateId, true], "🔴 той самий номер створив другого кандидата");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM hiring_candidates`)).rows[0].n, 1, "🔴 дубль кандидата");
  } finally { await s.done(); }
});

/**
 * #581 — НАЯВНИЙ КАНДИДАТ: «новий» / «недозвон» / після відмови → «заплановано» з подією в історії;
 * кандидат далі по ланцюжку (на навчанні) лишається на навчанні — співбесіда фіксується, статус ні.
 * 🧨 Червоніє, якщо статус перезаписати без перевірки ланцюжка.
 */
test("#581 ЖИВИЙ SQL: + Співбесіда з наявним — ранні етапи → «заплановано», пізні не зсуваються", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    const mk = async (name: string, phone: string, st: string) => {
      const id = await s.h.createCandidate(s.db, null, { fullName: name, phone, vacancyId: s.vac });
      await s.c.query(`UPDATE hiring_candidates SET status = $2 WHERE id = $1`, [id, st]);
      return id;
    };
    const fresh = await mk("Свіжий", "0501110001", "new"), missed = await mk("Недозвон", "0501110002", "noanswer"), learning = await mk("Навчається", "0501110003", "training");
    const r1 = await s.h.createInterviewFor(s.db, null, { interviewDate: "2026-09-18", interviewTime: "10:00", candidateId: fresh });
    assert.deepEqual([r1.moved, await status(s, fresh)], [true, "planned"], "🔴 «новий» не став «заплановано»");
    assert.ok((await s.c.query(`SELECT 1 FROM hiring_events WHERE candidate_id = $1 AND kind = 'status' AND to_status = 'planned' AND interview_id = $2`, [fresh, r1.id])).rowCount, "🔴 немає події в історії");
    assert.equal((await s.h.createInterviewFor(s.db, null, { interviewDate: "2026-09-18", candidateId: missed })).moved, true);
    const r3 = await s.h.createInterviewFor(s.db, null, { interviewDate: "2026-09-18", candidateId: learning });
    assert.deepEqual([r3.moved, await status(s, learning)], [false, "training"], "🔴 кандидата на навчанні відкотило в «заплановано»");
    assert.ok((await s.c.query(`SELECT 1 FROM hiring_interviews WHERE id = $1 AND candidate_id = $2`, [r3.id, learning])).rowCount, "🔴 співбесіду не зафіксовано");
    await assert.rejects(s.h.createInterviewFor(s.db, null, { interviewDate: "2026-09-18", candidateId: 999999 }), (e: unknown) => (e as { status?: number }).status === 404);
  } finally { await s.done(); }
});

/**
 * #582 — ЩОДЕННИЙ ЗВІТ ОДНАКОВИЙ для співбесіди з діалогу й з порожнього рядка, куди вписали ПІБ:
 * обидва шляхи дають той самий рядок графіка, звіт рахує їх однаково.
 * 🧨 Червоніє, якщо діалог писатиме співбесіду інакше (без рядка графіка чи з іншою датою).
 */
test("#582 ЖИВИЙ SQL: щоденний звіт — діалог і рядок графіка рахуються однаково", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    const empty = await s.h.createInterview(s.db, null, { interviewDate: "2026-09-18", interviewTime: "10:00" });
    await s.h.updateInterview(s.db, null, empty, { fullName: "Рядковий Петро", phone: "0501110010", vacancyId: s.vac });
    const viaRow = await s.h.dailyReport(s.db, "2026-09-18", "2026-09-18");
    await s.c.query(`DELETE FROM hiring_events; DELETE FROM hiring_interviews; DELETE FROM hiring_candidate_vacancies; DELETE FROM hiring_candidates;`);
    await s.h.createInterviewFor(s.db, null, { interviewDate: "2026-09-18", interviewTime: "10:00", newCandidate: { fullName: "Діалоговий Петро", phone: "0501110010", vacancyId: s.vac } });
    const viaDialog = await s.h.dailyReport(s.db, "2026-09-18", "2026-09-18");
    assert.deepEqual(viaDialog, viaRow, "🔴 звіт рахує діалог інакше, ніж рядок графіка");
    assert.ok(viaRow.length === 1, "дзеркало: у звіті є цей день");
  } finally { await s.done(); }
});
