import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #3465 — «НОВИЙ КЛІЄНТ» ПРОТИ БАЗИ З НУЛЯ (прохід 2, 04.11.2026, Даша: «перша успішна угода з клієнтом»). Перша
 * «Успішна угода» (142, повний цикл) клієнта, закрита в тижні за Києвом; друга того самого клієнта — ні (навіть в іншого
 * менеджера); однакова мить — раніший `kommo_id`; без `client_key` — окреме число; 143 і чужа воронка — ні.
 * 🧨 Червоніє, якщо друга угода клієнта рахується як перша, межа тижня — не за Києвом, або «без клієнта» мовчки зникне.
 */
test("#3465 ДИМ: новий клієнт — перша успішна угода клієнта в тижні, друга — ні, без клієнта — окремо", async (t) => {
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
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await c.query(schema);
    await c.query(schema); // міграцію CHECK накочують на кожному викаті — вона мусить бути ідемпотентною
    await c.query(`INSERT INTO teams (id,name) VALUES (13,'РНК - Тест')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (101,'Перший',13,true),(102,'Другий',13,true)`);
    const F = 8921932;
    const rows: [number, number, number, number, string, string | null][] = [
      [1, 101, F, 142, "2026-09-10T10:00Z", "A"], [2, 102, F, 142, "2026-09-16T10:00Z", "A"], // A: друга угода — не новий клієнт
      [3, 101, F, 142, "2026-09-15T10:00Z", "B"],                                             // B: перша — так
      [4, 102, F, 142, "2026-09-20T20:30Z", "C"],                                             // C: нд 23:30 Києва — у тижні
      [5, 101, F, 142, "2026-09-20T21:30Z", "D"],                                             // D: пн 00:30 Києва — поза тижнем
      [20, 101, F, 142, "2026-09-17T10:00Z", "E"], [21, 102, F, 142, "2026-09-17T10:00Z", "E"], // E: одна мить — раніший kommo_id
      [6, 101, F, 142, "2026-09-16T10:00Z", null],                                            // без клієнта — окремо
      [7, 101, F, 143, "2026-09-16T10:00Z", "F"], [8, 101, 8921928, 142, "2026-09-16T10:00Z", "G"], // програна й чужа воронка — ні
    ];
    for (const r of rows) await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo,closed_at_kommo,client_key) VALUES ($1,$2,$3,$4,0,'2026-09-01',$5,$6)`, r);
    const { firstSuccessByManager } = await import("./metrics.js");
    const r = await firstSuccessByManager({ from: "2026-09-14", to: "2026-09-20" });
    const m = (id: number) => r.rows.find((x) => x.managerId === id)?.first ?? 0;
    assert.deepEqual([m(101), m(102)], [2, 1], "🔴 перші угоди клієнтів пораховано не так (друга угода, межа тижня, одна мить, програна чи чужа воронка)");
    assert.equal(r.unknown, 1, "🔴 успішна угода без клієнта зникла або вгадана");
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
