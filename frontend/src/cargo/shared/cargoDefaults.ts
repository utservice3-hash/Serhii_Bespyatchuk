/**
 * Довідник «стандарт» — затверджений Сергієм 09–12.10 (раунди інтерв'ю 1–5). Джерело правди для сіду БД
 * (migrations/001_cargo_configurator.sql генерується з цього файлу: npx tsx tools/seedFromDefaults.ts --write)
 * і для кнопки адміна «Повернути стандарт».
 *
 * kg — нижня межа вантажопідйомності, kgMax — верхня (перевізники рахують по-різному: буси 2–2,5 т).
 * Арки бусів — ОРІЄНТОВНІ (у відкритих кресленнях довжини й положення немає; чекаємо замір від Сергія).
 */
import type { ArchSpec, Body, Pallet } from './cargoEngine.js';

export interface Vehicle {
  id: string; grp: string; name: string;
  bodies: Body[];                  // 1 кузов, у зчіпки — 2
  kg: number | null; kgMax: number | null;
  load: string;                    // «ззаду, збоку, зверху» — лише позначка, на розкладку не впливає (рішення 09.10)
  arch: ArchSpec | null;           // колісні арки (буси)
  src: string;                     // звідки цифри
  q?: string | null;               // що ще уточнити
}
export interface PalletRow extends Pallet { key: string }

export const DEFAULT_VEHICLE_ID = 't10';

export const DEFAULT_VEHICLES: Vehicle[] = [
  { id: 'spr-l3', grp: 'Буси', name: 'Mercedes Sprinter L3 H2', bodies: [{ L: 4307, W: 1787, H: 1974 }], kg: 2000, kgMax: 2500, load: 'ззаду, збоку', arch: { between: 1350, len: 1000, x: 2270, h: 300 }, src: 'vanguide.co.uk; т — Сергій', q: 'арки орієнтовно' },
  { id: 'spr-l4', grp: 'Буси', name: 'Mercedes Sprinter L4 H2', bodies: [{ L: 4707, W: 1787, H: 1974 }], kg: 2000, kgMax: 2500, load: 'ззаду, збоку', arch: { between: 1350, len: 1000, x: 2270, h: 300 }, src: 'vanguide.co.uk; т — Сергій', q: 'арки орієнтовно' },
  { id: 'master', grp: 'Буси', name: 'Renault Master L3H2', bodies: [{ L: 3855, W: 1789, H: 1885 }], kg: 930, kgMax: 1290, load: 'ззаду, збоку', arch: { between: 1380, len: 1000, x: 2250, h: 300 }, src: 'листівка Renault UA', q: 'арки орієнтовно' },
  { id: 'master-tent', grp: 'Буси', name: 'Renault Master бус-тент', bodies: [{ L: 4800, W: 2200, H: 2500 }], kg: 2000, kgMax: 2500, load: 'ззаду, збоку, зверху', arch: null, src: 'Сергій' },
  { id: 't3', grp: 'Вантажівки', name: '3 т', bodies: [{ L: 4200, W: 2200, H: 2200 }], kg: 3000, kgMax: null, load: 'ззаду, збоку', arch: null, src: 'Lardi-Trans' },
  { id: 't5', grp: 'Вантажівки', name: '5 т', bodies: [{ L: 6200, W: 2450, H: 2400 }], kg: 5000, kgMax: null, load: 'ззаду, збоку', arch: null, src: 'Lardi-Trans' },
  { id: 't10', grp: 'Вантажівки', name: '10 т', bodies: [{ L: 7200, W: 2450, H: 2500 }], kg: 10000, kgMax: null, load: 'ззаду, збоку, зверху', arch: null, src: 'Lardi-Trans, cargolinked' },
  { id: 'tent', grp: 'Фури', name: 'Тент 13,6 м', bodies: [{ L: 13600, W: 2450, H: 2700 }], kg: 20000, kgMax: null, load: 'ззаду, збоку, зверху', arch: null, src: 'Lardi-Trans, DHL, Samskip' },
  { id: 'mega', grp: 'Фури', name: 'Мега 13,6 м', bodies: [{ L: 13600, W: 2450, H: 3000 }], kg: 22000, kgMax: null, load: 'ззаду, збоку, зверху', arch: null, src: 'cargolinked, DHL; т — Сергій' },
  { id: 'ref', grp: 'Фури', name: 'Реф 13,3 м', bodies: [{ L: 13300, W: 2450, H: 2600 }], kg: 22000, kgMax: null, load: 'ззаду', arch: null, src: 'cargolinked, DHL; т — Сергій' },
  { id: 'jumbo', grp: 'Фури', name: 'Зчіпка 7,7 + 7,7 м', bodies: [{ L: 7700, W: 2450, H: 3000 }, { L: 7700, W: 2450, H: 3000 }], kg: 22000, kgMax: null, load: 'ззаду, збоку, зверху', arch: null, src: 'Lardi-Trans; т — Сергій', q: 'довжини кузовів' },
  { id: 'c20', grp: 'Контейнери', name: "Контейнер 20'", bodies: [{ L: 5902, W: 2352, H: 2385 }], kg: 25000, kgMax: null, load: 'ззаду', arch: null, src: 'containerexchanger' },
  { id: 'c40', grp: 'Контейнери', name: "Контейнер 40'", bodies: [{ L: 11960, W: 2350, H: 2390 }], kg: 26600, kgMax: null, load: 'ззаду', arch: null, src: 'containerexchanger' },
];

/** Палети (ключі незмінні — на них посилаються позиції й історія; адмін править назву й розміри). */
export const DEFAULT_PALLETS: PalletRow[] = [
  { key: 'euro', l: 1200, w: 800, name: 'Євро 1,2×0,8' },
  { key: 'amer', l: 1200, w: 1200, name: 'Американка 1,2×1,2' },
  { key: 'finn', l: 1200, w: 1000, name: 'Фінська 1,2×1,0' },
  { key: 'half', l: 800, w: 600, name: 'Напівпалета 0,8×0,6' },
  { key: 'square', l: 1000, w: 1000, name: 'Квадратна 1,0×1,0' },
];
export const palletMap = (rows: PalletRow[]): Record<string, Pallet> => Object.fromEntries(rows.map(p => [p.key, { l: p.l, w: p.w, name: p.name }]));
