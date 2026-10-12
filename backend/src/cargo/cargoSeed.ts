/**
 * Сід довідника в schema.sql = cargo/cargoDefaults.ts (одне джерело правди) — порт `tools/seedFromDefaults.ts` пакета.
 * Блок BEGIN SEED … END SEED у schema.sql мусить дорівнювати `seedSql()` посимвольно (гейт #1612).
 */
import { DEFAULT_PALLETS, DEFAULT_VEHICLES } from './cargoDefaults.js';

const q = (v: string | null | undefined) => v === null || v === undefined ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
const n = (v: number | null | undefined) => v === null || v === undefined ? 'NULL' : String(Math.round(v));
const js = (v: unknown) => v === null || v === undefined ? 'NULL::jsonb' : `${q(JSON.stringify(v))}::jsonb`;

export const SEED_BEGIN = '-- BEGIN SEED (= cargo/cargoDefaults.ts через cargoSeed.seedSql(); розбіжність ловить гейт #1612 — руками не правити)';
export const SEED_END = '-- END SEED';

export function seedSql(): string {
  const veh = DEFAULT_VEHICLES.map((v, i) => `  (${[q(v.id), q(v.grp), q(v.name), js(v.bodies), n(v.kg), n(v.kgMax), q(v.load), js(v.arch), q(v.src), q(v.q ?? null), String(i + 1)].join(', ')})`).join(',\n');
  const pal = DEFAULT_PALLETS.map((p, i) => `  (${[q(p.key), q(p.name), n(p.l), n(p.w), String(i + 1)].join(', ')})`).join(',\n');
  return [
    SEED_BEGIN,
    '-- Авто — лише в порожню таблицю: якщо адмін уже прибрав/змінив авто, повторний запуск міграції їх не поверне.',
    'INSERT INTO cargo_vehicles (id, grp, name, bodies, kg, kg_max, load_sides, arch, src, note, sort)',
    'SELECT * FROM (VALUES',
    veh,
    ') AS v(id, grp, name, bodies, kg, kg_max, load_sides, arch, src, note, sort)',
    'WHERE NOT EXISTS (SELECT 1 FROM cargo_vehicles);',
    '-- Палети — ключі незмінні; назви й розміри адміна не перезаписуються.',
    'INSERT INTO cargo_pallets (key, name, l, w, sort) VALUES',
    pal,
    'ON CONFLICT (key) DO NOTHING;',
    SEED_END,
  ].join('\n');
}

export function seedBlockOf(sql: string): string {
  const a = sql.indexOf(SEED_BEGIN), b = sql.indexOf(SEED_END, a);
  if (a < 0 || b < 0) throw new Error('У schema.sql немає блоку SEED конфігуратора');
  return sql.slice(a, b + SEED_END.length);
}
