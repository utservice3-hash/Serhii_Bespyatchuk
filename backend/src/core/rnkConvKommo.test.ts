import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #919 — КОНВЕРСІЯ РНК «ЯК У KOMMO» ПРОТИ БАЗИ З НУЛЯ (29.09.2026, рішення Романа — «рахуй як я надіслав»).
 * Кожна межа трьох фільтрів власника — з прикладом ПО ОБИДВА БОКИ (правило 11):
 * «Не цільові» Кваліфікації — у «всього», не в цільових; інша стадія Кваліфікації — цільова; джерело поза списком і
 * порожнє — не рахуються, але видні в `outside`; межа тижня — за Києвом; чужа воронка — ні; успіх — ПОТОЧНИЙ етап
 * зі списку («Контроль перед завантаженням» так, «Виставлення рахунку» ні) з «Датою загрузки» в тижні; дві
 * реактивації — лише в успіху; успіх у Кваліфікації — ні.
 */
test("#919 ДИМ: конверсія РНК як у Kommo — всього, цільові, успіх за фільтрами власника, обидва боки кожної межі", async (t) => {
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
    await c.query(`INSERT INTO teams (id,name) VALUES (13,'РНК - Тест')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (101,'Андрусенко',13,true),(102,'Цалко',13,true),(103,'Порожній',13,true)`);
    const Q = 8921928, F = 8921932;
    const rows: [number, number, number, number, string, string | null, string | null][] = [
      // id, менеджер, воронка, етап, створено, джерело, дата загрузки
      [1, 101, F, 69693668, "2026-09-15T09:00Z", "uts.ua", null],                    // цільова
      [2, 101, Q, 143, "2026-09-15T09:00Z", "yalogist.com.ua", null],                 // лише «всього» (Не цільові)
      [3, 101, Q, 69693648, "2026-09-16T09:00Z", "Холодная база", null],              // цільова (ще в Кваліфікації)
      [4, 101, F, 69693668, "2026-09-16T09:00Z", "Google", null],                     // поза списком → outside
      [5, 101, F, 69693668, "2026-09-16T09:00Z", null, null],                         // порожнє → outside
      [6, 101, F, 69693668, "2026-09-20T21:30Z", "uts.ua", null],                     // пн 21.09 00:30 Києва — наступний тиждень
      [7, 101, 155304, 69693668, "2026-09-15T09:00Z", "uts.ua", null],                // чужа воронка
      [8, 101, F, 69693668, "2026-09-20T20:30Z", "uts.ua", null],                     // нд 20.09 23:30 Києва — цей тиждень
      [11, 101, F, 69716260, "2026-09-01T09:00Z", "uts.ua", "2026-09-16T08:00Z"],     // успіх: Контроль перед завантаженням
      [12, 101, F, 100274340, "2026-09-01T09:00Z", "uts.ua", "2026-09-16T08:00Z"],    // НЕ успіх: Виставлення рахунку
      [13, 101, F, 142, "2026-09-01T09:00Z", "uts.ua", "2026-09-20T21:30Z"],          // НЕ успіх: загрузка пн 21.09 за Києвом
      [14, 101, F, 69716460, "2026-09-01T09:00Z", "Реактивація закриті", "2026-09-17T08:00Z"], // успіх (реактивація — лише тут)
      [15, 101, F, 142, "2026-09-15T09:00Z", "Реактивація закриті", "2026-09-17T08:00Z"],      // успіх; у «всього» — ні (outside)
      [16, 101, Q, 142, "2026-09-01T09:00Z", "uts.ua", "2026-09-17T08:00Z"],          // НЕ успіх: Кваліфікація
      [17, 102, F, 142, "2026-09-01T09:00Z", "uts.ua", "2026-09-16T08:00Z"],          // успіх іншого менеджера
      [18, 101, F, 142, "2026-09-01T09:00Z", "uts.ua", "2026-09-13T20:30Z"],          // загрузка нд 13.09 23:30 — минулий тиждень
    ];
    for (const r of rows) {
      await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo,client_source,load_at) VALUES ($1,$2,$3,$4,0,$5,$6,$7)`, r);
    }
    const { rnkConvAsKommo } = await import("./metrics.js");
    const r = await rnkConvAsKommo({ from: "2026-09-14", to: "2026-09-20" }, [101, 102, 103]);
    const m = (id: number) => r.rows.find((x) => x.managerId === id)!;
    assert.deepEqual([m(101).total, m(101).target], [4, 3], "🔴 «всього / цільові» не за фільтром (Не цільові, чужа воронка, межа тижня за Києвом чи джерело)");
    assert.equal(m(101).won, 3, "🔴 успіх не за фільтром (поточний етап, «Дата загрузки» в тижні, реактивації, лише Повний цикл)");
    assert.deepEqual([m(102).total, m(102).target, m(102).won], [0, 0, 1], "🔴 успіх одного менеджера перейшов іншому");
    assert.deepEqual([m(103).total, m(103).target, m(103).won], [0, 0, 0], "🔴 менеджер без угод має не нулі або зник");
    assert.equal(r.outside, 3, "🔴 друге число (джерело порожнє чи поза списком) не рахує те, що фільтр відкинув");
    assert.deepEqual(await rnkConvAsKommo({ from: "2026-09-14", to: "2026-09-20" }, []), { rows: [], outside: 0 });
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
