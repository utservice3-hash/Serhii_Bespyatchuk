import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { parseCsv } from "../utils/csv.js";

/**
 * «Реєстр» лідоген-бота (Google Sheet) → таблиця leadgen_registry.
 * Кожен рядок = вхід ліда в «Нова заявка від лідогенератора» (69716164) —
 * ДЖЕРЕЛО ПРАВДИ для «переданих заявок» (наш lead_transfer_events рахував
 * зміни відповідального і завищував у рази). TRUNCATE+insert (як дебіторка).
 * Дати з аркуша — київські локальні («YYYY-MM-DD HH:MM:SS»), зберігаємо як
 * timestamptz через `AT TIME ZONE 'Europe/Kyiv'`, щоб фільтри періоду збігались.
 * Колонки: 0 Lead ID · 1 Назва · 2 Менеджер · 3 Команда · 4 Час передачі ·
 *          5 Час взяття · 6 Перший дзвінок · 7 Час реакції(хв) · 8 До дзвінка(хв)
 */
const cleanTs = (s?: string): string | null => {
  const t = (s ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t) ? t : null;
};
const cleanNum = (s?: string): number | null => {
  const t = (s ?? "").trim().replace(",", ".");
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : null;
};

export async function syncLeadgenRegistry(): Promise<void> {
  const res = await fetch(config.leadgenRegistrySheetUrl);
  if (!res.ok) throw new Error(`Leadgen registry sheet fetch failed: ${res.status}`);
  const csv = await res.text();
  const rows = parseCsv(csv);
  if (rows.length <= 1) { console.warn("syncLeadgenRegistry: sheet empty — skipping."); return; }

  type Row = { leadId: number; name: string; mgr: string; team: string; transferred: string;
    taken: string | null; call: string | null; reaction: number | null; toCall: number | null };
  const parsed: Row[] = [];
  const seen = new Set<string>();
  for (const c of rows.slice(1)) {
    const leadId = Number((c[0] ?? "").trim());
    const transferred = cleanTs(c[4]);
    if (!leadId || !transferred) continue;
    const key = `${leadId}|${transferred}`;
    if (seen.has(key)) continue; // guard identical PK rows within the file
    seen.add(key);
    parsed.push({
      leadId, name: (c[1] ?? "").trim(), mgr: (c[2] ?? "").trim(), team: (c[3] ?? "").trim(),
      transferred, taken: cleanTs(c[5]), call: cleanTs(c[6]), reaction: cleanNum(c[7]), toCall: cleanNum(c[8]),
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE leadgen_registry");
    const CH = 500;
    for (let i = 0; i < parsed.length; i += CH) {
      const batch = parsed.slice(i, i + CH);
      const vals: unknown[] = [];
      const tuples = batch.map((r, j) => {
        const b = j * 9;
        vals.push(r.leadId, r.name, r.mgr, r.team, r.transferred, r.taken, r.call, r.reaction, r.toCall);
        const kyiv = (n: number) => `$${n}::timestamp AT TIME ZONE 'Europe/Kyiv'`;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},${kyiv(b + 5)},${kyiv(b + 6)},${kyiv(b + 7)},$${b + 8},$${b + 9})`;
      }).join(",");
      await client.query(
        `INSERT INTO leadgen_registry
           (lead_id, lead_name, manager_name, team_name, transferred_at, taken_at, first_call_at, reaction_min, time_to_call_min)
         VALUES ${tuples} ON CONFLICT (lead_id, transferred_at) DO NOTHING`,
        vals
      );
    }
    await client.query("COMMIT");
    console.log(`Leadgen registry synced: ${parsed.length} rows.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncLeadgenRegistry()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
