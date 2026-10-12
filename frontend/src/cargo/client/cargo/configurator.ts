/**
 * «Конфігуратор вантажу в авто» — вкладка екрана «Калькулятор ставок та вантажу».
 *
 * Фреймворк-незалежний модуль: mountCargoConfigurator(root, opts) малює все всередині root і повертає
 * { destroy, setUser, applyExample }. React-обгортка — CargoConfiguratorTab.tsx.
 * З ЦЬОГО САМОГО коду зібрано макет v3 (mockup/konfigurator-vantazhu.html) — поведінка 1:1 із затвердженою Сергієм.
 *
 * Дані: довідник авто/палет і історія — через opts.api (client/cargo/api.ts → /api/cargo/*).
 * Права: «Довідник» бачить і редагує лише адмін; історію адмін бачить усю, решта — свою (фільтрує сервер).
 * Глобальні слухачі (document click/keydown, тема, ResizeObserver) знімаються в destroy().
 */
import * as E from '../../shared/cargoEngine';
import type { AnalyzeResult, ArchSpec, Body, ExistingSpec, Item, ItemKind, Obstacle, Placed, Rect, Variant } from '../../shared/cargoEngine';
import { DEFAULT_PALLETS, DEFAULT_VEHICLE_ID, DEFAULT_VEHICLES, palletMap, type PalletRow, type Vehicle } from '../../shared/cargoDefaults';
import type { CalcState, HistoryEntry, HistoryList, HistoryRow, SavedLayout } from '../../shared/cargoState';
import { clone, dec, esc, fM, fT, fV, num, toMM } from '../../shared/cargoFormat';
import { drawTopView, type Sel, type TopGeom } from './topView';
import { createView3D, type MoveCheck, type View3D } from './view3d';
import { downloadBlob, renderSchemePng, PNG_PAD, PNG_WIDTH } from './schemePng';

// ---------- контракт модуля ----------
export interface CargoUser { id: string; name: string; role: string }        // role: 'admin' | 'lead' | 'manager'
export interface CargoReference { vehicles: Vehicle[]; pallets: PalletRow[] }
export interface CargoApi {
  getReference(): Promise<CargoReference>;
  saveVehicles(vehicles: Vehicle[]): Promise<Vehicle[]>;                       // адмін
  savePallets(pallets: PalletRow[]): Promise<PalletRow[]>;                      // адмін
  resetReference(): Promise<CargoReference>;                                    // адмін: «Повернути стандарт»
  listHistory(limit: number): Promise<HistoryList>;
  getHistory(id: string): Promise<HistoryEntry>;
  saveHistory(body: { state: CalcState; layout: SavedLayout; fit: boolean | null }): Promise<HistoryRow>;
}
export interface CargoExample {
  key: string; label: string; veh: string; bodies?: Body[]; ex: ExistingSpec;
  items: Array<Omit<Item, 'id' | 'c'>>; multi?: boolean; stops?: Record<string, string>;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface MountOptions {
  user: CargoUser;
  api: CargoApi;
  /** three.js r128: у дашборді () => import('three'); у макеті — скрипт з cdnjs. */
  loadThree: () => Promise<any>;
  /** Збереження PNG; за замовчуванням — звичайне завантаження файлу. 'cancelled' — без тосту. */
  savePng?: (blob: Blob, filename: string) => Promise<'saved' | 'cancelled'>;
  /** Хто адмін (за замовчуванням role === 'admin'). */
  isAdmin?: (u: CargoUser) => boolean;
  /** Лише для макета: з чого відкриватись. */
  initialExample?: CargoExample;
  /** Лише для макета: після кожної зміни (щоб скинути випадний «Приклад…»). */
  onStateChange?: (info: { example: string | null }) => void;
}
export interface CargoConfiguratorHandle {
  destroy(): void;
  setUser(u: CargoUser): void;
  applyExample(x: CargoExample): void;
  getState(): CalcState;
}

// ---------- незмінне ----------
const ICONS: Record<ItemKind, string> = {
  pallet: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="7" rx="1"/><path d="M1.5 12.5h13M3 10v2.5M8 10v2.5M13 10v2.5"/></svg>',
  bigbag: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4h8l1 9H3z"/><path d="M5 4V2.5M11 4V2.5"/></svg>',
  box: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11z"/><path d="M2.5 5 8 7.5 13.5 5M8 7.5v6"/></svg>',
  long: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="6" width="14" height="4" rx="1"/><path d="M5 6v4M10 6v4"/></svg>',
  roll: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="4.5" cy="8" rx="2.5" ry="5"/><path d="M4.5 3h8M4.5 13h8"/><ellipse cx="12.5" cy="8" rx="2.5" ry="5"/></svg>',
  barrel: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="8" cy="3.5" rx="4.5" ry="1.5"/><path d="M3.5 3.5v9c0 .8 2 1.5 4.5 1.5s4.5-.7 4.5-1.5v-9M3.5 8c0 .8 2 1.5 4.5 1.5s4.5-.7 4.5-1.5"/></svg>',
  bulk: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 13c2-6 4-8 6.5-8s4.5 2 6.5 8z"/><path d="M5 10h2M9 8.5h2"/></svg>',
};
const KINDS: Record<ItemKind, { title: string; make: () => Omit<Item, 'id' | 'c'> }> = {
  pallet: { title: 'Палети', make: () => ({ kind: 'pallet', name: 'Палети', ptype: 'euro', l: 1200, w: 800, h: 0, qty: 10, kg: 0 }) },
  bigbag: { title: 'Біг-беги', make: () => ({ kind: 'bigbag', name: 'Біг-беги', onPallet: false, ptype: 'euro', l: 900, w: 900, h: 0, qty: 6, kg: 0 }) },
  box: { title: 'Коробки, ящики', make: () => ({ kind: 'box', name: 'Коробки', l: 600, w: 400, h: 400, qty: 40, kg: 0, stack: false }) },
  long: { title: 'Довгомір', make: () => ({ kind: 'long', name: 'Довгомір', l: 6000, w: 400, h: 300, qty: 4, kg: 0, variant: 'auto' }) },
  roll: { title: 'Рулони', make: () => ({ kind: 'roll', name: 'Рулони', d: 600, len: 2000, qty: 10, kg: 0, variant: 'auto' }) },
  barrel: { title: 'Бочки', make: () => ({ kind: 'barrel', name: 'Бочки', d: 600, hgt: 900, qty: 8, kg: 0, variant: 'auto' }) },
  bulk: { title: 'Насипом, м³', make: () => ({ kind: 'bulk', name: 'Насипом', m3: 5, kg: 0, top: false }) },
};
const VAR_NAMES: Record<Variant, string> = { along: 'Вздовж', across: 'Поперек', stand: 'Стоячи', lieX: 'Лежачи вздовж', lieY: 'Лежачи поперек', auto: 'Авто' };
const NEEDS_H: Partial<Record<ItemKind, 1>> = { pallet: 1, bigbag: 1 };
function exDefaults(mode: ExistingSpec['mode']): ExistingSpec {
  return ({
    empty: { mode: 'empty' },
    pallets: { mode: 'pallets', type: 'euro', qty: 5, h: 0, l: 1200, w: 800 },
    meters: { mode: 'meters', split: false, kind: 'occupied', all: 2000, s1: 2000, s2: 2000 },
    volume: { mode: 'volume', kind: 'm3', m3: 10, pct: 30 },
    dims: { mode: 'dims', rows: [{ l: 1200, w: 1000, h: 1500, qty: 2 }] },
  } as Record<string, ExistingSpec>)[mode];
}
const errText = (e: unknown, fallback: string) => e instanceof Error && e.message ? e.message : fallback;

let instances = 0;

export function mountCargoConfigurator(root: HTMLElement, opts: MountOptions): CargoConfiguratorHandle {
  const P = `cc${++instances}-`;                       // префікс id: унікальний на екземпляр
  const isAdmin = (u: CargoUser) => (opts.isAdmin ? opts.isAdmin(u) : u.role === 'admin');
  let user = opts.user, dead = false, touched = false;
  let startExample: CargoExample | null = opts.initialExample || null;   // з чого стартувати (макет); у дашборді — null
  const cleanups: Array<() => void> = [];
  root.innerHTML = markup(P);
  const cfg = root.querySelector('.cargo-cfg') as HTMLElement;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => cfg.querySelector('#' + P + id) as T;
  const rid = (el: Element | null) => (el && el.id.startsWith(P) ? el.id.slice(P.length) : '');

  // ---------- довідник ----------
  let VEH: Vehicle[] = clone(DEFAULT_VEHICLES);
  E.setPallets(palletMap(DEFAULT_PALLETS));
  const vehById = (id: string) => VEH.find(v => v.id === id);
  const palOptions = (sel?: string, withCustom?: boolean) => Object.keys(E.PALLETS).map(k => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(E.PALLETS[k].name)}</option>`).join('') + (withCustom ? `<option value="custom"${sel === 'custom' ? ' selected' : ''}>Свої розміри</option>` : '');

  // ---------- стан ----------
  const S = {
    veh: DEFAULT_VEHICLE_ID, bodies: [] as Body[], kg: null as number | null, kgMax: null as number | null, arch: null as ArchSpec | null, edited: false,
    ex: { mode: 'empty' } as ExistingSpec, items: [] as Item[], gap: 0, countType: 'euro', view: '2d' as '2d' | '3d',
    example: null as string | null, multi: false, stops: {} as Record<string, string>, layoutMode: 'auto' as 'auto' | 'dense',
  };
  let R: AnalyzeResult | null = null, EXR: Obstacle[][] = [], sel: Sel | null = null, manual = false;
  let G: TopGeom | null = null;
  let HIST: HistoryRow[] = [], histScope: HistoryList['scope'] = 'own';
  let uidc = 0;
  const nid = () => 'i' + Date.now().toString(36) + (++uidc) + Math.random().toString(36).slice(2, 5);
  const touch = () => { S.example = null; touched = true; };

  function nextColor() {
    const used = new Set(S.items.map(i => i.c));
    for (let c = 1; c <= 8; c++) if (!used.has(c)) return c;
    return (S.items.length % 8) + 1;
  }
  function setVehicle(id: string) {
    const v = vehById(id); S.veh = id;
    if (v) { S.bodies = clone(v.bodies); S.kg = v.kg; S.kgMax = v.kgMax || null; S.arch = v.arch ? clone(v.arch) : null; S.edited = false; }
  }
  function applyExample(x: CargoExample) {
    S.example = x.key; setVehicle(x.veh);
    if (x.bodies) { S.bodies = clone(x.bodies); S.edited = true; }
    S.ex = { ...exDefaults(x.ex.mode), ...clone(x.ex) };
    S.multi = !!x.multi; S.stops = clone(x.stops || {}); S.layoutMode = 'auto';
    S.items = [];
    for (const it of x.items) S.items.push({ ...clone(it), id: nid(), c: nextColor() } as Item);
    S.gap = 0; sel = null;
    inputChanged();
  }
  function startState() {
    if (startExample) { applyExample(startExample); return; }
    setVehicle(vehById(DEFAULT_VEHICLE_ID) ? DEFAULT_VEHICLE_ID : (VEH[0] ? VEH[0].id : DEFAULT_VEHICLE_ID));
    S.ex = { mode: 'empty' }; S.items = []; S.multi = false; S.stops = {}; S.gap = 0; S.layoutMode = 'auto'; sel = null;
    inputChanged();
  }
  function currentState(): CalcState {
    return { veh: S.veh, bodies: clone(S.bodies), kg: S.kg, kgMax: S.kgMax, arch: S.arch ? clone(S.arch) : null, ex: clone(S.ex), items: clone(S.items), gap: S.gap, multi: S.multi, stops: clone(S.stops) };
  }

  // ---------- зв'язок із рушієм ----------
  const archesOf = () => E.archObstacles(S.bodies, S.arch);
  const exForEngine = (): ExistingSpec => ({ ...S.ex, stop: S.multi ? (+(S.ex.stop || 0) || 0) : 0 });
  function engineInput() {
    return { bodies: S.bodies, arches: archesOf(), existing: EXR, gap: S.gap, countType: S.countType, layoutMode: S.layoutMode,
      splitY: S.ex.mode === 'meters' && S.ex.split ? (S.ex.splitY ?? null) : null,
      items: S.items.map(i => ({ ...i, stop: S.multi ? (+(i.stop || 0) || 0) : 0 })) };
  }
  function inputChanged() { EXR = E.buildExisting(exForEngine(), S.bodies); relayout(); }
  function relayout() {
    R = E.analyze(engineInput()); manual = false;
    if (sel && sel.kind === 'u' && !R.placed.some(p => p.uid === sel!.id)) sel = null;
    renderAll();
  }
  function recount() { if (R) Object.assign(R, E.recount(engineInput(), R)); }
  function refillBulk() {
    const bulk = S.items.filter(i => i.kind === 'bulk').map(i => ({ gid: i.id, m3: +(i.m3 || 0) || 0, kg: +(i.kg || 0) || 0, top: !!i.top }));
    const occ = S.bodies.map((_, bi) => [...(archesOf()[bi] || []), ...(EXR[bi] || []), ...R!.placed.filter(p => p.body === bi)]);
    return E.fillBulk(S.bodies, occ, bulk, E.aboveOf(S.bodies, EXR, R!.placed));
  }

  // ---------- ліва панель ----------
  function renderVehicle() {
    const groups = [...new Set(VEH.map(v => v.grp))];
    $<HTMLSelectElement>('veh').innerHTML = groups.map(g => `<optgroup label="${esc(g)}">${VEH.filter(v => v.grp === g).map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</optgroup>`).join('')
      + `<optgroup label="Інше"><option value="custom">Свої розміри</option></optgroup>`;
    $<HTMLSelectElement>('veh').value = vehById(S.veh) ? S.veh : 'custom';
    const multi = S.bodies.length > 1;
    $('vehDims').innerHTML = S.bodies.map((b, bi) => `
      <div class="vrow${multi ? ' tr' : ''}">${multi ? `<div class="bn">${bi ? 'Причіп' : 'Кузов'}</div>` : ''}
        <label class="f">Довжина, м<input class="in" id="${P}b${bi}L" data-b="${bi}" data-k="L" inputmode="decimal" value="${fM(b.L)}"></label>
        <label class="f">Ширина, м<input class="in" id="${P}b${bi}W" data-b="${bi}" data-k="W" inputmode="decimal" value="${fM(b.W)}"></label>
        <label class="f">Висота, м<input class="in" id="${P}b${bi}H" data-b="${bi}" data-k="H" inputmode="decimal" value="${fM(b.H)}"></label>
      </div>`).join('');
    $('vehKg').innerHTML = `<div class="kgrow"><label class="f">Вантажопідйомність, т
        <span class="range"><input class="in" id="${P}kgMin" inputmode="decimal" value="${S.kg ? fT(S.kg) : ''}" placeholder="—" aria-label="від"><span>–</span><input class="in" id="${P}kgMax" inputmode="decimal" value="${S.kgMax ? fT(S.kgMax) : ''}" placeholder="—" aria-label="до"></span></label>
      ${isAdmin(user) ? `<button type="button" class="linkbtn" id="${P}openRef">Довідник</button>` : '<span></span>'}</div>`;
    $('vehTag').innerHTML = S.edited ? `<span class="tag warn">змінено</span><button type="button" class="linkbtn" id="${P}vehReset">повернути</button>` : '';
  }
  function stopFields(idp: string, stop: number) {
    const opt = [1, 2, 3, 4, 5, 6].map(n => `<option value="${n}"${+stop === n ? ' selected' : ''}>${n}</option>`).join('');
    return `<div class="stoprow"><label class="f">Точка<select class="in" id="${idp}-stop">${opt}</select></label>
      <label class="f">Місто<input class="in txt" id="${idp}-city" value="${esc(S.stops[stop] || '')}" placeholder="напр. Київ"></label></div>`;
  }
  function renderExisting() {
    cfg.querySelectorAll(`#${P}exMode button`).forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.v === S.ex.mode)));
    const x = S.ex; let h = '';
    if (x.mode === 'pallets') h = `
      <label class="f">Тип<select class="in" id="${P}exType">${palOptions(x.type, true)}</select></label>
      ${x.type === 'custom' ? `<div class="row r2"><label class="f">Довжина, м<input class="in" id="${P}exL" inputmode="decimal" value="${fM(x.l || 0)}"></label><label class="f">Ширина, м<input class="in" id="${P}exW" inputmode="decimal" value="${fM(x.w || 0)}"></label></div>` : ''}
      <div class="row r2"><label class="f">Кількість<input class="in" id="${P}exQty" inputmode="numeric" value="${x.qty || 0}"></label><label class="f">Висота, м<input class="in" id="${P}exH" inputmode="decimal" value="${x.h ? fM(x.h) : ''}" placeholder="—"></label></div>`;
    if (x.mode === 'meters') h = `
      <div class="inline">
        <div class="ways sm" id="${P}exSplit"><button type="button" data-v="0" aria-pressed="${!x.split}">Весь кузов</button><button type="button" data-v="1" aria-pressed="${!!x.split}">По бортах</button></div>
        <div class="ways sm" id="${P}exKind"><button type="button" data-v="occupied" aria-pressed="${x.kind === 'occupied'}">Зайнято</button><button type="button" data-v="free" aria-pressed="${x.kind === 'free'}">Вільно</button></div>
      </div>
      ${x.split ? `<div class="row r2"><label class="f">Борт 1, м<input class="in" id="${P}exS1" inputmode="decimal" value="${fM(x.s1 || 0)}"></label><label class="f">Борт 2, м<input class="in" id="${P}exS2" inputmode="decimal" value="${fM(x.s2 || 0)}"></label></div>`
        : `<div class="row r2"><label class="f">По довжині, м<input class="in" id="${P}exAll" inputmode="decimal" value="${fM(x.all || 0)}"></label></div>`}`;
    if (x.mode === 'volume') h = `
      <div class="inline"><div class="ways sm" id="${P}exVolKind"><button type="button" data-v="m3" aria-pressed="${x.kind === 'm3'}">м³</button><button type="button" data-v="pct" aria-pressed="${x.kind === 'pct'}">%</button></div>
        <input class="in" id="${P}exVol" inputmode="decimal" style="width:110px" value="${x.kind === 'm3' ? dec(x.m3 || 0, 1) : (x.pct || 0)}" aria-label="Зайнято"></div>`;
    if (x.mode === 'dims') h = `
      ${(x.rows || []).map((r, ri) => `<div class="row" style="grid-template-columns:repeat(4,minmax(0,1fr)) 28px;align-items:end">
        <label class="f">Д, м<input class="in" id="${P}exr${ri}l" data-r="${ri}" data-k="l" inputmode="decimal" value="${fM(r.l)}"></label>
        <label class="f">Ш, м<input class="in" id="${P}exr${ri}w" data-r="${ri}" data-k="w" inputmode="decimal" value="${fM(r.w)}"></label>
        <label class="f">В, м<input class="in" id="${P}exr${ri}h" data-r="${ri}" data-k="h" inputmode="decimal" value="${fM(r.h)}"></label>
        <label class="f">К-сть<input class="in" id="${P}exr${ri}q" data-r="${ri}" data-k="qty" inputmode="numeric" value="${r.qty}"></label>
        <button type="button" class="del" data-exdel="${ri}" aria-label="Прибрати рядок">✕</button></div>`).join('')}
      <div><button type="button" class="btn sm" id="${P}exAddRow">+ рядок</button></div>`;
    const tail = `<div class="row r2"><label class="f">Вага, т<input class="in" id="${P}exKg" inputmode="decimal" value="${x.kg ? fT(x.kg) : ''}" placeholder="—"></label></div>`
      + (S.multi ? stopFields(P + 'ex', x.stop || 1) : '');
    $('exBody').innerHTML = x.mode === 'empty' ? '' : `<div class="stack" style="margin-top:10px">${h}${tail}</div>`;
  }
  const fld = (id: string, label: string, val: string | number, mode = 'decimal', ph = '') => `<label class="f">${label}<input class="in${ph && !val ? ' need' : ''}" id="${id}" inputmode="${mode}" value="${val}" placeholder="${ph}"></label>`;
  function itemFlag(it: Item) {
    if (!R) return '';
    if (it.kind === 'bulk') {
      const left = R.bulk.left.find(b => b.gid === it.id);
      return left && left.m3 > 0.01 ? `<span class="flag bad">не влізло ${fV(left.m3)} м³</span>` : '';
    }
    const all = R.units.filter(u => u.gid === it.id), pl = R.placed.filter(p => p.gid === it.id);
    const tot = all.reduce((s, u) => s + (u.layers || 1), 0), put = pl.reduce((s, u) => s + (u.layers || 1), 0);
    const parts: string[] = [];
    if (put < tot) parts.push(`<span class="flag bad">не влізло ${tot - put}</span>`);
    if (NEEDS_H[it.kind] && !it.h) parts.push(`<span class="flag warn">висота?</span>`);
    return parts.join(' ');
  }
  function renderItems() {
    $('items').innerHTML = S.items.map((it, idx) => {
      const p = `${P}it-${it.id}`, kg = fld(p + '-kg', 'кг/шт', it.kg || '', 'numeric', '—');
      let body = '';
      if (it.kind === 'pallet') body = `<div class="row r4"><label class="f" style="grid-column:span 2">Тип<select class="in" id="${p}-pt">${palOptions(it.ptype, true)}</select></label>${fld(p + '-h', 'Висота, м', it.h ? fM(it.h) : '', 'decimal', '—')}${kg}</div>`
        + (it.ptype === 'custom' ? `<div class="row r4">${fld(p + '-l', 'Д, м', fM(it.l || 0))}${fld(p + '-w', 'Ш, м', fM(it.w || 0))}</div>` : '');
      if (it.kind === 'bigbag') body = `<label class="chk"><input type="checkbox" id="${p}-onp" ${it.onPallet ? 'checked' : ''}> на палеті</label>
        <div class="row r4">${it.onPallet ? `<label class="f" style="grid-column:span 2">Палета<select class="in" id="${p}-pt">${palOptions(it.ptype, false)}</select></label>` : fld(p + '-l', 'Д, м', fM(it.l || 0)) + fld(p + '-w', 'Ш, м', fM(it.w || 0))}${fld(p + '-h', 'Висота, м', it.h ? fM(it.h) : '', 'decimal', '—')}${kg}</div>`;
      if (it.kind === 'box') body = `<div class="row r4">${fld(p + '-l', 'Д, м', fM(it.l || 0))}${fld(p + '-w', 'Ш, м', fM(it.w || 0))}${fld(p + '-h', 'В, м', fM(it.h || 0))}${kg}</div>
        <label class="chk"><input type="checkbox" id="${p}-st" ${it.stack ? 'checked' : ''}> ярусами до стелі</label>`;
      if (it.kind === 'long') body = `<div class="row r4">${fld(p + '-l', 'Д, м', fM(it.l || 0))}${fld(p + '-w', 'Ш, м', fM(it.w || 0))}${fld(p + '-h', 'В, м', fM(it.h || 0))}${kg}</div>`;
      if (it.kind === 'roll') body = `<div class="row r3">${fld(p + '-d', 'Ø, м', fM(it.d || 0))}${fld(p + '-len', 'Довжина, м', fM(it.len || 0))}${kg}</div>`;
      if (it.kind === 'barrel') body = `<div class="row r3">${fld(p + '-d', 'Ø, м', fM(it.d || 0))}${fld(p + '-hg', 'Висота, м', fM(it.hgt || 0))}${kg}</div>`;
      if (it.kind === 'bulk') body = `<div class="row r2">${fld(p + '-m3', 'Об\'єм, м³', dec(+(it.m3 || 0) || 0, 1))}${fld(p + '-kg', 'Вага, кг', it.kg || '', 'numeric', '—')}</div>
        <label class="chk"><input type="checkbox" id="${p}-top" ${it.top ? 'checked' : ''}> можна класти зверху на інший вантаж</label>`;
      let vars = '';
      if (E.VARIANTS[it.kind] && R && R.variantInfo[it.id]) {
        const info = R.variantInfo[it.id], ch = R.chosen[it.id];
        vars = `<div class="ways sm" role="group" aria-label="Як ставити">
          <button type="button" data-var="${it.id}:auto" aria-pressed="${it.variant === 'auto'}" title="Система обирає найкращу">Авто${it.variant === 'auto' ? ': ' + VAR_NAMES[ch].toLowerCase() : ''}</button>
          ${info.map(o => `<button type="button" data-var="${it.id}:${o.v}" aria-pressed="${it.variant === o.v}" title="${o.left ? (o.reason || 'не влізе ' + o.left) : 'влізе, до ' + fM(o.used) + ' м'}">${VAR_NAMES[o.v]} <span class="${o.left ? 'x' : 'y'}">${o.left ? '✗' : '✓'}</span></button>`).join('')}
        </div>`;
      }
      const qty = it.kind === 'bulk' ? '<span></span>' : `<div class="qty"><button type="button" data-q="${it.id}:-1" aria-label="Менше">−</button><input id="${p}-q" inputmode="numeric" value="${it.qty || 0}" aria-label="Кількість"><button type="button" data-q="${it.id}:1" aria-label="Більше">+</button></div>`;
      const flag = itemFlag(it);
      return `<div class="item" style="--ic:var(--c${it.c || 1})" data-id="${it.id}">
        <div class="head"><span class="no">${idx + 1}</span><input class="name txt" id="${p}-n" value="${esc(it.name)}" aria-label="Назва">${qty}<button type="button" class="del" data-del="${it.id}" aria-label="Прибрати">✕</button></div>
        ${body}${vars}${S.multi ? stopFields(p, it.stop || 1) : ''}${flag ? `<div>${flag}</div>` : ''}</div>`;
    }).join('');
    $('addMenu').innerHTML = (Object.keys(KINDS) as ItemKind[]).map(k => `<button type="button" data-add="${k}"><span class="ico">${ICONS[k]}</span>${KINDS[k].title}</button>`).join('');
    $<HTMLInputElement>('multi').checked = S.multi;
  }

  // ---------- схема зверху ----------
  const itemOf = (gid: string) => S.items.find(i => i.id === gid);
  const itemNo = (gid: string) => S.items.findIndex(i => i.id === gid) + 1;
  const topInput = () => ({ bodies: S.bodies, arches: archesOf(), existing: EXR, result: R, items: S.items, sel, multi: S.multi,
    lane: (S.ex.mode === 'meters' && S.ex.split ? (S.ex.splitY ?? null) : false) as number | null | false });
  function render2D() {
    const st = $('stage2d'); if (st.hidden) return;
    const out = drawTopView({ ...topInput(), width: Math.max(300, Math.floor(st.clientWidth - 28)), exp: false, idp: P });
    G = out.geom; st.innerHTML = out.svg;
  }

  // ---------- перетягування в 2D ----------
  type DragRect = Rect & { body: number; unit?: Placed; ex?: Obstacle };
  function rectOf(ref: Sel): DragRect | null {
    if (!R) return null;
    if (ref.kind === 'u') { const p = R.placed.find(q => q.uid === ref.id); return p ? { x: p.x, y: p.y, l: p.l, w: p.w, body: p.body, unit: p } : null; }
    const [bi, k] = ref.id.split(':').map(Number); const r = EXR[bi] && EXR[bi][k];
    return r ? { x: r.x, y: r.y, l: r.l, w: r.w, body: bi, ex: r } : null;
  }
  function othersFor(ref: Sel, bi: number): Array<Rect & Record<string, any>> {
    const arch = archesOf()[bi] || [];
    const ex = (EXR[bi] || []).filter((_, k) => !(ref.kind === 'e' && ref.id === bi + ':' + k));
    if (ref.kind === 'e') return [...arch, ...ex];
    return [...arch, ...ex, ...(R ? R.placed.filter(p => p.body === bi && p.uid !== ref.id) : [])];
  }
  function snapRect(rc: Rect, bi: number, ref: Sel): Rect {
    const b = S.bodies[bi], g = S.gap, M = 70;
    rc.x = Math.round(rc.x / 10) * 10; rc.y = Math.round(rc.y / 10) * 10;
    const xs = [0, b.L - rc.l], ys = [0, b.W - rc.w];
    for (const o of othersFor(ref, bi)) { xs.push(o.x + o.l + g, o.x - rc.l - g); ys.push(o.y + o.w + g, o.y - rc.w - g); }
    const near = (v: number, list: number[]) => { let best = v, d = M; for (const c of list) { const dd = Math.abs(c - v); if (dd < d) { d = dd; best = c; } } return best; };
    rc.x = near(rc.x, xs); rc.y = near(rc.y, ys);
    return rc;
  }
  const validRect = (rc: Rect, bi: number, ref: Sel) => E.checkMove(S.bodies[bi], rc, othersFor(ref, bi), S.gap) as MoveCheck;
  function whyText(v: MoveCheck) {
    if (v.ok) return '';
    if (v.why === 'out') return 'виходить за кузов';
    const o = v.with || ({} as Record<string, unknown>);
    if (o.arch) return 'заважає колісна арка';
    if (o.uid) { const it = itemOf(String(o.gid)); return `заважає «${it ? it.name : 'вантаж'}»`; }
    return 'заважає наявний вантаж';
  }
  function commitMove(ref: Sel, bi: number, rc: Rect, rotated: boolean) {
    if (!R) return;
    if (ref.kind === 'u') {
      const p = R.placed.find(q => q.uid === ref.id); if (!p) return;
      Object.assign(p, { x: rc.x, y: rc.y, l: rc.l, w: rc.w, body: bi });
      if (rotated) p.rotated = !p.rotated;
      R.bulk = refillBulk(); recount(); manual = true; renderAll();
      if (S.multi && p.stop) {
        const br = E.orderBreaks(p, p.stop, [...(EXR[bi] || []), ...R.placed.filter(q => q.body === bi && q.uid !== p.uid)]);
        if (br.length) toast('Так порушено порядок вивантаження', true);
      }
    } else {
      const [obi, k] = ref.id.split(':').map(Number);
      const r = EXR[obi].splice(k, 1)[0];
      Object.assign(r, { x: rc.x, y: rc.y, l: rc.l, w: rc.w });
      EXR[bi].push(r);
      sel = { kind: 'e', id: bi + ':' + (EXR[bi].length - 1) };
      touched = true;
      relayout();
    }
  }
  let drag: any = null, justDragged = false;
  function bodyAtX(px: number) {
    if (!G) return null;
    for (let bi = 0; bi < S.bodies.length; bi++) { const x0 = G.ox[bi], x1 = x0 + S.bodies[bi].L * G.s; if (px >= x0 - 20 && px <= x1 + 20) return bi; }
    return null;
  }
  function onDown2D(e: PointerEvent) {
    if (!R) return;
    const svg = cfg.querySelector(`#${P}stage2d svg`) as SVGSVGElement | null; if (!svg) return;
    const t = e.target as Element;
    const lane = t.closest('.lane') as SVGGElement | null;
    if (lane) {
      drag = { lane: +(lane.dataset.lane || 0), sy: e.clientY, y0: S.ex.splitY || Math.floor(S.bodies[0].W / 2), g: lane, moved: false };
      svg.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    const g = t.closest('.u') as SVGGElement | null; if (!g) return;
    const ref: Sel = g.dataset.uid ? { kind: 'u', id: g.dataset.uid } : { kind: 'e', id: g.dataset.eid || '' };
    const rc = rectOf(ref); if (!rc) return;
    sel = ref;
    drag = { ref, rc, sx: e.clientX, sy: e.clientY, bb: svg.getBoundingClientRect(), g, moved: false, cand: null };
    svg.setPointerCapture(e.pointerId);
    cfg.querySelectorAll(`#${P}stage2d .u .f`).forEach(n => n.setAttribute('stroke-width', '1.4'));
    const f = g.querySelector('.f'); if (f) f.setAttribute('stroke-width', '3');
    updateTip(); e.preventDefault();
  }
  function onMove2D(e: PointerEvent) {
    if (!drag || !G) return;
    if (drag.lane !== undefined) {
      const dy = (e.clientY - drag.sy) / G.s; if (!drag.moved && Math.abs(dy) * G.s < 3) return;
      drag.moved = true;
      const W = S.bodies[0].W;
      drag.val = Math.max(300, Math.min(W - 300, Math.round((drag.y0 + dy) / 50) * 50));
      drag.g.setAttribute('transform', `translate(0,${((drag.val - drag.y0) * G.s).toFixed(1)})`);
      return;
    }
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const svg = cfg.querySelector(`#${P}stage2d svg`); if (svg) svg.classList.add('dragging');
    let bi = bodyAtX(e.clientX - drag.bb.left); if (bi === null) bi = drag.rc.body as number;
    const shift = (G.ox[bi] - G.ox[drag.rc.body]) / G.s;
    const rc = snapRect({ x: drag.rc.x + dx / G.s - shift, y: drag.rc.y + dy / G.s, l: drag.rc.l, w: drag.rc.w }, bi, drag.ref);
    const v = validRect(rc, bi, drag.ref);
    drag.cand = { rc, bi, v };
    const tx = (G.ox[bi] + rc.x * G.s) - (G.ox[drag.rc.body] + drag.rc.x * G.s), ty = (rc.y - drag.rc.y) * G.s;
    drag.g.setAttribute('transform', `translate(${tx.toFixed(1)},${ty.toFixed(1)})`);
    const f = drag.g.querySelector('.f') as SVGElement | null; if (f) f.style.stroke = v.ok ? '' : 'var(--bad)';
  }
  function onUp2D() {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved) justDragged = true;
    const svg = cfg.querySelector(`#${P}stage2d svg`); if (svg) svg.classList.remove('dragging');
    if (d.lane !== undefined) { if (d.moved && d.val) { S.ex.splitY = d.val; touch(); inputChanged(); } return; }
    if (!d.moved || !d.cand) { updateTip(); return; }
    if (d.cand.v.ok) { touched = true; commitMove(d.ref, d.cand.bi, d.cand.rc, false); }
    else { toast('Не поміститься: ' + whyText(d.cand.v), true); render2D(); }
  }
  function rotateSel() {
    if (!sel || !R) return;
    const rc0 = rectOf(sel); if (!rc0) return;
    if (sel.kind === 'u' && rc0.unit && rc0.unit.rot === false) { toast('Поворот — через варіант розкладки в позиції', true); return; }
    if (rc0.l === rc0.w) return;
    const b = S.bodies[rc0.body];
    const rc = { x: rc0.x, y: rc0.y, l: rc0.w, w: rc0.l };
    rc.x = Math.min(Math.max(0, rc.x), b.L - rc.l); rc.y = Math.min(Math.max(0, rc.y), b.W - rc.w);
    const v = validRect(rc, rc0.body, sel);
    if (!v.ok) { toast('Після повороту не поміститься: ' + whyText(v), true); return; }
    touched = true;
    commitMove(sel, rc0.body, rc, true);
  }

  // ---------- лоток, точки, виділене ----------
  function renderTray() {
    const tray = $('tray'), by = new Map<string, number>();
    if (R) for (const u of R.unplaced) by.set(u.gid, (by.get(u.gid) || 0) + (u.layers || 1));
    const bulkLeft = R ? R.bulk.left.filter(b => b.m3 > 0.01) : [];
    if (!by.size && !bulkLeft.length) { tray.hidden = true; return; }
    tray.hidden = false;
    tray.innerHTML = `<span class="t">Не влізло:</span>`
      + [...by].map(([gid, n]) => { const it = itemOf(gid); return it ? `<span class="pill" style="--ic:var(--c${it.c || 1})"><span class="dot"></span>${n} × ${esc(it.name)}</span>` : ''; }).join('')
      + bulkLeft.map(b => { const it = itemOf(b.gid); return it ? `<span class="pill" style="--ic:var(--c${it.c || 1})"><span class="dot"></span>${esc(it.name)} ${fV(b.m3)} м³</span>` : ''; }).join('')
      + (manual && by.size ? ` <button type="button" class="btn sm" id="${P}tryPlace">Доставити</button>` : '');
  }
  function renderStops() {
    const line = $('stopsLine');
    const used = [...new Set([...S.items.map(i => +(i.stop || 0) || 1), ...(S.ex.mode !== 'empty' ? [+(S.ex.stop || 0) || 1] : [])])].sort((a, b) => a - b);
    if (!S.multi || !used.length) { line.hidden = true; return; }
    line.hidden = false;
    line.innerHTML = used.map(n => `<span><span class="sb">${n}</span>${esc(S.stops[n] || 'точка ' + n)}</span>`).join('');
  }
  function renderOrderMode() {
    const box = $('orderMode');
    if (!R || !R.hasStops || !R.alt) { box.hidden = true; return; }
    box.hidden = false;
    const mark = (n: number) => n ? `<span class="x">✗</span>` : `<span class="y">✓</span>`;
    box.innerHTML = `<button type="button" data-v="auto" aria-pressed="${R.mode === 'ordered'}" title="Те, що вивантажують першим, — біля дверей">За точками ${mark(R.alt.ordered)}</button>`
      + `<button type="button" data-v="dense" aria-pressed="${R.mode === 'dense'}" title="Найщільніше, без порядку точок">Щільно ${mark(R.alt.dense)}</button>`;
  }
  function updateTip() {
    const tip = $('selTip'); $<HTMLButtonElement>('rotBtn').disabled = !sel;
    if (!sel || !R) { tip.textContent = ''; return; }
    const rc = rectOf(sel); if (!rc) { sel = null; tip.textContent = ''; return; }
    if (sel.kind === 'e') { tip.textContent = `Наявний вантаж · ${fM(rc.l)} × ${fM(rc.w)} м`; return; }
    const it = rc.unit ? itemOf(rc.unit.gid) : null;
    tip.textContent = `${it ? it.name : ''} · ${fM(rc.l)} × ${fM(rc.w)} м · R — поворот`;
  }

  // ---------- результат ----------
  function weightZone(kg: number) {
    if (!S.kg) return null;
    const max = S.kgMax && S.kgMax > S.kg ? S.kgMax : S.kg;
    return kg > max ? 'bad' : kg > S.kg ? 'warn' : 'ok';
  }
  const kgText = () => S.kg ? (S.kgMax && S.kgMax > S.kg ? `${fT(S.kg)}–${fT(S.kgMax)} т` : `${fT(S.kg)} т`) : '';
  function renderResult() {
    if (!R) return;
    const v = $('verdict');
    const unplaced = R.unplaced.reduce((s, u) => s + (u.layers || 1), 0);
    const bulkLeft = R.bulk.left.filter(b => b.m3 > 0.01);
    const kgAll = R.kgOur + (+(S.ex.kg || 0) || 0);
    const zone = weightZone(kgAll);
    let cls: string, icon: string, title: string, sub = '', act = '';
    if (!S.items.length) { cls = 'none'; icon = 'i'; title = 'Вільне місце'; }
    else if (unplaced || bulkLeft.length) {
      cls = 'bad'; icon = '✕';
      const by = new Map<string, number>(); R.unplaced.forEach(u => by.set(u.gid, (by.get(u.gid) || 0) + (u.layers || 1)));
      const what = [...[...by].map(([g, n]) => `${n} × ${itemOf(g)?.name || ''}`), ...bulkLeft.map(b => `${itemOf(b.gid)?.name || ''} ${fV(b.m3)} м³`)].join(', ');
      if (R.mode === 'ordered' && R.alt && R.alt.dense === 0) { title = 'Не влазить за порядком точок'; sub = 'Щільно — влазить.'; act = '<button type="button" class="linkbtn" data-mode="dense">Показати щільно</button>'; }
      else { title = 'Не влазить'; sub = 'Не влізло: ' + what; }
    } else if (zone === 'bad') { cls = 'bad'; icon = '!'; title = 'Перевантаж'; sub = `${fT(kgAll)} т при ${kgText()}`; }
    else if (zone === 'warn') { cls = 'warn'; icon = '!'; title = 'Влазить — уточни вагу'; sub = `${fT(kgAll)} т при ${kgText()}`; }
    else {
      cls = 'ok'; icon = '✓'; title = 'Влазить';
      if (R.mode === 'dense' && R.hasStops && R.alt && R.alt.ordered > 0) { cls = 'warn'; icon = '!'; title = 'Влазить лише щільно'; sub = 'Порядок точок порушено.'; }
    }
    if (manual && S.items.length) sub = (sub ? sub + ' ' : '') + 'Змінено вручну.';
    v.className = 'verdict ' + cls;
    v.innerHTML = `<div class="vi" aria-hidden="true">${icon}</div><div><div class="vt">${title}</div>${sub || act ? `<div class="vs">${esc(sub)} ${act}</div>` : ''}</div>`;

    const B = S.bodies;
    const free = B.map((_, bi) => {
      const p = R!.perBody[bi], pre = B.length > 1 ? `<span style="grid-column:1/-1;font-size:11.5px;color:var(--muted)">${bi ? 'Причіп' : 'Кузов'}</span>` : '';
      return Math.abs(p.free1 - p.free2) < 15 && B.length === 1 ? `<div class="v"><span class="big">${fM(p.free1)}</span> м</div>`
        : `<div class="sides">${pre}${Math.abs(p.free1 - p.free2) < 15 ? `<span>довжина</span><span class="num">${fM(p.free1)} м</span>` : `<span>борт 1</span><span class="num">${fM(p.free1)} м</span><span>борт 2</span><span class="num">${fM(p.free2)} м</span>`}</div>`;
    }).join('');
    const maxKg = S.kgMax && S.kg && S.kgMax > S.kg ? S.kgMax : S.kg;
    const scale = maxKg ? Math.max(maxKg * 1.1, kgAll) : 1;
    $('kv').innerHTML = `
      <div><div class="k">Вільно</div>${free}</div>
      <div><div class="k">Ще влізе <select id="${P}countType" aria-label="Тип палети">${Object.keys(E.PALLETS).map(k => `<option value="${k}"${k === S.countType ? ' selected' : ''}>${esc(E.PALLETS[k].name.split(' ')[0])}</option>`).join('')}</select></div>
        <div class="pp"><span class="big">${R.max}</span><span class="big">${R.even}</span><small>впритул</small><small>рівними рядами</small></div></div>
      <div><div class="k">Вільний об'єм</div><div class="v"><span class="big">${fV(R.freeVol)}</span> м³</div></div>
      <div><div class="k">Вага <span class="num" style="margin-left:auto;text-transform:none;letter-spacing:0;color:var(--ink-2)">${fT(kgAll)}${S.kg ? ' / ' + kgText() : ' т'}</span></div>
        ${S.kg ? `<div class="wbar" role="img" aria-label="Вага ${fT(kgAll)} т з ${kgText()}">${S.kgMax && S.kgMax > S.kg ? `<span class="z" style="left:${(S.kg / scale * 100).toFixed(1)}%;width:${((S.kgMax - S.kg) / scale * 100).toFixed(1)}%"></span>` : ''}<i class="${zone === 'ok' ? '' : zone}" style="width:${Math.min(100, kgAll / scale * 100).toFixed(1)}%"></i></div>` : ''}
        ${zone === 'warn' ? '<div class="wnote warn">уточни в перевізника</div>' : zone === 'bad' ? '<div class="wnote bad">перевантаж</div>' : ''}</div>`;
  }

  // ---------- історія ----------
  function renderHistory() {
    const all = histScope === 'all';
    $('histScope').textContent = all ? 'усі' : 'ваша';
    const p2 = (n: number) => String(n).padStart(2, '0');
    $('hist').innerHTML = HIST.length ? HIST.slice(0, 12).map(h => {
      const d = new Date(h.createdAt);
      const fit = h.fit === false ? '<span class="pillbad">✕</span>' : h.fit === true ? '<span class="pillok">✓</span>' : '';
      return `<li><button type="button" data-h="${esc(h.id)}"><span class="h1"><span>${fit} ${esc(h.vehicle)}</span><span class="num" style="font-weight:500;color:var(--muted)">${p2(d.getDate())}.${p2(d.getMonth() + 1)}</span></span>
        <span class="h2">${esc(h.items)}${all ? ' · ' + esc(h.userName) : ''}</span></button></li>`;
    }).join('') : `<li class="empty">Порожньо</li>`;
  }
  async function loadHistoryList() {
    try { const r = await opts.api.listHistory(12); if (dead) return; HIST = r.rows; histScope = r.scope; }
    catch { if (dead) return; HIST = []; }
    renderHistory();
  }
  async function saveToHistory() {
    if (!R) return;
    const btn = $<HTMLButtonElement>('saveBtn');
    const layout: SavedLayout = { placed: R.placed.map(p => ({ uid: p.uid, x: p.x, y: p.y, l: p.l, w: p.w, body: p.body, rotated: p.rotated })), exr: clone(EXR), manual, mode: S.layoutMode };
    const ok = !R.unplaced.length && !R.bulk.left.some(b => b.m3 > 0.01);
    btn.disabled = true;
    try {
      const row = await opts.api.saveHistory({ state: currentState(), layout, fit: S.items.length ? ok : null });
      if (dead) return;
      HIST = [row, ...HIST.filter(h => h.id !== row.id)]; renderHistory(); toast('Збережено');
    } catch (e) { if (!dead) toast(errText(e, 'Не вдалося зберегти'), true); }
    finally { if (!dead) btn.disabled = false; }
  }
  async function loadHistory(id: string) {
    let h: HistoryEntry;
    try { h = await opts.api.getHistory(id); } catch (e) { if (!dead) toast(errText(e, 'Не вдалося відкрити'), true); return; }
    if (dead) return;
    const st = h.state, v = vehById(st.veh);
    Object.assign(S, {
      veh: st.veh, bodies: clone(st.bodies), kg: st.kg, kgMax: st.kgMax || null,
      arch: st.arch !== undefined ? (st.arch ? clone(st.arch) : null) : (v && v.arch ? clone(v.arch) : null),
      ex: { ...exDefaults(st.ex.mode), ...clone(st.ex) }, items: clone(st.items), gap: st.gap || 0,
      multi: !!st.multi, stops: clone(st.stops || {}), layoutMode: (h.layout && h.layout.mode) || 'auto', example: null,
    });
    S.edited = !!(v && JSON.stringify(v.bodies) !== JSON.stringify(S.bodies)); sel = null; touched = true;
    if (h.layout) {
      EXR = clone(h.layout.exr); R = E.analyze(engineInput()); manual = false;
      if (h.layout.manual) { for (const q of h.layout.placed) { const p = R.placed.find(x => x.uid === q.uid); if (p) Object.assign(p, q); } R.bulk = refillBulk(); recount(); manual = true; }
      renderAll();
    } else inputChanged();
  }

  // ---------- 3D ----------
  let V3: View3D | null = null, v3loading: Promise<View3D> | null = null;
  const cssCol = (k: string) => getComputedStyle(cfg).getPropertyValue('--' + k).trim() || '#888';
  function ensure3D(): Promise<View3D> {
    if (V3) return Promise.resolve(V3);
    if (!v3loading) v3loading = opts.loadThree().then(THREE => {
      if (dead) throw new Error('destroyed');
      V3 = createView3D({
        THREE, el: $('stage3d'), color: cssCol,
        scene: () => R ? { bodies: S.bodies, arches: archesOf(), existing: EXR, result: R, items: S.items, sel } : null,
        rectOf, snapRect, validRect,
        onSelect: ref => { sel = ref; updateTip(); }, onIdle: () => updateTip(),
        onCommit: (ref, bi, rc) => { touched = true; commitMove(ref, bi, rc, false); },
        onReject: v => toast('Не поміститься: ' + whyText(v), true),
      });
      return V3;
    }).catch(e => { v3loading = null; throw e; });
    return v3loading;
  }
  async function show3D() {
    const msg = $('msg3d'); msg.hidden = false; msg.textContent = 'Завантажую 3D…';
    try { await ensure3D(); if (dead) return; msg.hidden = true; V3!.build(true); }
    catch { if (!dead) msg.textContent = '3D зараз недоступний. Схема зверху працює.'; }
  }
  const build3D = (resetCam: boolean) => { if (V3 && R) V3.build(resetCam); };

  // ---------- схема PNG: лише вид зверху ----------
  async function exportPNG() {
    if (!R) return;
    const { svg, nums } = drawTopView({ ...topInput(), width: PNG_WIDTH - PNG_PAD * 2, exp: true, idp: '' });
    const v = vehById(S.veh), d = new Date(), p2 = (n: number) => String(n).padStart(2, '0');
    const stops = S.multi ? [...new Set(S.items.map(i => +(i.stop || 0) || 1))].sort((a, b) => a - b).map(n => `${n} — ${S.stops[n] || 'точка ' + n}`).join('   ') : '';
    const numsLine = [...nums].map(g => itemNo(g)).filter(n => n > 0).sort((a, b) => a - b).map(n => `${n} — ${S.items[n - 1].name}`).join('   ');
    const blob = await renderSchemePng(svg, {
      title: `${v ? v.name : 'Авто'} · ${S.bodies.map(b => `${fM(b.L)} × ${fM(b.W)} × ${fM(b.H)} м`).join(' + ')}`,
      date: `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`, stops, nums: numsLine,
    });
    const fname = `Skhema_${p2(d.getDate())}${p2(d.getMonth() + 1)}_${p2(d.getHours())}${p2(d.getMinutes())}.png`;
    let res: 'saved' | 'cancelled';
    try { res = await (opts.savePng || downloadBlob)(blob, fname); } catch { if (!dead) toast('Не вдалося зберегти', true); return; }
    if (res === 'saved' && !dead) toast('Схему збережено');
  }

  // ---------- довідник (адмін) ----------
  function renderRef() {
    const groups = [...new Set(VEH.map(v => v.grp))];
    const row = (v: Vehicle) => `<tr data-v="${esc(v.id)}">
      <td><input class="txt" data-f="name" value="${esc(v.name)}" aria-label="Назва"></td>
      <td><input data-f="L" value="${fM(v.bodies[0].L)}" aria-label="Довжина"></td><td><input data-f="W" value="${fM(v.bodies[0].W)}" aria-label="Ширина"></td><td><input data-f="H" value="${fM(v.bodies[0].H)}" aria-label="Висота"></td>
      <td><input data-f="kg" value="${v.kg ? fT(v.kg) : ''}" placeholder="—" aria-label="т від"></td><td><input data-f="kgMax" value="${v.kgMax ? fT(v.kgMax) : ''}" placeholder="—" aria-label="т до"></td>
      <td><input class="txt" data-f="load" value="${esc(v.load)}" aria-label="Завантаження"></td>
      <td><input data-f="between" value="${v.arch ? fM(v.arch.between) : ''}" placeholder="—" aria-label="Між арками"></td>
      <td><input data-f="alen" value="${v.arch ? fM(v.arch.len) : ''}" placeholder="—" aria-label="Довжина арки"></td>
      <td><input data-f="ax" value="${v.arch ? fM(v.arch.x) : ''}" placeholder="—" aria-label="Арка від кабіни"></td>
      <td class="src">${v.bodies.length > 1 ? v.bodies.length + ' кузови · ' : ''}${esc(v.src || '')}${v.q ? ` · <span class="q">${esc(v.q)}</span>` : ''}</td>
      <td><button type="button" class="del" data-vdel="${esc(v.id)}" aria-label="Прибрати">✕</button></td></tr>`;
    $('refBody').innerHTML = `<h5>Авто</h5><div style="overflow-x:auto"><table class="reft"><thead><tr><th style="width:200px">Авто</th><th>Д, м</th><th>Ш, м</th><th>В, м</th><th>Т від</th><th>Т до</th><th style="width:140px">Завантаження</th><th>Між арками</th><th>Арка, довж.</th><th>Арка від кабіни</th><th>Джерело</th><th></th></tr></thead><tbody>
      ${groups.map(g => `<tr class="grp"><td colspan="12">${esc(g)}</td></tr>` + VEH.filter(v => v.grp === g).map(row).join('')).join('')}</tbody></table></div>
      <h5>Палети</h5><div style="overflow-x:auto"><table class="reft small"><thead><tr><th style="width:220px">Палета</th><th>Д, м</th><th>Ш, м</th></tr></thead><tbody>
      ${Object.entries(E.PALLETS).map(([k, p]) => `<tr data-p="${k}"><td><input class="txt" data-pf="name" value="${esc(p.name)}" aria-label="Назва"></td><td><input data-pf="l" value="${fM(p.l)}" aria-label="Довжина"></td><td><input data-pf="w" value="${fM(p.w)}" aria-label="Ширина"></td></tr>`).join('')}</tbody></table></div>`;
  }
  let saveVehT: ReturnType<typeof setTimeout> | undefined, savePalT: ReturnType<typeof setTimeout> | undefined;
  const palletRows = (): PalletRow[] => Object.entries(E.PALLETS).map(([key, p]) => ({ key, name: p.name, l: p.l, w: p.w }));
  function queueSave(kind: 'veh' | 'pal') {
    const run = async () => {
      try { if (kind === 'veh') await opts.api.saveVehicles(VEH); else await opts.api.savePallets(palletRows()); }
      catch (e) { if (dead) return; toast(errText(e, 'Довідник не збережено'), true); await reloadReference(); if (!$('refModal').hidden) renderRef(); }
    };
    if (kind === 'veh') { clearTimeout(saveVehT); saveVehT = setTimeout(run, 500); } else { clearTimeout(savePalT); savePalT = setTimeout(run, 500); }
  }
  function refEdit(e: Event) {
    const inp = e.target as HTMLInputElement, tr = inp.closest('tr') as HTMLTableRowElement | null; if (!tr) return;
    if (tr.dataset.p) {
      const p = E.PALLETS[tr.dataset.p], f = inp.dataset.pf as 'name' | 'l' | 'w';
      if (f === 'name') p.name = inp.value; else p[f] = toMM(inp.value) || p[f];
      S.items.forEach(it => { if (it.kind === 'pallet' && it.ptype && E.PALLETS[it.ptype]) { it.l = E.PALLETS[it.ptype].l; it.w = E.PALLETS[it.ptype].w; } });
      queueSave('pal'); inputChanged(); return;
    }
    if (!inp.dataset.f) return;
    const v = vehById(tr.dataset.v || ''), f = inp.dataset.f; if (!v) return;
    if (f === 'name' || f === 'load') v[f] = inp.value;
    else if (f === 'L' || f === 'W' || f === 'H') v.bodies.forEach(b => { b[f] = toMM(inp.value) || b[f]; });
    else if (f === 'kg' || f === 'kgMax') v[f] = inp.value.trim() ? Math.round(num(inp.value) * 1000) : null;
    else if (!inp.value.trim()) { if (f === 'between') v.arch = null; }
    else { v.arch = v.arch || { between: 1350, len: 1000, x: 2000, h: 300 }; v.arch[f === 'between' ? 'between' : f === 'alen' ? 'len' : 'x'] = toMM(inp.value); }
    queueSave('veh');
    if (S.veh === v.id && !S.edited) { setVehicle(v.id); inputChanged(); } else renderVehicle();
  }
  function applyReference(ref: CargoReference) {
    VEH = ref.vehicles.length ? clone(ref.vehicles) : clone(DEFAULT_VEHICLES);
    E.setPallets(palletMap(ref.pallets.length ? ref.pallets : DEFAULT_PALLETS));
    S.items.forEach(it => { if (it.kind === 'pallet' && it.ptype && E.PALLETS[it.ptype]) { it.l = E.PALLETS[it.ptype].l; it.w = E.PALLETS[it.ptype].w; } });
  }
  async function reloadReference() {
    try { const ref = await opts.api.getReference(); if (!dead) applyReference(ref); } catch { /* лишаємо, що є */ }
  }

  // ---------- загальний рендер ----------
  function renderAll() {
    const ae = document.activeElement;
    const act = ae && cfg.contains(ae) && ae.id ? ae.id : null;
    renderVehicle(); renderExisting(); renderItems(); renderResult(); renderTray(); renderStops(); renderOrderMode(); renderHistory(); updateTip();
    if (S.view === '2d') render2D(); else build3D(false);
    if (act) { const el = cfg.querySelector('#' + CSS.escape(act)) as HTMLElement | null; if (el && el.focus) el.focus({ preventScroll: true }); }
    if (opts.onStateChange) opts.onStateChange({ example: S.example });
  }
  let toastT: ReturnType<typeof setTimeout> | undefined;
  function toast(msg: string, bad?: boolean) {
    const t = $('toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, bad ? 3600 : 2200);
  }

  // ---------- події ----------
  function onItemsChange(e: Event) {
    const t = e.target as HTMLInputElement, card = t.closest('.item') as HTMLElement | null; if (!card) return;
    const it = S.items.find(i => i.id === card.dataset.id); if (!it) return;
    const k = t.id.slice(`${P}it-${it.id}-`.length);
    const map: Record<string, 'l' | 'w' | 'd' | 'len' | 'hgt'> = { l: 'l', w: 'w', d: 'd', len: 'len', hg: 'hgt' };
    if (k === 'n') { it.name = t.value || KINDS[it.kind].title; renderTray(); render2D(); return; }
    if (k === 'city') { S.stops[+(it.stop || 0) || 1] = t.value.trim(); renderStops(); renderItems(); return; }
    if (k === 'q') it.qty = Math.max(0, Math.round(num(t.value)));
    else if (k === 'kg') it.kg = Math.max(0, Math.round(num(t.value)));
    else if (k === 'm3') it.m3 = Math.max(0, num(t.value));
    else if (k === 'pt') { it.ptype = t.value; if (E.PALLETS[t.value]) { it.l = E.PALLETS[t.value].l; it.w = E.PALLETS[t.value].w; } }
    else if (k === 'onp') it.onPallet = t.checked;
    else if (k === 'st') it.stack = t.checked;
    else if (k === 'top') it.top = t.checked;
    else if (k === 'stop') it.stop = +t.value;
    else if (k === 'h') it.h = t.value.trim() ? Math.max(10, toMM(t.value)) : 0;
    else if (map[k]) it[map[k]] = Math.max(10, toMM(t.value));
    else return;
    touch(); relayout();
  }
  const onDoc = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => { document.addEventListener(type, fn); cleanups.push(() => document.removeEventListener(type, fn)); };
  function bind() {
    $('veh').addEventListener('change', e => {
      const id = (e.target as HTMLSelectElement).value;
      if (id === 'custom') { S.veh = 'custom'; S.edited = true; S.arch = null; S.bodies = [clone(S.bodies[0])]; } else setVehicle(id);
      touch(); sel = null; inputChanged();
    });
    $('vehDims').addEventListener('change', e => {
      const t = e.target as HTMLInputElement; if (!t.dataset.k) return;
      const v = toMM(t.value); if (v < 300) { toast('Розміри — у метрах', true); renderVehicle(); return; }
      S.bodies[+(t.dataset.b || 0)][t.dataset.k as 'L' | 'W' | 'H'] = v; S.edited = true; touch(); inputChanged();
    });
    $('vehKg').addEventListener('change', e => {
      const t = e.target as HTMLInputElement;
      if (rid(t) === 'kgMin') S.kg = t.value.trim() ? Math.round(num(t.value) * 1000) : null;
      else if (rid(t) === 'kgMax') S.kgMax = t.value.trim() ? Math.round(num(t.value) * 1000) : null;
      else return;
      S.edited = true; touched = true; renderAll();
    });
    $('vehKg').addEventListener('click', e => { if (rid(e.target as Element) === 'openRef' && isAdmin(user)) { renderRef(); $('refModal').hidden = false; } });
    $('vehTag').addEventListener('click', e => { if (rid(e.target as Element) === 'vehReset') { setVehicle(vehById(S.veh) ? S.veh : DEFAULT_VEHICLE_ID); touch(); inputChanged(); } });
    $('exMode').addEventListener('click', e => { const b = (e.target as Element).closest('button') as HTMLButtonElement | null; if (!b) return; S.ex = { ...exDefaults(b.dataset.v as ExistingSpec['mode']), kg: S.ex.kg, stop: S.ex.stop }; touch(); sel = null; inputChanged(); });
    $('exBody').addEventListener('click', e => {
      const b = (e.target as Element).closest('button') as HTMLButtonElement | null; if (!b) return;
      const w = b.closest('.ways');
      if (w && rid(w) === 'exSplit') S.ex.split = b.dataset.v === '1';
      else if (w && (rid(w) === 'exKind' || rid(w) === 'exVolKind')) S.ex.kind = b.dataset.v as ExistingSpec['kind'];
      else if (rid(b) === 'exAddRow') (S.ex.rows = S.ex.rows || []).push({ l: 1200, w: 1000, h: 1500, qty: 1 });
      else if (b.dataset.exdel !== undefined) (S.ex.rows || []).splice(+b.dataset.exdel, 1);
      else return;
      touch(); inputChanged();
    });
    $('exBody').addEventListener('change', e => {
      const t = e.target as HTMLInputElement, x = S.ex, id = rid(t);
      if (id === 'exType') { x.type = t.value; if (E.PALLETS[t.value]) { x.l = E.PALLETS[t.value].l; x.w = E.PALLETS[t.value].w; } }
      else if (id === 'exQty') x.qty = Math.max(0, Math.round(num(t.value)));
      else if (id === 'exH') x.h = t.value.trim() ? toMM(t.value) : 0;
      else if (id === 'exL') x.l = toMM(t.value);
      else if (id === 'exW') x.w = toMM(t.value);
      else if (id === 'exS1') x.s1 = toMM(t.value);
      else if (id === 'exS2') x.s2 = toMM(t.value);
      else if (id === 'exAll') x.all = toMM(t.value);
      else if (id === 'exVol') { if (x.kind === 'm3') x.m3 = num(t.value); else x.pct = Math.min(100, Math.max(0, num(t.value))); }
      else if (id === 'exKg') { x.kg = t.value.trim() ? Math.round(num(t.value) * 1000) : 0; touched = true; renderResult(); return; }
      else if (id === 'ex-stop') x.stop = +t.value;
      else if (id === 'ex-city') { S.stops[+(x.stop || 0) || 1] = t.value.trim(); renderStops(); renderItems(); return; }
      else if (t.dataset.r !== undefined) { const r = (x.rows || [])[+t.dataset.r]; const k = t.dataset.k as 'l' | 'w' | 'h' | 'qty'; if (r) r[k] = k === 'qty' ? Math.max(0, Math.round(num(t.value))) : toMM(t.value); }
      else return;
      touch(); inputChanged();
    });
    $('multi').addEventListener('change', e => {
      S.multi = (e.target as HTMLInputElement).checked; S.layoutMode = 'auto';
      if (S.multi) { S.items.forEach(i => { if (!i.stop) i.stop = 1; }); if (!S.ex.stop) S.ex.stop = 1; }
      touch(); inputChanged();
    });
    $('items').addEventListener('change', onItemsChange);
    $('items').addEventListener('click', e => {
      const t = e.target as Element;
      const q = t.closest('[data-q]') as HTMLElement | null, del = t.closest('[data-del]') as HTMLElement | null, vb = t.closest('[data-var]') as HTMLElement | null;
      if (q) { const [id, d] = (q.dataset.q || '').split(':'); const it = S.items.find(i => i.id === id); if (!it) return; it.qty = Math.max(0, (it.qty || 0) + +d); touch(); relayout(); }
      else if (del) { S.items = S.items.filter(i => i.id !== del.dataset.del); touch(); sel = null; relayout(); }
      else if (vb) { const [id, v] = (vb.dataset.var || '').split(':'); const it = S.items.find(i => i.id === id); if (!it) return; it.variant = v as Variant; touch(); relayout(); }
    });
    $('addBtn').addEventListener('click', () => { const m = $('addMenu'); m.hidden = !m.hidden; $('addBtn').setAttribute('aria-expanded', String(!m.hidden)); });
    $('addMenu').addEventListener('click', e => {
      const b = (e.target as Element).closest('[data-add]') as HTMLElement | null; if (!b) return;
      const it = { ...KINDS[b.dataset.add as ItemKind].make(), id: nid(), c: nextColor() } as Item;
      if (S.multi) it.stop = 1;
      S.items.push(it); $('addMenu').hidden = true; $('addBtn').setAttribute('aria-expanded', 'false'); touch(); relayout();
    });
    onDoc('click', e => { if (!(e.target as Element).closest || !(e.target as Element).closest(`#${P}addwrap`)) { $('addMenu').hidden = true; $('addBtn').setAttribute('aria-expanded', 'false'); } });
    $('gap').addEventListener('change', e => { S.gap = Math.max(0, Math.round(num((e.target as HTMLInputElement).value) * 10)); touch(); relayout(); });
    $('kv').addEventListener('change', e => {
      const t = e.target as HTMLSelectElement; if (rid(t) !== 'countType' || !R) return;
      S.countType = t.value;
      const tmp = E.analyze(engineInput()); R.countType = tmp.countType; R.maxExtra = tmp.maxExtra; recount(); renderResult(); render2D();
    });
    $('verdict').addEventListener('click', e => { const b = (e.target as Element).closest('[data-mode]') as HTMLElement | null; if (b) { S.layoutMode = b.dataset.mode as 'auto' | 'dense'; relayout(); } });
    $('orderMode').addEventListener('click', e => { const b = (e.target as Element).closest('button') as HTMLElement | null; if (b) { S.layoutMode = b.dataset.v as 'auto' | 'dense'; relayout(); } });
    $('viewMode').addEventListener('click', e => {
      const b = (e.target as Element).closest('button') as HTMLElement | null; if (!b) return;
      S.view = b.dataset.v as '2d' | '3d';
      cfg.querySelectorAll(`#${P}viewMode button`).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      $('stage2d').hidden = S.view !== '2d'; $('stage3dWrap').hidden = S.view !== '3d';
      if (S.view === '3d') show3D(); else render2D();
    });
    $('rotBtn').addEventListener('click', rotateSel);
    $('autoBtn').addEventListener('click', () => { sel = null; relayout(); });
    const st = $('stage2d');
    st.addEventListener('pointerdown', onDown2D); st.addEventListener('pointermove', onMove2D);
    st.addEventListener('pointerup', onUp2D); st.addEventListener('pointercancel', onUp2D);
    st.addEventListener('dblclick', e => { if ((e.target as Element).closest('.u')) rotateSel(); });
    st.addEventListener('click', e => { if (justDragged) { justDragged = false; return; } if (!(e.target as Element).closest('.u') && !drag) { sel = null; render2D(); updateTip(); } });
    onDoc('keydown', e => {
      if (!cfg.isConnected || !cfg.getClientRects().length) return;            // вкладка схована — клавіші не наші
      if (e.key === 'Escape' && !$('refModal').hidden) { $('refModal').hidden = true; return; }
      const t = e.target as Element;
      if (t && t.closest && t.closest('input,select,textarea')) return;
      if (e.code === 'KeyR' && sel && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); rotateSel(); }
      if (e.key === 'Escape' && sel) { sel = null; renderAll(); }
    });
    $('tray').addEventListener('click', e => {
      if (rid(e.target as Element) !== 'tryPlace' || !R) return;
      const obst = S.bodies.map((_, bi) => [...(archesOf()[bi] || []), ...(EXR[bi] || []), ...R!.placed.filter(p => p.body === bi), ...(R!.bulk.rects[bi] || [])]);
      const r = E.packAll(S.bodies, obst, R.unplaced, S.gap, false);
      if (!r.placed.length) { toast('Вільного місця немає', true); return; }
      R.placed = R.placed.concat(r.placed); R.unplaced = r.unplaced; recount(); renderAll();
    });
    $('pngBtn').addEventListener('click', () => { exportPNG().catch(() => toast('Не вдалося зібрати схему', true)); });
    $('saveBtn').addEventListener('click', () => { saveToHistory(); });
    $('hist').addEventListener('click', e => { const b = (e.target as Element).closest('[data-h]') as HTMLElement | null; if (b) loadHistory(b.dataset.h || ''); });
    $('refClose').addEventListener('click', () => { $('refModal').hidden = true; });
    $('refModal').addEventListener('click', e => { if (e.target === $('refModal')) $('refModal').hidden = true; });
    $('refBody').addEventListener('change', refEdit);
    $('refBody').addEventListener('click', e => {
      const b = (e.target as Element).closest('[data-vdel]') as HTMLElement | null; if (!b) return;
      VEH = VEH.filter(v => v.id !== b.dataset.vdel); queueSave('veh'); renderRef(); renderVehicle();
    });
    $('refAdd').addEventListener('click', () => {
      VEH.push({ id: 'v' + Date.now(), grp: 'Свої', name: 'Нове авто', bodies: [{ L: 6000, W: 2450, H: 2400 }], kg: 5000, kgMax: null, load: 'ззаду', arch: null, src: 'адмін' });
      queueSave('veh'); renderRef(); renderVehicle();
    });
    $('refReset').addEventListener('click', async () => {
      clearTimeout(saveVehT); clearTimeout(savePalT);
      try { const ref = await opts.api.resetReference(); if (dead) return; applyReference(ref); }
      catch (e) { if (!dead) toast(errText(e, 'Не вдалося повернути стандарт'), true); return; }
      renderRef(); if (!vehById(S.veh)) setVehicle(DEFAULT_VEHICLE_ID); inputChanged();
    });
    let rz: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { if (!dead && S.view === '2d') render2D(); }, 60); });
    ro.observe($('stage2d'));
    cleanups.push(() => { ro.disconnect(); clearTimeout(rz); });
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const onTheme = () => { if (S.view === '3d') build3D(false); };
    if (mq && mq.addEventListener) { mq.addEventListener('change', onTheme); cleanups.push(() => mq.removeEventListener('change', onTheme)); }
    const mo = new MutationObserver(onTheme);                   // перемикач теми дашборда (data-theme / class на <html>)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    cleanups.push(() => mo.disconnect());
  }

  // ---------- старт ----------
  bind();
  startState();                                               // одразу робочий екран зі стандартним довідником
  (async () => {
    try {
      const ref = await opts.api.getReference(); if (dead) return;
      applyReference(ref);
      if (touched) inputChanged(); else startState();          // менеджер ще нічого не міняв — починаємо з довідника БД
    } catch (e) { if (!dead) toast(errText(e, 'Довідник не завантажився — стандартні значення'), true); }
  })();
  loadHistoryList();

  return {
    destroy() {
      if (dead) return;
      dead = true;
      cleanups.forEach(f => f()); cleanups.length = 0;
      clearTimeout(toastT); clearTimeout(saveVehT); clearTimeout(savePalT);
      if (V3) V3.destroy(); V3 = null;
      root.innerHTML = '';
    },
    setUser(u: CargoUser) {
      user = u;
      if (!isAdmin(u)) $('refModal').hidden = true;
      renderVehicle(); loadHistoryList();
    },
    applyExample(x: CargoExample) { touched = false; startExample = x; applyExample(x); },
    getState: currentState,
  };
}

// ---------- розмітка (стилі — configurator.css, усе під .cargo-cfg) ----------
function markup(P: string): string {
  return `<div class="cargo-cfg">
  <div class="cfgq"><div class="cfg">
    <section class="card inputs" aria-label="Дані для розрахунку">
      <div class="sec">
        <h3><span class="n">1</span>Авто <span class="aside" id="${P}vehTag"></span></h3>
        <select class="in" id="${P}veh" aria-label="Тип авто"></select>
        <div id="${P}vehDims"></div>
        <div id="${P}vehKg"></div>
      </div>
      <div class="sec">
        <h3><span class="n">2</span>Вже в авто</h3>
        <div class="ways" id="${P}exMode" role="group" aria-label="Як описати наявний вантаж">
          <button type="button" data-v="empty">Порожнє</button>
          <button type="button" data-v="pallets">Палети</button>
          <button type="button" data-v="meters">Метри</button>
          <button type="button" data-v="volume">Об'єм</button>
          <button type="button" data-v="dims">Розміри</button>
        </div>
        <div id="${P}exBody"></div>
      </div>
      <div class="sec">
        <h3><span class="n">3</span>Наш вантаж <span class="aside"><label class="toggle"><input type="checkbox" id="${P}multi"> Кілька точок</label></span></h3>
        <div class="items" id="${P}items"></div>
        <div class="addwrap" id="${P}addwrap">
          <button type="button" class="btn sm" id="${P}addBtn" aria-expanded="false">+ Додати</button>
          <div class="addmenu" id="${P}addMenu" hidden></div>
        </div>
      </div>
    </section>

    <div class="mainc">
      <section class="card view" aria-label="Схема завантаження">
        <div class="vbar">
          <div class="ways" id="${P}viewMode" role="group" aria-label="Вигляд">
            <button type="button" data-v="2d" aria-pressed="true">Зверху</button>
            <button type="button" data-v="3d">3D</button>
          </div>
          <div class="ways" id="${P}orderMode" role="group" aria-label="Порядок точок" hidden></div>
          <button type="button" class="btn sm" id="${P}rotBtn" disabled title="Повернути на 90° (R)">↻</button>
          <button type="button" class="btn sm" id="${P}autoBtn" title="Скинути ручні зміни">Розкласти заново</button>
          <span class="seltip" id="${P}selTip"></span>
          <span class="grow"></span>
          <label class="gapf">Зазор <input class="in" id="${P}gap" inputmode="decimal" value="0"> см</label>
        </div>
        <div class="stops" id="${P}stopsLine" hidden></div>
        <div class="stage" id="${P}stage2d"></div>
        <div class="stage" id="${P}stage3dWrap" hidden><div class="stage3d" id="${P}stage3d"><div class="msg" id="${P}msg3d">Завантажую 3D…</div><span class="help" title="Миша — обертати · колесо — масштаб · Shift + миша — зсув · вантаж тягніть по підлозі">?</span></div></div>
        <div class="tray" id="${P}tray" hidden></div>
      </section>

      <div class="resrow">
        <section class="card result" aria-label="Результат">
          <div class="rtop">
            <div class="verdict none" id="${P}verdict"><div class="vi">?</div><div><div class="vt">…</div></div></div>
            <div class="acts">
              <button type="button" class="btn" id="${P}pngBtn"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2v8m0 0 3-3m-3 3L5 7M3 12.5h10"/></svg>Схема PNG</button>
              <button type="button" class="btn pri" id="${P}saveBtn">Зберегти</button>
            </div>
          </div>
          <div class="kv" id="${P}kv"></div>
        </section>
        <section class="card hist" aria-label="Історія розрахунків">
          <h4><span>Історія</span><span id="${P}histScope"></span></h4>
          <ul id="${P}hist"></ul>
        </section>
      </div>
    </div>
  </div></div>

  <div class="toast" id="${P}toast" role="status" aria-live="polite" hidden></div>

  <div class="modal" id="${P}refModal" hidden>
    <div class="mbox" role="dialog" aria-modal="true" aria-labelledby="${P}refTitle">
      <div class="mhead">
        <h2 id="${P}refTitle">Довідник</h2>
        <span class="tag">лише адмін</span>
        <span class="grow"></span>
        <button type="button" class="btn sm" id="${P}refReset">Повернути стандарт</button>
        <button type="button" class="btn sm" id="${P}refAdd">+ Авто</button>
        <button type="button" class="btn sm pri" id="${P}refClose">Готово</button>
      </div>
      <div class="mbody" id="${P}refBody"></div>
    </div>
  </div>
</div>`;
}
