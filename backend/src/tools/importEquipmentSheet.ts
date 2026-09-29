/**
 * 🗂 РАЗОВЕ ПЕРЕНЕСЕННЯ «Облік техніки 2026» у Бізнес-асистента (рішення Романа 29.09.2026).
 *
 * Правила розбору — `core/baEquipmentImport.ts` (гейт #967); тут лише мережа й запис. Консольний
 * інструмент, а не роут: разова дія, постійні двері в застосунку для неї не потрібні.
 *
 * Запуск (на сервері, у теці `backend`, після викату):
 *   node dist/tools/importEquipmentSheet.js --dry     # лише порахувати й показати, НІЧОГО не писати
 *   node dist/tools/importEquipmentSheet.js --write   # записати
 *
 * 🔴 `--dry` лише ЧИТАЄ (таблицю й реєстр співробітників).
 * 🔴 ІДЕМПОТЕНТНО: ключ одиниці — рядок таблиці (`import_key`), повторний `--write` на тій самій
 *    таблиці не дублює. Якщо таблицю між прогонами правили — спершу `--dry` і звірка.
 * Людина, яку не вдалось однозначно зіставити з реєстром, переноситься ІМЕНЕМ без звʼязку — і це
 * видно числом «не зіставлено», а не мовчки.
 */
import { pool } from "../db/pool.js";
import { parseCsv } from "../utils/csv.js";
import { parseEquipmentSheet, matchEmployee } from "../core/baEquipmentImport.js";

const SHEET_ID = "1Hsbyuz4A12v7J-qNX_7NKKLqsDyftiqngE_HJKFJ_7s";
const GID = "1329887956"; // вкладка «Облік техніки 2026»
const CSV_URL = process.env.EQUIPMENT_SHEET_CSV_URL ?? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
const WRITE = process.argv.includes("--write");
const KEY = (row: number) => `sheet-tech-2026:r${row}`;

async function main() {
  const r = await fetch(CSV_URL);
  if (!r.ok) throw new Error(`таблиця не віддалась: ${r.status}`);
  const { items, skipped } = parseEquipmentSheet(parseCsv(await r.text()));
  const employees = (await pool.query<{ id: number; full_name: string; status: string }>(
    `SELECT id, full_name, status FROM employees WHERE COALESCE(btrim(full_name), '') <> ''`)).rows;
  const reg = employees.map((e) => ({ id: e.id, fullName: e.full_name }));
  const already = new Set((await pool.query<{ import_key: string }>(
    `SELECT import_key FROM ba_equipment WHERE import_key LIKE 'sheet-tech-2026:%'`)).rows.map((x) => x.import_key));

  const withHolder = items.filter((i) => i.holderName);
  const unmatched = [...new Set(withHolder.filter((i) => matchEmployee(i.holderName!, reg) == null).map((i) => i.holderName!))];
  const dismissed = withHolder.filter((i) => {
    const id = matchEmployee(i.holderName!, reg);
    return id != null && employees.find((e) => e.id === id)?.status === "dismissed";
  });
  const fresh = items.filter((i) => !already.has(KEY(i.row)));
  console.log(`одиниць у таблиці: ${items.length} · нерозпізнаних непорожніх рядків: ${skipped}`);
  console.log(`на руках: ${withHolder.length} · вільних: ${items.length - withHolder.length}`);
  console.log(`людей: ${new Set(withHolder.map((i) => i.holderName)).size} · не зіставлено з реєстром: ${unmatched.length}${unmatched.length ? ` (${unmatched.join("; ")})` : ""}`);
  console.log(`видано звільненим (не повернено): ${dismissed.length} од.`);
  console.log(`уже перенесено раніше: ${items.length - fresh.length} · буде записано: ${fresh.length}`);
  if (!WRITE) { console.log("\n— це `--dry`: у базу НЕ записано нічого. Запис: --write"); await pool.end(); return; }

  const c = await pool.connect();
  let written = 0, issues = 0;
  try {
    await c.query("BEGIN");
    for (const i of fresh) {
      const ins = await c.query<{ id: number }>(
        `INSERT INTO ba_equipment (inv_no, kind, model, purchased_on, price, purchase_url, location, comment, import_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (import_key) DO NOTHING RETURNING id`,
        [i.invNo, i.kind, i.model, i.purchasedOn, i.price, i.purchaseUrl, i.location, i.comment, KEY(i.row)]);
      const id = ins.rows[0]?.id;
      if (!id) continue;
      written++;
      await c.query(`INSERT INTO ba_events (owner_kind, owner_id, actor_id, what) VALUES ('equipment', $1, NULL, $2)`,
        [id, `Перенесено з таблиці «Облік техніки 2026», рядок ${i.row}`]);
      if (i.holderName) {
        await c.query(`INSERT INTO ba_equipment_issues (equipment_id, employee_id, holder_name, issued_on) VALUES ($1,$2,$3,$4)`,
          [id, matchEmployee(i.holderName, reg), i.holderName, i.movedOn]);
        issues++;
      }
    }
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  console.log(`✅ записано одиниць: ${written} · видач: ${issues}`);
  await pool.end();
}

main().catch(async (e) => { console.error("🔴", (e as Error).message); await pool.end().catch(() => undefined); process.exit(1); });
