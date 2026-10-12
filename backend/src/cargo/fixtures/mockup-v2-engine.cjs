/* ЕТАЛОН: рушій із затвердженого макета v2 (12.10), байт у байт. Не редагувати — з ним звіряється shared/cargoEngine.ts (tests/engineParity.test.ts). */
/* Рушій розкладки вантажу в кузові — чисті функції, без DOM. Усі розміри в міліметрах (цілі).
 * Система координат кузова: x — уздовж, від кабіни (0) до дверей (L); y — упоперек, від борту 1 (0) до борту 2 (W).
 * Вільне місце — MaxRects (список максимальних порожніх прямокутників). Ставимо «ближче до кабіни» (мінімум x+довжина),
 * для однакових місць додатково перебираємо шаблони рядів і колон (напр. 1 ряд по 3 + 5 рядів по 2 = 13 у 5,2 м).
 * Зазор g — «роздуваємо» кожне місце й перешкоду на g, а кузов — на g (тож біля стінок зазору немає).
 * Точки вивантаження (stop: 1 — вивантажують першою): місце, яке вивантажують раніше, не може стояти «за» місцем,
 * яке вивантажують пізніше (ближче до кабіни в тій самій смузі по ширині) — інакше його не дістати через двері. */
const Engine = (() => {
  'use strict';

  const PALLETS = {
    euro: { l: 1200, w: 800, name: 'Євро 1,2×0,8' },
    amer: { l: 1200, w: 1200, name: 'Американка 1,2×1,2' },
    finn: { l: 1200, w: 1000, name: 'Фінська 1,2×1,0' },
    half: { l: 800, w: 600, name: 'Напівпалета 0,8×0,6' },
    square: { l: 1000, w: 1000, name: 'Квадратна 1,0×1,0' },
  };

  // ---------- геометрія ----------
  const inter = (a, b) => a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.w && b.y < a.y + a.w;
  const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.l <= a.x + a.l && b.y + b.w <= a.y + a.w;
  const lexLess = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return false; };

  function prune(list) {
    const l = list.filter(f => f.l > 0 && f.w > 0), keep = [];
    for (let i = 0; i < l.length; i++) {
      let dead = false;
      for (let j = 0; j < l.length && !dead; j++) {
        if (i !== j && contains(l[j], l[i]) && (!contains(l[i], l[j]) || j < i)) dead = true;
      }
      if (!dead) keep.push(l[i]);
    }
    return keep;
  }
  function splitFree(free, r) {
    const out = [];
    for (const f of free) {
      if (!inter(f, r)) { out.push(f); continue; }
      if (r.x > f.x) out.push({ x: f.x, y: f.y, l: r.x - f.x, w: f.w });
      if (r.x + r.l < f.x + f.l) out.push({ x: r.x + r.l, y: f.y, l: f.x + f.l - r.x - r.l, w: f.w });
      if (r.y > f.y) out.push({ x: f.x, y: f.y, l: f.l, w: r.y - f.y });
      if (r.y + r.w < f.y + f.w) out.push({ x: f.x, y: r.y + r.w, l: f.l, w: f.y + f.w - r.y - r.w });
    }
    return prune(out);
  }
  const grow = (o, g) => ({ x: o.x, y: o.y, l: o.l + g, w: o.w + g });
  function initFree(body, obst, g) {
    let free = [{ x: 0, y: 0, l: body.L + g, w: body.W + g }];
    for (const o of obst) free = splitFree(free, grow(o, g));
    return free;
  }

  // ---------- порядок вивантаження ----------
  // Для місця з точкою stop у смузі [y, y+w): мінімальний x (за тими, кого вивантажують пізніше) і максимальний кінець
  // (перед тими, кого вивантажують раніше). con = {stop, placed:[{x,y,l,w,stop}]}.
  function xRange(y, w, con) {
    let minX = 0, maxEnd = Infinity;
    if (!con || !con.stop) return [minX, maxEnd];
    for (const q of con.placed) {
      if (!q.stop || q.stop === con.stop) continue;
      if (!(y < q.y + q.w && q.y < y + w)) continue;
      if (q.stop > con.stop) minX = Math.max(minX, q.x + q.l);
      else maxEnd = Math.min(maxEnd, q.x);
    }
    return [minX, maxEnd];
  }

  // Найближче до кабіни місце для прямокутника l×w (уже з зазором). rot — можна повернути на 90°.
  function findBL(free, l, w, rot, g, con) {
    let best = null, s0 = 0, s1 = 0, s2 = 0;
    const tryO = (ll, ww, o) => {
      for (const f of free) {
        if (ll > f.l || ww > f.w) continue;
        let x = f.x;
        if (con && con.stop) {
          const [minX, maxEnd] = xRange(f.y, ww - g, con);
          x = Math.max(f.x, minX);
          if (x + ll > f.x + f.l || x + ll - g > maxEnd) continue;
        }
        const a = x + ll, b = f.y;
        if (!best || a < s0 || (a === s0 && (b < s1 || (b === s1 && o < s2)))) { best = { x, y: f.y, l: ll, w: ww }; s0 = a; s1 = b; s2 = o; }
      }
    };
    tryO(l, w, 0);
    if (rot && l !== w) tryO(w, l, 1);
    return best;
  }

  // ---------- шаблони для однакових місць у прямокутнику R ----------
  // a — довжина місця вздовж кузова, b — ширина (обидва з зазором); rot — чи можна повертати.
  function patterns(R, a, b, rot) {
    const out = [];
    const nP = Math.floor(R.w / b), nQ = rot && a !== b ? Math.floor(R.w / a) : 0;
    const row = (x0, P) => {
      const s = [], n = P ? nP : nQ, ll = P ? a : b, ww = P ? b : a;
      for (let k = 0; k < n; k++) s.push({ x: x0, y: R.y + k * ww, l: ll, w: ww });
      return s;
    };
    const iMax = nP > 0 ? Math.floor(R.l / a) : 0;
    for (let i = 0; i <= iMax; i++) {
      const j = nQ > 0 ? Math.floor((R.l - i * a) / b) : 0;
      if (i === 0 && j === 0) continue;
      const orders = i > 0 && j > 0 ? [true, false] : [i > 0];
      for (const pFirst of orders) {
        const slots = []; let x = R.x;
        const seq = pFirst ? [[true, i], [false, j]] : [[false, j], [true, i]];
        for (const [P, cnt] of seq) for (let r = 0; r < cnt; r++) { slots.push(...row(x, P)); x += P ? a : b; }
        out.push({ slots, kind: 'rows', uniform: i === 0 || j === 0 });
      }
    }
    const mP = Math.floor(R.l / a), mQ = rot && a !== b ? Math.floor(R.l / b) : 0;
    const col = (y0, P) => {
      const s = [], m = P ? mP : mQ, ll = P ? a : b, ww = P ? b : a;
      for (let k = 0; k < m; k++) s.push({ x: R.x + k * ll, y: y0, l: ll, w: ww });
      return s;
    };
    for (let cP = 0; cP <= Math.floor(R.w / b); cP++) {
      const cQ = mQ > 0 ? Math.floor((R.w - cP * b) / a) : 0;
      if ((cP === 0 || mP === 0) && cQ === 0) continue;
      const orders = cP > 0 && cQ > 0 ? [true, false] : [cP > 0];
      for (const pFirst of orders) {
        const slots = []; let y = R.y;
        const seq = pFirst ? [[true, cP], [false, cQ]] : [[false, cQ], [true, cP]];
        for (const [P, cnt] of seq) for (let c = 0; c < cnt; c++) { slots.push(...col(y, P)); y += P ? b : a; }
        out.push({ slots, kind: 'cols', uniform: cP === 0 || cQ === 0 });
      }
    }
    for (const p of out) p.slots.sort((u, v) => (u.x + u.l) - (v.x + v.l) || u.y - v.y || u.x - v.x);
    return out;
  }
  // Найкращий шаблон під qty місць: більше місць → коротше по довжині → рівні ряди → ряди раніше за колони.
  function bestPattern(R, a, b, rot, qty) {
    let best = null, key = null;
    for (const p of patterns(R, a, b, rot)) {
      const take = Math.min(qty, p.slots.length);
      if (!take) continue;
      let used = 0;
      for (let k = 0; k < take; k++) used = Math.max(used, p.slots[k].x + p.slots[k].l);
      const kk = [-take, used, p.uniform ? 0 : 1, p.kind === 'rows' ? 0 : 1];
      if (!key || lexLess(kk, key)) { best = { ...p, take, used }; key = kk; }
    }
    return best;
  }

  // ---------- розміщення ----------
  function placeAt(u, s, g) {
    const l = s.l - g, w = s.w - g;
    return { ...u, x: s.x, y: s.y, l, w, rotated: l !== u.l };
  }
  function groupBL(free, units, g, con) {
    const placed = [], rest = [];
    for (const u of units) {
      const s = findBL(free, u.l + g, u.w + g, u.rot, g, con);
      if (!s) { rest.push(u); continue; }
      free = splitFree(free, s);
      placed.push(placeAt(u, s, g));
    }
    return { free, placed, rest };
  }
  function slotOK(s, g, con) {
    if (!con || !con.stop) return true;
    const [minX, maxEnd] = xRange(s.y, s.w - g, con);
    return s.x >= minX && s.x + s.l - g <= maxEnd;
  }
  function groupPattern(free, units, g, bodyL, con) {
    if (!units.length) return { free, placed: [], rest: [] };
    const u0 = units[0], a = u0.l + g, b = u0.w + g;
    const cands = [...free].sort((p, q) => q.l * q.w - p.l * p.w).slice(0, 4);
    const tail = free.filter(f => f.x + f.l >= bodyL).sort((p, q) => q.l * q.w - p.l * p.w)[0];
    if (tail && !cands.includes(tail)) cands.push(tail);
    let best = null, key = null;
    for (const R of cands) {
      const p = bestPattern(R, a, b, u0.rot, units.length);
      if (!p) continue;
      let ok = true;
      for (let k = 0; k < p.take && ok; k++) ok = slotOK(p.slots[k], g, con);
      if (!ok) continue;
      const kk = [-p.take, R.x, p.used];
      if (!key || lexLess(kk, key)) { best = p; key = kk; }
    }
    if (!best) return groupBL(free, units, g, con);
    const placed = [];
    for (let k = 0; k < best.take; k++) { free = splitFree(free, best.slots[k]); placed.push(placeAt(units[k], best.slots[k], g)); }
    const r = groupBL(free, units.slice(best.take), g, con);
    return { free: r.free, placed: placed.concat(r.placed), rest: r.rest };
  }
  const maxX = list => list.reduce((m, p) => Math.max(m, p.x + p.l), 0);
  const areaOf = list => list.reduce((s, p) => s + p.l * p.w, 0);

  // Групуємо за слідом на підлозі (не за позицією): однакові палети різних позицій плануються одним шаблоном —
  // інакше 12 «наших» + 1 «ще» не знайшли б шаблон на 13.
  function groupsOf(units) {
    const m = new Map();
    for (const u of units) { const k = u.l + 'x' + u.w + '|' + (u.rot ? 1 : 0); if (!m.has(k)) m.set(k, []); m.get(k).push(u); }
    return [...m.values()];
  }
  const byArea = (p, q) => q[0].l * q[0].w - p[0].l * p[0].w;
  // Одна стратегія на одному кузові. ordered — враховувати точки вивантаження.
  function packBody(body, obst, units, g, strat, ordered) {
    const tooHigh = units.filter(u => u.h > body.H);
    const ok = units.filter(u => !(u.h > body.H));
    let free = initFree(body, obst, g);
    const L = body.L + g;
    let placed = [], rest = [...tooHigh];
    // черги: без порядку — одна; з порядком — від останньої точки (біля кабіни) до першої (біля дверей), без точки — в кінці
    const stops = ordered ? [...new Set(ok.map(u => u.stop || 0))].sort((a, b) => (b || -1) - (a || -1)) : [null];
    const con = ordered ? { stop: 0, placed: obst.filter(o => o.stop).map(o => ({ x: o.x, y: o.y, l: o.l, w: o.w, stop: o.stop })) } : null;
    for (const st of stops) {
      const part = st === null ? ok : ok.filter(u => (u.stop || 0) === st);
      if (con) con.stop = st;
      if (strat === 'bl' || strat === 'bl-area') {
        const list = strat === 'bl' ? part : [...part].sort((p, q) => q.l * q.w - p.l * p.w);
        const r = groupBL(free, list, g, con); free = r.free; placed = placed.concat(r.placed); rest = rest.concat(r.rest);
        if (con) con.placed.push(...r.placed.map(p => ({ x: p.x, y: p.y, l: p.l, w: p.w, stop: p.stop })));
      } else {
        let gs = groupsOf(part);
        if (strat === 'grp-area') gs = gs.sort(byArea);
        for (const grp of gs) {
          const A = groupPattern(free, grp, g, L, con), B = groupBL(free, grp, g, con);
          const pick = (A.placed.length > B.placed.length || (A.placed.length === B.placed.length && maxX(A.placed) <= maxX(B.placed))) ? A : B;
          free = pick.free; placed = placed.concat(pick.placed); rest = rest.concat(pick.rest);
          if (con) con.placed.push(...pick.placed.map(p => ({ x: p.x, y: p.y, l: p.l, w: p.w, stop: p.stop })));
        }
      }
    }
    return { placed, rest };
  }
  const STRATS = ['grp', 'bl', 'grp-area', 'bl-area'];
  // Усі кузови (зчіпка — два): кожна стратегія проходить кузови по черзі; беремо найкращу.
  function packAll(bodies, obstByBody, units, g, ordered) {
    let best = null, key = null;
    for (const st of STRATS) {
      let rest = units; const byBody = [];
      for (let bi = 0; bi < bodies.length; bi++) {
        const r = packBody(bodies[bi], obstByBody[bi] || [], rest, g, st, ordered);
        byBody.push(r.placed.map(p => ({ ...p, body: bi }))); rest = r.rest;
      }
      const all = byBody.flat();
      const used = byBody.reduce((s, b) => s + maxX(b), 0);
      const kk = [-all.length, -areaOf(all), used];
      if (!key || lexLess(kk, key)) { key = kk; best = { placed: all, unplaced: rest, strat: st }; }
    }
    const order = new Map(units.map((u, i) => [u.uid, i]));
    best.placed.sort((p, q) => order.get(p.uid) - order.get(q.uid));
    best.unplaced.sort((p, q) => order.get(p.uid) - order.get(q.uid));
    return best;
  }

  // ---------- наявний вантаж (що вже стоїть в авто) ----------
  // Повертає масив по кузовах: [{x,y,l,w,h,label,stop}] — у макеті їх можна пересувати.
  function buildExisting(ex, bodies) {
    const out = bodies.map(() => []);
    if (!ex || ex.mode === 'empty') return out;
    const stop = +ex.stop || 0;
    const total = bodies.reduce((s, b) => s + b.L, 0);
    const byLength = (occ, y0, w, label) => {      // зайнята довжина від кабіни, з переходом у 2-й кузов
      let rest = Math.max(0, Math.min(occ, total));
      bodies.forEach((b, bi) => {
        const o = Math.min(rest, b.L); rest -= o;
        if (o > 0) out[bi].push({ x: 0, y: y0(b), l: o, w: w(b), h: b.H, label, block: true, stop });
      });
    };
    if (ex.mode === 'meters') {
      const conv = v => ex.kind === 'free' ? total - v : v;
      if (!ex.split) byLength(conv(ex.all), () => 0, b => b.W, 'зайнято');
      else {
        const sy = b => Math.max(100, Math.min(b.W - 100, ex.splitY || Math.floor(b.W / 2)));
        byLength(conv(ex.s1), () => 0, b => sy(b), 'зайнято');
        byLength(conv(ex.s2), b => sy(b), b => b.W - sy(b), 'зайнято');
      }
    } else if (ex.mode === 'volume') {
      const b0 = bodies[0];
      const occ = ex.kind === 'pct' ? Math.round(total * ex.pct / 100) : Math.round(ex.m3 * 1e9 / (b0.W * b0.H));
      byLength(occ, () => 0, b => b.W, ex.kind === 'pct' ? ex.pct + '%' : ex.m3 + ' м³');
    } else if (ex.mode === 'pallets') {
      const t = PALLETS[ex.type] || { l: ex.l, w: ex.w };
      let left = ex.qty;
      bodies.forEach((b, bi) => {
        if (left <= 0) return;
        const p = bestPattern({ x: 0, y: 0, l: b.L, w: b.W }, t.l, t.w, true, left);
        if (!p) return;
        for (let k = 0; k < p.take; k++) { const s = p.slots[k]; out[bi].push({ x: s.x, y: s.y, l: s.l, w: s.w, h: ex.h || 0, label: 'є', pallet: true, stop }); }
        left -= p.take;
      });
    } else if (ex.mode === 'dims') {
      const units = [];
      ex.rows.forEach((r, ri) => { for (let k = 0; k < r.qty; k++) units.push({ uid: 'e' + ri + '-' + k, gid: 'e' + ri, l: r.l, w: r.w, h: r.h, rot: true, stop: +r.stop || stop }); });
      const res = packAll(bodies, bodies.map(() => []), units, 0, false);
      for (const p of res.placed) out[p.body].push({ x: p.x, y: p.y, l: p.l, w: p.w, h: p.h, label: 'є', stop: p.stop });
    }
    return out;
  }

  // ---------- наш вантаж → місця ----------
  function variantDims(it, v) {
    if (it.kind === 'long') return v === 'across' ? { l: it.w, w: it.l, h: it.h, shape: 'long', rot: false } : { l: it.l, w: it.w, h: it.h, shape: 'long', rot: false };
    const D = it.d, len = it.kind === 'roll' ? it.len : it.hgt;
    if (v === 'stand') return { l: D, w: D, h: len, shape: 'cyl-up', rot: false };
    if (v === 'lieY') return { l: D, w: len, h: D, shape: 'cyl-y', rot: false };
    return { l: len, w: D, h: D, shape: 'cyl-x', rot: false };   // lieX — лежачи вздовж кузова
  }
  const VARIANTS = { long: ['along', 'across'], roll: ['stand', 'lieX', 'lieY'], barrel: ['stand', 'lieX', 'lieY'] };
  function buildUnits(items, H, variantOf) {
    const units = [], bulk = [];
    for (const it of items) {
      const kg = +it.kg || 0, stop = +it.stop || 0;
      const push = (n, d) => { for (let k = 0; k < n; k++) units.push({ uid: it.id + '-' + k, gid: it.id, kg, stop, ...d }); };
      if (it.kind === 'pallet') {
        const t = PALLETS[it.ptype] || { l: it.l, w: it.w };
        push(it.qty, { l: t.l, w: t.w, h: +it.h || 0, rot: true, shape: 'pallet' });
      } else if (it.kind === 'bigbag') {
        const t = it.onPallet ? (PALLETS[it.ptype] || PALLETS.euro) : { l: it.l, w: it.w };
        push(it.qty, { l: t.l, w: t.w, h: it.h ? it.h + (it.onPallet ? 150 : 0) : 0, rot: true, shape: it.onPallet ? 'bag-pallet' : 'bag' });
      } else if (it.kind === 'box') {
        const per = it.stack && it.h ? Math.max(1, Math.floor(H / it.h)) : 1;
        let left = it.qty, k = 0;
        while (left > 0) {
          const n = Math.min(per, left); left -= n;
          units.push({ uid: it.id + '-' + k++, gid: it.id, l: it.l, w: it.w, h: n * (it.h || 0), layers: n, lh: it.h || 0, kg: kg * n, rot: true, shape: 'box', stop });
        }
      } else if (VARIANTS[it.kind]) {
        push(it.qty, variantDims(it, variantOf(it)));
      } else if (it.kind === 'bulk') {
        bulk.push({ gid: it.id, m3: +it.m3 || 0, kg, top: !!it.top });
      }
    }
    return { units, bulk };
  }

  // ---------- насипом ----------
  // Спершу (якщо позиції дозволено) — зверху на вантаж, від кабіни до дверей; решту — на вільну підлогу на всю висоту.
  // above — по кузовах [{x,y,l,w,h0}] простір над місцями з відомою висотою.
  function fillBulk(bodies, occByBody, bulk, above) {
    const cx = 100, cy = 50, res = bodies.map(() => []), tops = bodies.map(() => []), left = [];
    const need = bulk.map(b => b.m3 * 1e9);
    const sp = bodies.map((b, bi) => (above && above[bi] ? above[bi] : []).filter(a => a.h0 > 0 && a.h0 < b.H).map(a => ({ ...a, z: a.h0 })).sort((p, q) => p.x - q.x || p.y - q.y));
    bulk.forEach((b, k) => {
      if (!b.top) return;
      bodies.forEach((body, bi) => {
        for (const a of sp[bi]) {
          if (need[k] <= 0) return;
          if (a.z >= body.H) continue;
          const take = Math.min((body.H - a.z) * a.l * a.w, need[k]);
          const z1 = a.z + take / (a.l * a.w);
          tops[bi].push({ gid: b.gid, x: a.x, y: a.y, l: a.l, w: a.w, z0: a.z, z1 });
          a.z = z1; need[k] -= take;
        }
      });
    });
    const queue = bulk.map((b, k) => k).filter(k => need[k] > 0);
    let qi = 0;
    bodies.forEach((b, bi) => {
      if (qi >= queue.length) return;
      const nx = Math.ceil(b.L / cx), ny = Math.ceil(b.W / cy);
      const occ = new Uint8Array(nx * ny);
      for (const r of occByBody[bi]) {
        const x0 = Math.max(0, Math.floor(r.x / cx)), x1 = Math.min(nx, Math.ceil((r.x + r.l) / cx));
        const y0 = Math.max(0, Math.floor(r.y / cy)), y1 = Math.min(ny, Math.ceil((r.y + r.w) / cy));
        for (let i = x0; i < x1; i++) for (let j = y0; j < y1; j++) occ[i * ny + j] = 1;
      }
      for (let i = 0; i < nx && qi < queue.length; i++) {
        const runs = [];
        for (let j = 0; j < ny && qi < queue.length; j++) {
          if (occ[i * ny + j]) continue;
          const k = queue[qi], gid = bulk[k].gid;
          const cl = Math.min(cx, b.L - i * cx), cw = Math.min(cy, b.W - j * cy);
          need[k] -= cl * cw * b.H;
          const last = runs[runs.length - 1];
          if (last && last.gid === gid && last.y + last.w === j * cy) last.w += cw; else runs.push({ gid, x: i * cx, y: j * cy, l: cl, w: cw });
          if (need[k] <= 0) qi++;
        }
        for (const r of runs) {
          const prev = res[bi].find(p => p.gid === r.gid && p.y === r.y && p.w === r.w && p.x + p.l === r.x);
          if (prev) prev.l += r.l; else res[bi].push({ ...r, h: b.H, bulk: true });
        }
      }
    });
    bulk.forEach((b, k) => { if (need[k] > 0) left.push({ gid: b.gid, m3: need[k] / 1e9 }); });
    return { rects: res, tops, left };
  }

  // ---------- аналіз вільного місця ----------
  function unionArea(rects, body) {
    if (!rects.length) return 0;
    const xs = [...new Set(rects.flatMap(r => [Math.max(0, r.x), Math.min(body.L, r.x + r.l)]).concat([0, body.L]))].sort((a, b) => a - b);
    const ys = [...new Set(rects.flatMap(r => [Math.max(0, r.y), Math.min(body.W, r.y + r.w)]).concat([0, body.W]))].sort((a, b) => a - b);
    let s = 0;
    for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
      const mx = (xs[i] + xs[i + 1]) / 2, my = (ys[j] + ys[j + 1]) / 2;
      if (rects.some(r => mx > r.x && mx < r.x + r.l && my > r.y && my < r.y + r.w)) s += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    }
    return s;
  }
  // Скільки місць t (l×w) ще стане на вільну підлогу при поточній розкладці. fixed: 'P'|'Q' — лише одна орієнтація.
  function fillCount(body, occ, t, g, fixed) {
    let free = initFree(body, occ, g); let n = 0;
    const a = fixed === 'Q' ? t.w : t.l, b = fixed === 'Q' ? t.l : t.w;
    for (;;) {
      const s = findBL(free, a + g, b + g, !fixed, g, null);
      if (!s) break;
      free = splitFree(free, s); n++;
      if (n > 500) break;
    }
    return n;
  }
  function tailPatternCount(body, occ, t, g) {
    const free = initFree(body, occ, g); const L = body.L + g;
    const tail = free.filter(f => f.x + f.l >= L).sort((p, q) => q.l * q.w - p.l * p.w)[0];
    if (!tail) return 0;
    const p = bestPattern(tail, t.l + g, t.w + g, true, Infinity);
    if (!p) return 0;
    let fr = free; for (const s of p.slots) fr = splitFree(fr, s);
    let n = p.slots.length;
    for (;;) { const s = findBL(fr, t.l + g, t.w + g, true, g, null); if (!s) break; fr = splitFree(fr, s); n++; if (n > 500) break; }
    return n;
  }
  const aboveOf = (bodies, existing, placed) => bodies.map((b, bi) => [
    ...existing[bi].filter(r => !r.block && r.h > 0),
    ...placed.filter(p => p.body === bi && p.h > 0),
  ].map(r => ({ x: r.x, y: r.y, l: r.l, w: r.w, h0: r.h })));

  // Повний розрахунок. input: {bodies, arches, existing (по кузовах, уже розставлений), items, gap, countType, layoutMode, splitY}
  function analyze(input) {
    const { bodies, gap: g = 0 } = input;
    const arches = input.arches || bodies.map(() => []);
    const existing = input.existing || bodies.map(() => []);
    const obst = bodies.map((b, bi) => [...arches[bi], ...existing[bi]]);
    const H = Math.min(...bodies.map(b => b.H));
    const stopsSeen = new Set([...input.items.map(i => +i.stop || 0), ...existing.flat().map(r => r.stop || 0)].filter(Boolean));
    const hasStops = stopsSeen.size >= 2;
    const useOrdered = hasStops && input.layoutMode !== 'dense';

    // варіанти довгоміру/рулонів/бочок: рахуємо кожен, «авто» — найкращий
    const chosen = {}, variantInfo = {};
    const baseVariant = it => chosen[it.id] || (it.variant !== 'auto' ? it.variant : VARIANTS[it.kind][0]);
    for (const it of input.items.filter(x => VARIANTS[x.kind])) {
      variantInfo[it.id] = [];
      for (const v of VARIANTS[it.kind]) {
        const { units } = buildUnits(input.items, H, x => x.id === it.id ? v : baseVariant(x));
        const r = packAll(bodies, obst, units, g, useOrdered);
        const mine = r.placed.filter(p => p.gid === it.id);
        const d = variantDims(it, v);
        const reason = d.h > H ? 'вищі за кузов' : (d.l > Math.max(...bodies.map(b => b.L)) || d.w > Math.max(...bodies.map(b => b.W))) ? 'довші за кузов' : '';
        const usedAll = bodies.reduce((sum, _, bi) => sum + maxX(r.placed.filter(q => q.body === bi)), 0);
        variantInfo[it.id].push({ v, placed: mine.length, left: r.unplaced.filter(p => p.gid === it.id).length, all: r.unplaced.length, used: maxX(mine), usedAll, reason });
      }
      const best = [...variantInfo[it.id]].sort((p, q) => p.all - q.all || p.left - q.left || p.usedAll - q.usedAll || p.used - q.used)[0];
      chosen[it.id] = it.variant === 'auto' ? best.v : it.variant;
    }
    const variantOf = it => chosen[it.id] || VARIANTS[it.kind][0];
    const { units, bulk } = buildUnits(input.items, H, variantOf);
    const dense = packAll(bodies, obst, units, g, false);
    const ordered = hasStops ? packAll(bodies, obst, units, g, true) : null;
    const pk = useOrdered ? ordered : dense;
    const placedBy = bodies.map((_, bi) => pk.placed.filter(p => p.body === bi));
    const bulkRes = fillBulk(bodies, bodies.map((_, bi) => [...obst[bi], ...placedBy[bi]]), bulk, aboveOf(bodies, existing, pk.placed));

    // «ще влізе впритул»: скільки палет типу t можна додати, якщо система розкладе все заново (і насипом теж влізе)
    const t = PALLETS[input.countType || 'euro'] || PALLETS.euro;
    const basePlaced = pk.placed.length;
    const fits = n => {
      const extra = []; for (let k = 0; k < n; k++) extra.push({ uid: 'x' + k, gid: '__extra', l: t.l, w: t.w, h: 0, rot: true, kg: 0, stop: 0, shape: 'pallet' });
      const r = packAll(bodies, obst, units.concat(extra), g, useOrdered);
      if (r.placed.filter(p => p.gid === '__extra').length < n || r.placed.filter(p => p.gid !== '__extra').length < basePlaced) return false;
      if (!bulk.length) return true;
      const br = fillBulk(bodies, bodies.map((_, bi) => [...obst[bi], ...r.placed.filter(p => p.body === bi)]), bulk, aboveOf(bodies, existing, r.placed.filter(p => p.gid !== '__extra')));
      return !br.left.length;
    };
    let maxExtra = 0;
    if (!pk.unplaced.length && !bulkRes.left.length) {
      let freeArea = 0;
      bodies.forEach((b, bi) => { freeArea += b.L * b.W - unionArea([...obst[bi], ...placedBy[bi]], b); });
      let lo = 0, hi = Math.floor(freeArea / (t.l * t.w));
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
      maxExtra = lo;
    }
    const result = {
      units, placed: pk.placed, unplaced: pk.unplaced, strat: pk.strat, bulk: bulkRes, variantInfo, chosen, countType: t, maxExtra,
      hasStops, mode: useOrdered ? 'ordered' : 'dense',
      alt: hasStops ? { dense: dense.unplaced.length, ordered: ordered.unplaced.length } : null,
    };
    Object.assign(result, recount(input, result));
    return result;
  }

  // Перерахунок «що лишилось» для поточної розкладки (після ручного пересування теж).
  function recount(input, res) {
    const { bodies, gap: g = 0 } = input;
    const arches = input.arches || bodies.map(() => []);
    const existing = input.existing || bodies.map(() => []);
    const t = res.countType;
    const perBody = bodies.map((b, bi) => {
      const mine = res.placed.filter(p => p.body === bi);
      const bulkR = res.bulk.rects[bi] || [];
      const cargo = [...existing[bi], ...mine, ...bulkR];          // для «вільно по довжині» арки не рахуємо
      const occAll = [...arches[bi], ...cargo];
      const split = Math.max(100, Math.min(b.W - 100, input.splitY || Math.floor(b.W / 2)));
      const laneEnd = (y0, y1) => cargo.filter(r => r.y < y1 && r.y + r.w > y0).reduce((m, r) => Math.max(m, r.x + r.l), 0);
      const free1 = b.L - laneEnd(0, split), free2 = b.L - laneEnd(split, b.W);
      const freeArea = b.L * b.W - unionArea(occAll, b);
      const aboveAll = [...existing[bi].filter(r => !r.block && r.h > 0), ...mine.filter(p => p.h > 0)].reduce((s, r) => s + Math.max(0, b.H - r.h) * r.l * r.w, 0);
      const topUsed = (res.bulk.tops && res.bulk.tops[bi] || []).reduce((s, r) => s + (r.z1 - r.z0) * r.l * r.w, 0);
      const even = Math.max(fillCount(b, occAll, t, g, 'P'), fillCount(b, occAll, t, g, 'Q'));
      const now = Math.max(fillCount(b, occAll, t, g, null), tailPatternCount(b, occAll, t, g));
      return { free1, free2, split, freeVol: freeArea * b.H / 1e9, above: Math.max(0, aboveAll - topUsed) / 1e9, even, now };
    });
    const even = perBody.reduce((s, p) => s + p.even, 0);
    const now = perBody.reduce((s, p) => s + p.now, 0);
    const kgOur = res.placed.reduce((s, p) => s + (p.kg || 0), 0) + (input.items || []).filter(i => i.kind === 'bulk').reduce((s, i) => s + (+i.kg || 0), 0);
    const kgMissing = (input.items || []).filter(i => i.kind !== 'bulk' && !(+i.kg)).reduce((s, i) => s + (+i.qty || 0), 0);
    return {
      perBody, even, max: Math.max(res.maxExtra || 0, now, even),
      freeVol: perBody.reduce((s, p) => s + p.freeVol, 0), above: perBody.reduce((s, p) => s + p.above, 0),
      kgOur, kgMissing,
    };
  }

  // Перевірка ручного пересування: у кузові, без перетину з іншими (з урахуванням зазору).
  function checkMove(body, rect, others, g) {
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.l > body.L || rect.y + rect.w > body.W) return { ok: false, why: 'out' };
    const r = grow(rect, g);
    for (const o of others) if (inter(r, grow(o, g))) return { ok: false, why: 'hit', with: o };
    return { ok: true };
  }
  // Чи порушує місце порядок вивантаження відносно інших (для попередження після ручного пересування).
  function orderBreaks(rect, stop, others) {
    if (!stop) return [];
    return others.filter(q => q.stop && q.stop !== stop && rect.y < q.y + q.w && q.y < rect.y + rect.w &&
      ((q.stop > stop && rect.x < q.x + q.l) || (q.stop < stop && rect.x + rect.l > q.x)));
  }

  return { PALLETS, VARIANTS, analyze, recount, checkMove, orderBreaks, buildExisting, packAll, fillBulk, aboveOf, bestPattern, patterns, unionArea, fillCount, variantDims };
})();
if (typeof module !== 'undefined') module.exports = Engine;
