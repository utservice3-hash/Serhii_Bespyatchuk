/**
 * Схема зверху (SVG) — чиста функція: дані → рядок SVG. Та сама для екрана (кольори — CSS-змінні теми)
 * і для PNG перевізнику (exp = true: світлі кольори літералами, шрифт Arial, біле тло).
 * Кабіна ліворуч, двері праворуч; на місцях — назва й висота (де влазить), інакше номер позиції.
 */
import type { AnalyzeResult, Body, Item, Obstacle } from '../../shared/cargoEngine';
import { esc, fM } from '../../shared/cargoFormat';

/** Проміжок між кузовами зчіпки на схемі й у 3D, мм. */
export const GAPB = 900;
/** Світла палітра для PNG (екран бере ті самі назви з CSS-змінних). */
export const LIGHT: Record<string, string> = {
  surface: '#ffffff', 'surface-2': '#faf8f6', 'surface-3': '#f0ece8', ink: '#1c1e26', 'ink-2': '#464b58', muted: '#7c8090', line: '#e6e0da',
  floor: '#fbfaf8', wall: '#5d6270', exist: '#9096a3', arch: '#3b3f4a', grid: '#ece6df', ok: '#15803d', bad: '#b91c1c', brand: '#c5141c',
  c1: '#2a78d6', c2: '#eb6834', c3: '#1baf7a', c4: '#eda100', c5: '#e87ba4', c6: '#008300', c7: '#6250d6', c8: '#e34948',
};

export interface Sel { kind: 'u' | 'e'; id: string }
export interface TopGeom { s: number; ox: number[]; padT: number; width: number; h: number }
export interface TopViewInput {
  bodies: Body[]; arches: Obstacle[][]; existing: Obstacle[][]; result: AnalyzeResult | null; items: Item[];
  sel: Sel | null; multi: boolean;
  lane: number | null | false;      // межа бортів (мм від борту 1) для «по бортах»; false — не показувати
  width: number; exp: boolean;
  idp: string;                      // префікс id візерунків (унікальний на екземпляр)
}
const textW = (t: string, fs: number) => t.length * fs * 0.56;

export function drawTopView(inp: TopViewInput): { svg: string; geom: TopGeom; nums: Set<string> } {
  const { bodies: B, arches, existing, result: R, items, sel, multi, width, exp, idp } = inp;
  const nums = new Set<string>();
  const C = (k: string) => exp ? LIGHT[k] : `var(--${k})`;
  const itemOf = (gid: string) => items.find(i => i.id === gid);
  const itemNo = (gid: string) => items.findIndex(i => i.id === gid) + 1;
  const padL = 46, padR = 14, padT = 26, padB = 14;
  const totL = B.reduce((s, b) => s + b.L, 0) + GAPB * (B.length - 1);
  const maxW = Math.max(...B.map(b => b.W));
  const s = Math.min((width - padL - padR) / totL, 360 / maxW);
  const h = Math.round(padT + maxW * s + padB);
  const ox: number[] = []; let acc = padL; B.forEach((b, i) => { ox[i] = acc; acc += (b.L + GAPB) * s; });
  const geom: TopGeom = { s, ox, padT, width, h };
  const X = (bi: number, v: number) => ox[bi] + v * s, Y = (v: number) => padT + v * s;
  const font = exp ? 'font-family="Arial, Helvetica, sans-serif"' : '';
  const used = [...new Set(items.map(i => i.c || 1))];
  const T = (x: number, y: number, t: string, a = '') => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" ${a}>${esc(t)}</text>`;
  let o = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" ${font} role="img" aria-label="Схема завантаження зверху">`;
  o += `<defs><pattern id="${idp}hx" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="${C('surface-3')}"/><line x1="0" y1="0" x2="0" y2="7" stroke="${C('exist')}" stroke-width="2.2"/></pattern>`;
  for (const c of used) o += `<pattern id="${idp}hb${c}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="6" height="6" fill="${C('surface')}"/><line x1="0" y1="0" x2="0" y2="6" stroke="${C('c' + c)}" stroke-width="2"/></pattern>`
    + `<pattern id="${idp}ht${c}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="6" stroke="${C('c' + c)}" stroke-width="1.6" stroke-opacity=".8"/></pattern>`;
  o += `</defs>`;
  if (exp) o += `<rect width="${width}" height="${h}" fill="#ffffff"/>`;
  // кабіна (силует з вітровим склом) і стулки дверей — без підписів
  const bh0 = B[0].W * s;
  o += `<rect x="${padL - 36}" y="${(padT + bh0 * 0.1).toFixed(1)}" width="30" height="${(bh0 * 0.8).toFixed(1)}" rx="8" fill="${C('surface-3')}" stroke="${C('wall')}" stroke-width="1.2"/>`
    + `<rect x="${padL - 31}" y="${(padT + bh0 * 0.18).toFixed(1)}" width="7" height="${(bh0 * 0.64).toFixed(1)}" rx="3" fill="${C('wall')}" opacity=".35"/>`;
  B.forEach((b, bi) => {
    const x0 = X(bi, 0), y0 = Y(0), bw = b.L * s, bh = b.W * s;
    if (bi > 0) o += `<line x1="${(x0 - GAPB * s).toFixed(1)}" y1="${(y0 + bh / 2).toFixed(1)}" x2="${x0.toFixed(1)}" y2="${(y0 + bh / 2).toFixed(1)}" stroke="${C('wall')}" stroke-width="2" stroke-dasharray="4 3"/>`;
    o += `<rect x="${x0.toFixed(1)}" y="${y0}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${C('floor')}" stroke="${C('wall')}" stroke-width="1.6"/>`;
    for (let m = 1000; m < b.L; m += 1000) o += `<line x1="${X(bi, m).toFixed(1)}" y1="${y0}" x2="${X(bi, m).toFixed(1)}" y2="${(y0 + bh).toFixed(1)}" stroke="${C('grid')}" stroke-width="1"/>`;
    const step = 1000 * s < 26 ? 2000 : 1000;
    for (let m = 0; m <= b.L; m += 1000) {
      o += `<line x1="${X(bi, m).toFixed(1)}" y1="${y0 - 5}" x2="${X(bi, m).toFixed(1)}" y2="${y0}" stroke="${C('muted')}" stroke-width="1"/>`;
      if (m % step === 0 && (b.L - m) * s > 62) o += T(X(bi, m) + 2, y0 - 8, String(m / 1000), `font-size="10.5" fill="${C('muted')}"`);
    }
    o += T(x0 + bw, y0 - 8, fM(b.L) + ' м', `text-anchor="end" font-size="11" font-weight="700" fill="${C('ink-2')}"`);
    const xe = x0 + bw;
    o += `<path d="M${xe.toFixed(1)} ${y0} l7 -5 M${xe.toFixed(1)} ${(y0 + bh).toFixed(1)} l7 5" stroke="${C('wall')}" stroke-width="1.6" fill="none"/>`;
  });
  // арки
  arches.forEach((list, bi) => list.forEach(a => {
    o += `<rect x="${X(bi, a.x).toFixed(1)}" y="${Y(a.y).toFixed(1)}" width="${(a.l * s).toFixed(1)}" height="${(a.w * s).toFixed(1)}" fill="${C('arch')}" opacity=".85" rx="2"/>`;
    if (a.l * s > 34 && a.w * s > 11) o += T(X(bi, a.x) + a.l * s / 2, Y(a.y) + a.w * s / 2, 'арка', `text-anchor="middle" dominant-baseline="middle" font-size="10" fill="${C('surface')}"`);
  }));
  // насипом на підлозі
  if (R) R.bulk.rects.forEach((list, bi) => {
    let big: (typeof list)[number] | null = null;
    for (const r of list) {
      const it = itemOf(r.gid); if (!it) continue;
      o += `<rect x="${X(bi, r.x).toFixed(1)}" y="${Y(r.y).toFixed(1)}" width="${(r.l * s + 0.4).toFixed(1)}" height="${(r.w * s + 0.4).toFixed(1)}" fill="url(#${idp}hb${it.c || 1})"/>`;
      if (!big || r.l * r.w > big.l * big.w) big = r;
    }
    const it0 = big && itemOf(big.gid);
    if (big && it0) { const t = textW(it0.name, 11) <= big.l * s - 6 ? it0.name : ''; if (t && big.w * s > 15) o += T(X(bi, big.x) + big.l * s / 2, Y(big.y) + big.w * s / 2, t, `text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="700" fill="${C('ink')}" paint-order="stroke" stroke="${C('surface')}" stroke-width="3"`); }
  });
  const badge = (x: number, y: number, n: number) => `<circle cx="${(x + 8).toFixed(1)}" cy="${(y + 8).toFixed(1)}" r="6.5" fill="${C('ink')}"/><text x="${(x + 8).toFixed(1)}" y="${(y + 8.4).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="8.5" font-weight="700" fill="${C('surface')}">${n}</text>`;
  // наявний вантаж
  existing.forEach((list, bi) => list.forEach((r, k) => {
    const id = bi + ':' + k, isSel = !exp && !!sel && sel.kind === 'e' && sel.id === id;
    const x = X(bi, r.x), y = Y(r.y), w = r.l * s, hh = r.w * s;
    o += `<g class="u ex" data-eid="${id}"><rect class="f" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${hh.toFixed(1)}" fill="url(#${idp}hx)" stroke="${C('exist')}" stroke-width="${isSel ? 3 : 1.4}"/>`;
    const lab = r.block ? (r.label === 'зайнято' ? `зайнято ${fM(r.l)} м` : `зайнято ${r.label}`) : 'є';
    if (w > textW(lab, 11) + 8 && hh > 14) o += T(x + w / 2, y + hh / 2, lab, `text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="700" fill="${C('ink-2')}" paint-order="stroke" stroke="${C('surface-3')}" stroke-width="3"`);
    if (multi && r.stop && w > 22 && hh > 22) o += badge(x, y, r.stop);
    o += `</g>`;
  }));
  // межа між бортами (тягнеться мишею)
  if (!exp && inp.lane !== false) B.forEach((b, bi) => {
    const sy = Y(Math.max(100, Math.min(b.W - 100, (inp.lane as number | null) || Math.floor(b.W / 2))));
    o += `<g class="lane" data-lane="${bi}"><line x1="${X(bi, 0)}" y1="${sy.toFixed(1)}" x2="${X(bi, b.L)}" y2="${sy.toFixed(1)}" stroke="${C('ink-2')}" stroke-width="1.2" stroke-dasharray="6 4"/>`
      + `<line x1="${X(bi, 0)}" y1="${sy.toFixed(1)}" x2="${X(bi, b.L)}" y2="${sy.toFixed(1)}" stroke="transparent" stroke-width="12"/>`
      + `<rect x="${(X(bi, 0) + 8).toFixed(1)}" y="${(sy - 6).toFixed(1)}" width="26" height="12" rx="6" fill="${C('surface')}" stroke="${C('ink-2')}" stroke-width="1.2"/>`
      + `<path d="M${(X(bi, 0) + 16).toFixed(1)} ${(sy - 2).toFixed(1)}h10M${(X(bi, 0) + 16).toFixed(1)} ${(sy + 2).toFixed(1)}h10" stroke="${C('ink-2')}" stroke-width="1"/></g>`;
    if (bi === 0) o += T(X(0, 0) + 40, Y(0) + 11, 'борт 1', `font-size="10" fill="${C('muted')}"`) + T(X(0, 0) + 40, Y(b.W) - 4, 'борт 2', `font-size="10" fill="${C('muted')}"`);
  });
  // наш вантаж: назви на місцях; дрібне — номером
  const tops = new Map<string, { gid: string }>();
  if (R && R.bulk.tops) R.bulk.tops.forEach((list, bi) => list.forEach(t => tops.set(bi + ':' + t.x + ':' + t.y, t)));
  if (R) for (const p of R.placed) {
    const it = itemOf(p.gid); if (!it) continue;
    const col = C('c' + (it.c || 1)), x = X(p.body, p.x), y = Y(p.y), w = p.l * s, hh = p.w * s;
    const isSel = !exp && !!sel && sel.kind === 'u' && sel.id === p.uid, sw = isSel ? 3 : 1.4;
    let shape: string;
    if (p.shape === 'cyl-up') shape = `<circle class="f" cx="${(x + w / 2).toFixed(1)}" cy="${(y + hh / 2).toFixed(1)}" r="${(Math.min(w, hh) / 2 - 0.6).toFixed(1)}" fill="${col}" fill-opacity=".3" stroke="${col}" stroke-width="${sw}"/>`;
    else {
      const rx = (p.shape === 'cyl-x' || p.shape === 'cyl-y') ? Math.min(w, hh) / 2 : 2;
      shape = `<rect class="f" x="${(x + 0.6).toFixed(1)}" y="${(y + 0.6).toFixed(1)}" width="${Math.max(1, w - 1.2).toFixed(1)}" height="${Math.max(1, hh - 1.2).toFixed(1)}" rx="${rx.toFixed(1)}" fill="${col}" fill-opacity=".3" stroke="${col}" stroke-width="${sw}"${p.h ? '' : ' stroke-dasharray="4 3"'}/>`;
    }
    const tb = tops.get(p.body + ':' + p.x + ':' + p.y);
    if (tb) { const ti = itemOf(tb.gid); if (ti) shape += `<rect x="${(x + 0.6).toFixed(1)}" y="${(y + 0.6).toFixed(1)}" width="${Math.max(1, w - 1.2).toFixed(1)}" height="${Math.max(1, hh - 1.2).toFixed(1)}" fill="url(#${idp}ht${ti.c || 1})" pointer-events="none"/>`; }
    const nw = textW(it.name, 11);
    const fitsH = nw <= w - 8 && hh > 15, fitsV = !fitsH && nw <= hh - 8 && w > 15;
    const sub = [p.h ? fM(p.h) + ' м' : '', (p.layers || 0) > 1 ? '×' + p.layers : ''].filter(Boolean).join(' · ');
    const cx = x + w / 2, cy = y + hh / 2;
    const attrs = `text-anchor="middle" dominant-baseline="middle" fill="${C('ink')}" pointer-events="none"`;
    let label = '';
    if (fitsH || fitsV) {
      const avail = (fitsH ? w : hh) - 8, across = fitsH ? hh : w;
      const two = !!sub && across > 30 && textW(sub, 10) <= avail;
      const inner = T(cx, cy - (two ? 6 : 0), it.name, `${attrs} font-size="11" font-weight="700"`) + (two ? T(cx, cy + 7, sub, `${attrs} font-size="10"`) : '');
      label = fitsV ? `<g transform="rotate(-90 ${cx.toFixed(1)} ${cy.toFixed(1)})">${inner}</g>` : inner;
    } else if (w > 13 && hh > 12) { label = T(cx, cy, String(itemNo(p.gid)), `${attrs} font-size="${w > 22 && hh > 18 ? 11 : 9.5}" font-weight="700"`); nums.add(p.gid); }
    const st = multi && p.stop && w > 24 && hh > 24 ? badge(x + 1, y + 1, p.stop) : '';
    o += `<g class="u${isSel ? ' sel' : ''}" data-uid="${esc(p.uid)}">${shape}${label}${st}</g>`;
  }
  // вільно по довжині — розмірна лінія з числом
  if (R) B.forEach((b, bi) => {
    const pb = R.perBody[bi]; if (!pb) return;
    const lines = Math.abs(pb.free1 - pb.free2) < 15 ? [[pb.free1, b.W / 2]] : [[pb.free1, pb.split / 2], [pb.free2, pb.split + (b.W - pb.split) / 2]];
    for (const [fr, yc] of lines) {
      if (fr < 60) continue;
      const xa = X(bi, b.L - fr) + 3, xb = X(bi, b.L) - 3, yy = Y(yc);
      if (xb - xa < 24) continue;
      o += `<g pointer-events="none"><line x1="${xa.toFixed(1)}" y1="${yy.toFixed(1)}" x2="${xb.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${C('ink-2')}" stroke-width="1" stroke-dasharray="3 3"/>`
        + `<path d="M${xa.toFixed(1)} ${(yy - 4).toFixed(1)}v8M${xb.toFixed(1)} ${(yy - 4).toFixed(1)}v8" stroke="${C('ink-2')}" stroke-width="1.2"/>`
        + (xb - xa > 46 ? T((xa + xb) / 2, yy - 6, fM(fr) + ' м', `text-anchor="middle" font-size="11.5" font-weight="700" fill="${C('ink')}" paint-order="stroke" stroke="${C('floor')}" stroke-width="3"`) : '') + `</g>`;
    }
  });
  o += `</svg>`;
  return { svg: o, geom, nums };
}
