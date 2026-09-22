import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🎯 #653 / #653b — ТАБЛИЦІ AI-АНАЛІЗУ ДЗВІНКІВ (ТЗ 22.09.2026, прохід A, коміт ②).
 *
 * 🔴 ПЕРЕЛІК ТАБЛИЦЬ — З САМОГО БЛОКУ СХЕМИ, а не рукописним списком (правило 12 кореневого
 * CLAUDE.md: перелічувач пишеться від предмета). Нова таблиця в блоці без REVOKE чи без запису
 * в `FORBIDDEN_TABLES` червоніє, навіть якщо про неї забули в цьому файлі.
 */
const SCHEMA = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "db", "schema.sql"), "utf8");
const BEGIN = "-- ▼ AI-АНАЛІЗ ДЗВІНКІВ ПО РЕКЛАМНИХ ЛІДАХ";
const END = "-- ▲ AI-АНАЛІЗ ДЗВІНКІВ ▲";

function blockTables(): { block: string; tables: string[]; blockStart: number } {
  const a = SCHEMA.indexOf(BEGIN), b = SCHEMA.indexOf(END);
  assert.ok(a > 0 && b > a, "🔴 маркерів блоку AI-аналізу в schema.sql немає — перелічувач осліп");
  const block = SCHEMA.slice(a, b);
  const tables = [...block.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map((m) => m[1]);
  return { block, tables, blockStart: a };
}

test("#653 AI-АНАЛІЗ: кожна таблиця блоку відібрана в ai_readonly після CREATE і є у FORBIDDEN_TABLES", () => {
  const { block, tables, blockStart } = blockTables();
  assert.ok(tables.length >= 3, `🔴 у блоці ${String(tables.length)} таблиць — очікувано щонайменше три`);
  const grantAt = SCHEMA.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;");
  assert.ok(grantAt > 0 && grantAt < blockStart, "🔴 блок стоїть ВИЩЕ загального GRANT — REVOKE перекриється видачею");
  const forbidden = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "ai", "metricTools.ts"), "utf8");
  for (const t of tables) {
    const created = block.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
    const revoked = block.indexOf(`REVOKE ALL ON ${t} FROM ai_readonly;`);
    assert.ok(revoked > created, `🔴 ${t}: REVOKE немає або стоїть вище за CREATE`);
    assert.match(forbidden, new RegExp(`"${t}"[,\\s]`), `🔴 ${t}: немає у FORBIDDEN_TABLES`);
  }
});

/**
 * #653b — ЖИВА СХЕМА (scratch): схема накочується двічі (ідемпотентність міграції); для КОЖНОЇ
 * таблиці блоку `ai_readonly` не має SELECT, а на звичайну (`deals`) має — дзеркало, інакше гейт
 * зеленів би й тоді, коли роль мертва; стан рядка не буває NULL чи довільним; дубль
 * «дзвінок + постачальник + модель» неможливий; вартість у журналі рахується з одиниць і ціни,
 * а без ціни — NULL, а не нуль.
 */
test("#653b AI-АНАЛІЗ · ЖИВА СХЕМА: двічі накочується, закрито для AI, стан обовʼязковий, дубль неможливий", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(SCHEMA);
    await c.query(SCHEMA);
    const { tables } = blockTables();
    for (const tb of tables) {
      const r = await c.query<{ ok: boolean }>("SELECT has_table_privilege('ai_readonly', $1, 'SELECT') AS ok", [tb]);
      assert.equal(r.rows[0].ok, false, `🔴 ai_readonly читає ${tb}`);
    }
    const mirror = await c.query<{ ok: boolean }>("SELECT has_table_privilege('ai_readonly', 'deals', 'SELECT') AS ok");
    assert.equal(mirror.rows[0].ok, true, "🔴 ai_readonly не читає навіть deals — перевірка вище нічого не доводить");

    await c.query("INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES ('u1','elevenlabs','scribe_v2','queued')");
    await assert.rejects(c.query("INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES ('u1','elevenlabs','scribe_v2','queued')"),
      /duplicate key/, "🔴 другий рядок на той самий дзвінок, постачальника й модель пройшов — повтор заплатив би двічі");
    await assert.rejects(c.query("INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES ('u2','elevenlabs','scribe_v2',NULL)"),
      /null value|violates/, "🔴 стан NULL пройшов");
    await assert.rejects(c.query("INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES ('u3','elevenlabs','scribe_v2','ok')"),
      /check constraint/, "🔴 довільний стан пройшов");
    await c.query("INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES ('u1','elevenlabs','scribe_v3','queued')");
    const tid = (await c.query<{ id: string }>("SELECT id FROM call_transcripts WHERE uniqueid='u1' AND model='scribe_v2'")).rows[0].id;
    await c.query("INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status) VALUES ($1,'google','g','v1','queued')", [tid]);
    await assert.rejects(c.query("INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status) VALUES ($1,'google','g','v1','queued')", [tid]),
      /duplicate key/, "🔴 другий аналіз тієї самої розшифровки тією самою моделлю й рубрикою пройшов");
    await c.query("INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status) VALUES ($1,'google','g','v2','queued')", [tid]);

    const l = await c.query<{ usd: string | null }>(`INSERT INTO ai_spend_ledger(provider,operation,units,unit,unit_price_usd)
      VALUES ('elevenlabs','stt',120,'audio_sec',0.0000611), ('google','analysis',1000,'input_tokens',NULL) RETURNING usd`);
    assert.ok(Math.abs(Number(l.rows[0].usd) - 120 * 0.0000611) < 1e-12, `🔴 вартість не з одиниць і ціни: ${String(l.rows[0].usd)}`);
    assert.equal(l.rows[1].usd, null, "🔴 без ціни вартість мусить бути NULL, а не 0");
    await assert.rejects(c.query("INSERT INTO ai_spend_ledger(provider,operation,units,unit) VALUES ('x','stt',-1,'audio_sec')"),
      /check constraint/, "🔴 відʼємні одиниці пройшли");
  } finally {
    await c.end().catch(() => {});
    scratch.dispose();
  }
});
