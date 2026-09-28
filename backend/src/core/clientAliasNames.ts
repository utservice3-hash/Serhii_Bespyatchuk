/**
 * 🔗 ХТО ПРИЄДНАНИЙ ДО КЛІЄНТА — для рядка «обʼєднано: …» (ТЗ Юлі 22.09.2026, блок 2,
 * п.2.3; задача 4311: «обʼєднані: один рядок, під назвою приєднані з позначкою
 * „обʼєднано“, план один, задача одна, факт сумується»).
 *
 * План, задача й факт уже зведені: обʼєднаний клієнт на екрані і є ОДИН рядок, бо все
 * рахується по канонічному `client_key`. Бракувало лише видимості — хто саме в цьому
 * рядку. Звідси цей модуль, і він НІЧОГО не рахує в грошах.
 *
 * 🔴 НАЗВА — З УГОД САМОГО ПРИЄДНАНОГО (`client_key_raw`), а не канонічна: канонічна
 * однакова для всіх рядків групи, і список «Смар Текс, Смар Текс, Смар Текс» нічого б
 * не пояснив. Угоди без назви — сирий ключ, щоб рядок не був порожнім (невідоме
 * читається як невідоме).
 *
 * 🔴 ЛИШЕ АКТИВНІ ОБʼЄДНАННЯ (`revoked_at IS NULL`). Відкликане показане як «обʼєднано»
 * стверджувало б протилежне тому, що рахує екран.
 */

export interface AliasName {
  key: string;
  name: string;
  /** Оплачених угод під цим записом — щоб у картці було видно вагу кожного. */
  paid: number;
}

/** Один текст на роут і на гейт: `$1` — масив канонічних ключів. */
export const ALIAS_NAMES_SQL = `
  SELECT a.canonical_key, a.alias_key,
         COALESCE(NULLIF(btrim(nm.client_name), ''), a.alias_key) AS name,
         COALESCE(pc.paid, 0)::int AS paid
    FROM client_key_alias a
    LEFT JOIN LATERAL (
      SELECT d.client_name FROM deals d
       WHERE d.client_key_raw = a.alias_key AND d.client_name IS NOT NULL
       ORDER BY d.created_at_kommo DESC NULLS LAST LIMIT 1) nm ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS paid FROM deals d
        JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.client_key_raw = a.alias_key AND psm.funnel_stage = 'paid') pc ON true
   WHERE a.revoked_at IS NULL AND a.canonical_key = ANY($1)
   ORDER BY a.canonical_key, paid DESC, name`;

export function groupAliasRows(rows: { canonical_key: string; alias_key: string; name: string; paid: number }[]): Map<string, AliasName[]> {
  const out = new Map<string, AliasName[]>();
  for (const r of rows) {
    const list = out.get(r.canonical_key) ?? [];
    list.push({ key: r.alias_key, name: r.name, paid: Number(r.paid) });
    out.set(r.canonical_key, list);
  }
  return out;
}

export async function aliasNamesFor(keys: string[]): Promise<Map<string, AliasName[]>> {
  if (keys.length === 0) return new Map();
  // Лінивий імпорт пулу: `config.js` кидає без DATABASE_URL ще на імпорті, а чисту частину
  // модуля гейт перевіряє без бази.
  const { pool } = await import("../db/pool.js");
  const r = await pool.query<{ canonical_key: string; alias_key: string; name: string; paid: number }>(ALIAS_NAMES_SQL, [keys]);
  return groupAliasRows(r.rows);
}
