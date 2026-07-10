import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { parseCsv } from "../utils/csv.js";

/**
 * «Перший дотик» (Google Sheet) → таблиця first_touch_analysis.
 * Кожен рядок = перший контакт менеджера з лідом реклами, який uts-bot
 * транскрибує (Groq Whisper) і аналізує LLM-ом. ДЖЕРЕЛО ПРАВДИ для показника
 * «озвучення ціни в перший дотик» — саме та автоматизація, що шле пуш «ціну
 * озвучено». НЕ рахуємо етап воронки «Пропозицію зроблено» (той шумний).
 * TRUNCATE+insert (як дебіторка/реєстр лідогену) — лист накопичує історію.
 * Колонки: 0 Дата · 1 Час · 2 Менеджер · 3 Команда · 4 Lead ID ·
 *          5 Ціну озвучено(так/ні) · 6 Заперечення відпрацьовано(так/ні) ·
 *          7 Розмова про перевезення
 */
const isYes = (s?: string): boolean => (s ?? "").trim().toLowerCase() === "так";
const cleanDate = (s?: string): string | null => {
  const t = (s ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

export async function syncFirstTouch(): Promise<void> {
  const res = await fetch(config.firstTouchSheetUrl);
  if (!res.ok) throw new Error(`First-touch sheet fetch failed: ${res.status}`);
  const csv = await res.text();
  const rows = parseCsv(csv);
  if (rows.length <= 1) { console.warn("syncFirstTouch: sheet empty — skipping."); return; }

  type Row = { leadId: number; date: string; priceVoiced: boolean;
    objections: boolean; transport: string; mgr: string; team: string };
  // Dedup by lead_id keeping the LAST occurrence (a re-analysed lead may repeat).
  const byLead = new Map<number, Row>();
  for (const c of rows.slice(1)) {
    const leadId = Number((c[4] ?? "").trim());
    const date = cleanDate(c[0]);
    if (!leadId || !date) continue;
    byLead.set(leadId, {
      leadId, date, priceVoiced: isYes(c[5]), objections: isYes(c[6]),
      transport: (c[7] ?? "").trim(), mgr: (c[2] ?? "").trim(), team: (c[3] ?? "").trim(),
    });
  }
  const parsed = [...byLead.values()];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE first_touch_analysis");
    const CH = 500;
    for (let i = 0; i < parsed.length; i += CH) {
      const batch = parsed.slice(i, i + CH);
      const vals: unknown[] = [];
      const tuples = batch.map((r, j) => {
        const b = j * 7;
        vals.push(r.leadId, r.date, r.priceVoiced, r.objections, r.transport, r.mgr, r.team);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
      }).join(",");
      await client.query(
        `INSERT INTO first_touch_analysis
           (lead_id, analyzed_at, price_voiced, objections_handled, about_transport, manager_name, team_name)
         VALUES ${tuples}
         ON CONFLICT (lead_id) DO UPDATE SET
           analyzed_at = EXCLUDED.analyzed_at, price_voiced = EXCLUDED.price_voiced,
           objections_handled = EXCLUDED.objections_handled, about_transport = EXCLUDED.about_transport,
           manager_name = EXCLUDED.manager_name, team_name = EXCLUDED.team_name`,
        vals
      );
    }
    await client.query("COMMIT");
    console.log(`First-touch synced: ${parsed.length} rows (${parsed.filter((r) => r.priceVoiced).length} price-voiced).`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncFirstTouch()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
