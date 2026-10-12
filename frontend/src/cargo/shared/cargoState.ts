/**
 * Що зберігається в історії розрахунків і як це перевіряється (і на фронті, і на сервері — один код).
 * Розрахунок = вхідні дані (CalcState) + розкладка (SavedLayout: ручні пересування, наявний вантаж на схемі, режим точок).
 * Відкриття з історії: рушій розкладає state заново, потім (якщо manual) поверх ставляться збережені позиції — як у макеті.
 */
import type { ArchSpec, Body, ExistingSpec, Item, Obstacle } from './cargoEngine.js';
import { fM, fV } from './cargoFormat.js';

export interface CalcState {
  veh: string;                       // id авто з довідника або 'custom'
  bodies: Body[];
  kg: number | null; kgMax: number | null;
  arch?: ArchSpec | null;            // знімок арок на момент розрахунку (довідник може змінитись)
  ex: ExistingSpec;                  // «вже в авто» (+ kg, + stop)
  items: Item[];
  gap: number;                       // зазор, мм
  multi: boolean;                    // «Кілька точок»
  stops: Record<string, string>;     // { '1': 'Львів', '2': 'Київ' }
}
export interface SavedPlacement { uid: string; x: number; y: number; l: number; w: number; body: number; rotated?: boolean }
export interface SavedLayout { placed: SavedPlacement[]; exr: Obstacle[][]; manual: boolean; mode: 'auto' | 'dense' }
export interface HistoryRow { id: string; userId: string; userName: string; createdAt: string; vehicle: string; items: string; fit: boolean | null }
export interface HistoryEntry extends HistoryRow { state: CalcState; layout: SavedLayout | null }
export interface HistoryList { rows: HistoryRow[]; scope: 'all' | 'own' }

/** Рядок історії: «Тент 13,6 м» + «5 × палети євро, гофра 12,0 м³». vehicleName — з довідника (або розміри, якщо свої). */
export function summarize(state: CalcState, vehicleName?: string | null): { vehicle: string; items: string } {
  const b = state.bodies[0];
  const items = state.items.map(i => i.kind === 'bulk' ? `${(i.name || '').toLowerCase()} ${fV(+(i.m3 || 0) || 0)} м³` : `${i.qty || 0} × ${(i.name || '').toLowerCase()}`).join(', ');
  return { vehicle: vehicleName || `${fM(b.L)} × ${fM(b.W)} × ${fM(b.H)} м`, items: items || 'вільне місце' };
}

// ---------- перевірка (повертає текст помилки українською або null) ----------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v: unknown, a: number, b: number) => typeof v === 'number' && Number.isInteger(v) && v >= a && v <= b;
const numIn = (v: unknown, a: number, b: number) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
const optNum = (v: unknown, a: number, b: number) => v === undefined || v === null || numIn(v, a, b);
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const optStr = (v: unknown, max: number) => v === undefined || v === null || str(v, max);
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean';

const KINDS = ['pallet', 'bigbag', 'box', 'long', 'roll', 'barrel', 'bulk'];
const VARS = ['auto', 'along', 'across', 'stand', 'lieX', 'lieY'];
const EX_MODES = ['empty', 'pallets', 'meters', 'volume', 'dims'];
const EX_KINDS = ['occupied', 'free', 'm3', 'pct'];
const MM = 30000;

export function checkBodies(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > 2) return 'Кузовів має бути 1 або 2';
  for (const b of v) if (!isObj(b) || !intIn(b.L, 300, MM) || !intIn(b.W, 300, 4000) || !intIn(b.H, 300, 5000)) return 'Розміри кузова — цілі мм: довжина 0,3–30 м, ширина 0,3–4 м, висота 0,3–5 м';
  return null;
}
export function checkArch(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || !intIn(v.between, 0, 4000) || !intIn(v.len, 0, 5000) || !intIn(v.x, 0, MM) || !intIn(v.h, 0, 3000)) return 'Арки: між арками, довжина, відстань від кабіни, висота — цілі мм';
  return null;
}
export function checkVehicle(v: unknown): string | null {
  if (!isObj(v)) return 'Авто: очікується об’єкт';
  if (typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(v.id)) return 'Авто: id — латиниця, цифри, «-», до 40 символів';
  if (!str(v.name, 80) || !(v.name as string).trim()) return 'Авто: назва 1–80 символів';
  if (!str(v.grp, 40) || !(v.grp as string).trim()) return 'Авто: група 1–40 символів';
  const b = checkBodies(v.bodies); if (b) return `${v.name}: ${b}`;
  if (!(v.kg === null || intIn(v.kg, 0, 100000)) || !(v.kgMax === null || v.kgMax === undefined || intIn(v.kgMax, 0, 100000))) return `${v.name}: вантажопідйомність — ціле число кг`;
  const a = checkArch(v.arch); if (a) return `${v.name}: ${a}`;
  if (!str(v.load, 80) || !str(v.src, 200) || !optStr(v.q, 120)) return `${v.name}: задовгий текст`;
  return null;
}
export function checkVehicles(list: unknown): string | null {
  if (!Array.isArray(list) || list.length < 1 || list.length > 200) return 'Авто: від 1 до 200';
  const ids = new Set<string>();
  for (const v of list) { const e = checkVehicle(v); if (e) return e; const id = (v as Obj).id as string; if (ids.has(id)) return `Авто: повторюється id ${id}`; ids.add(id); }
  return null;
}
export function checkPalletRows(list: unknown, knownKeys: string[]): string | null {
  if (!Array.isArray(list)) return 'Палети: очікується список';
  for (const p of list) {
    if (!isObj(p) || typeof p.key !== 'string' || !knownKeys.includes(p.key)) return 'Палети: невідомий тип';
    if (!str(p.name, 60) || !(p.name as string).trim()) return 'Палети: назва 1–60 символів';
    if (!intIn(p.l, 100, 5000) || !intIn(p.w, 100, 5000)) return `${p.name}: розміри — цілі мм, 0,1–5 м`;
  }
  return null;
}

function checkItem(it: unknown): string | null {
  if (!isObj(it)) return 'Позиція: очікується об’єкт';
  if (!str(it.id, 40) || !KINDS.includes(it.kind as string) || !str(it.name, 120)) return 'Позиція: id, вид, назва';
  if (!optNum(it.c, 1, 8) || !optNum(it.qty, 0, 10000) || !optNum(it.kg, 0, 100000) || !optNum(it.stop, 0, 6)) return `«${it.name}»: кількість, вага, точка`;
  for (const k of ['l', 'w', 'h', 'd', 'len', 'hgt']) if (!optNum(it[k], 0, MM)) return `«${it.name}»: розміри`;
  if (!optNum(it.m3, 0, 1000) || !optStr(it.ptype, 20)) return `«${it.name}»: об’єм або тип палети`;
  if (!optBool(it.onPallet) || !optBool(it.stack) || !optBool(it.top)) return `«${it.name}»: галочки`;
  if (it.variant !== undefined && !VARS.includes(it.variant as string)) return `«${it.name}»: варіант розкладки`;
  return null;
}
function checkExisting(x: unknown): string | null {
  if (!isObj(x) || !EX_MODES.includes(x.mode as string)) return 'Вже в авто: невідомий спосіб';
  if (x.kind !== undefined && !EX_KINDS.includes(x.kind as string)) return 'Вже в авто: невідомий вид';
  for (const k of ['qty', 'h', 'l', 'w', 'all', 's1', 's2']) if (!optNum(x[k], 0, MM)) return 'Вже в авто: числа';
  if (!optNum(x.splitY, 0, 4000) || !optNum(x.m3, 0, 1000) || !optNum(x.pct, 0, 100) || !optNum(x.kg, 0, 100000) || !optNum(x.stop, 0, 6)) return 'Вже в авто: числа';
  if (!optStr(x.type, 20) || !optBool(x.split)) return 'Вже в авто: тип';
  if (x.rows !== undefined) {
    if (!Array.isArray(x.rows) || x.rows.length > 50) return 'Вже в авто: до 50 рядків';
    for (const r of x.rows) if (!isObj(r) || !numIn(r.l, 0, MM) || !numIn(r.w, 0, MM) || !numIn(r.h, 0, MM) || !numIn(r.qty, 0, 10000) || !optNum(r.stop, 0, 6)) return 'Вже в авто: рядок розмірів';
  }
  return null;
}
export function checkCalcState(s: unknown): string | null {
  if (!isObj(s)) return 'Розрахунок: очікується об’єкт';
  if (!str(s.veh, 40)) return 'Розрахунок: авто';
  const b = checkBodies(s.bodies); if (b) return b;
  if (!(s.kg === null || numIn(s.kg, 0, 100000)) || !(s.kgMax === null || s.kgMax === undefined || numIn(s.kgMax, 0, 100000))) return 'Вантажопідйомність';
  const a = checkArch(s.arch); if (a) return a;
  const e = checkExisting(s.ex); if (e) return e;
  if (!Array.isArray(s.items) || s.items.length > 60) return 'Позицій — до 60';
  for (const it of s.items) { const m = checkItem(it); if (m) return m; }
  if (!numIn(s.gap, 0, 1000) || typeof s.multi !== 'boolean') return 'Зазор / точки';
  if (!isObj(s.stops) || Object.entries(s.stops).some(([k, v]) => !/^[1-6]$/.test(k) || !str(v, 60))) return 'Точки: номер 1–6 і місто до 60 символів';
  return null;
}
export function checkLayout(l: unknown): string | null {
  if (l === null || l === undefined) return null;
  if (!isObj(l) || !Array.isArray(l.placed) || !Array.isArray(l.exr) || typeof l.manual !== 'boolean' || !['auto', 'dense'].includes(l.mode as string)) return 'Розкладка: формат';
  if (l.placed.length > 20000 || l.exr.length > 2) return 'Розкладка: забагато місць';
  for (const p of l.placed) if (!isObj(p) || !str(p.uid, 60) || ![p.x, p.y, p.l, p.w].every(v => numIn(v, 0, MM)) || !intIn(p.body, 0, 1)) return 'Розкладка: місце';
  for (const list of l.exr) {
    if (!Array.isArray(list) || list.length > 2000) return 'Розкладка: наявний вантаж';
    for (const o of list) if (!isObj(o) || ![o.x, o.y, o.l, o.w].every(v => numIn(v, 0, MM)) || !optNum(o.h, 0, 5000) || !optNum(o.stop, 0, 6) || !optStr(o.label, 40)) return 'Розкладка: наявний вантаж';
  }
  return null;
}
