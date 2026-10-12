/**
 * 3D-вигляд (three.js r128 — та сама версія, що в затвердженому макеті; вантажиться лише при відкритті 3D).
 * Миша — обертати, колесо — масштаб, Shift / права кнопка — зсув; вантаж тягнеться по підлозі (ті самі правила, що в 2D).
 */
import type { AnalyzeResult, Body, Item, Obstacle, Rect } from '../../shared/cargoEngine';
import { GAPB, type Sel } from './topView';

/* eslint-disable @typescript-eslint/no-explicit-any */
type ThreeNS = any;
export interface MoveCheck { ok: boolean; why?: 'out' | 'hit'; with?: Rect & Record<string, unknown> }
export interface DragRect extends Rect { body: number }
export interface Scene3D { bodies: Body[]; arches: Obstacle[][]; existing: Obstacle[][]; result: AnalyzeResult; items: Item[]; sel: Sel | null }
export interface View3DDeps {
  THREE: ThreeNS;
  el: HTMLElement;                                   // контейнер .stage3d
  color(k: string): string;                          // токен теми → колір
  scene(): Scene3D | null;
  rectOf(ref: Sel): DragRect | null;
  snapRect(rc: Rect, bi: number, ref: Sel): Rect;
  validRect(rc: Rect, bi: number, ref: Sel): MoveCheck;
  onSelect(ref: Sel): void;
  onIdle(): void;                                    // клік без руху
  onCommit(ref: Sel, bi: number, rc: Rect): void;
  onReject(v: MoveCheck): void;
}
export interface View3D { build(resetCam: boolean): void; draw(): void; destroy(): void }

export function createView3D(d: View3DDeps): View3D {
  const { THREE, el } = d;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  el.insertBefore(renderer.domElement, el.firstChild);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1, 0.05, 300);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.92));
  const dl = new THREE.DirectionalLight(0xffffff, 0.55); dl.position.set(-6, 12, 9); scene.add(dl);
  const root = new THREE.Group(); scene.add(root);
  const orb = { th: 1.2, ph: 1.0, r: 12, tx: 0, ty: 0.4, tz: 0 };
  let pick: any[] = [], bodyX: number[] = [];

  const size = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
  const draw = () => {
    camera.position.set(orb.tx + orb.r * Math.sin(orb.ph) * Math.cos(orb.th), orb.ty + orb.r * Math.cos(orb.ph), orb.tz + orb.r * Math.sin(orb.ph) * Math.sin(orb.th));
    camera.lookAt(orb.tx, orb.ty, orb.tz); renderer.render(scene, camera);
  };
  const ro = new ResizeObserver(() => { size(); draw(); }); ro.observe(el);

  function build(resetCam: boolean) {
    const sc = d.scene(); if (!sc) return;
    const C = d.color, { bodies: B, result: R, items } = sc;
    const itemOf = (gid: string) => items.find(i => i.id === gid);
    while (root.children.length) { const c = root.children.pop(); c.traverse((n: any) => { if (n.geometry) n.geometry.dispose(); if (n.material) n.material.dispose(); }); }
    scene.background = new THREE.Color(C('surface-2'));
    pick = [];
    const m = (v: number) => v / 1000; let acc = 0; bodyX = [];
    B.forEach((b, i) => { bodyX[i] = acc; acc += m(b.L) + m(GAPB); });
    const mat = (col: string, op = 1) => new THREE.MeshLambertMaterial({ color: new THREE.Color(col), transparent: op < 1, opacity: op, depthWrite: op >= 0.5 });
    const edges = (geo: any, col: string, op = 1) => new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: new THREE.Color(col), transparent: op < 1, opacity: op }));
    const box = (l: number, h: number, w: number, col: string, op: number, x: number, y: number, z: number, edgeCol?: string) => {
      const g = new THREE.BoxGeometry(l, h, w); const mesh = new THREE.Mesh(g, mat(col, op)); mesh.position.set(x, y, z);
      const grp = new THREE.Group(); grp.add(mesh); if (edgeCol) { const e = edges(g, edgeCol, 0.55); e.position.copy(mesh.position); grp.add(e); }
      return grp;
    };
    const wallC = C('wall');
    B.forEach((b, bi) => {
      const x0 = bodyX[bi], L = m(b.L), W = m(b.W), H = m(b.H);
      root.add(box(L, 0.03, W, C('floor'), 1, x0 + L / 2, -0.015, W / 2));
      const pts: any[] = []; for (let k = 1; k < b.L / 1000; k++) pts.push(new THREE.Vector3(x0 + k, 0.002, 0), new THREE.Vector3(x0 + k, 0.002, W));
      if (pts.length) root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: new THREE.Color(C('grid')) })));
      const shell = new THREE.BoxGeometry(L, H, W); const se = edges(shell, wallC, 0.9); se.position.set(x0 + L / 2, H / 2, W / 2); root.add(se); shell.dispose();
      const wm = () => new THREE.MeshLambertMaterial({ color: new THREE.Color(wallC), transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
      const front = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wm()); front.rotation.y = Math.PI / 2; front.position.set(x0, H / 2, W / 2); root.add(front);
      const s1 = new THREE.Mesh(new THREE.PlaneGeometry(L, H), wm()); s1.position.set(x0 + L / 2, H / 2, 0); root.add(s1);
      const s2 = new THREE.Mesh(new THREE.PlaneGeometry(L, H), wm()); s2.position.set(x0 + L / 2, H / 2, W); root.add(s2);
      if (bi === 0) root.add(box(1.7, Math.min(2.6, H * 0.9), W * 0.94, C('brand'), 0.9, x0 - 0.95, Math.min(2.6, H * 0.9) / 2, W / 2, wallC));
    });
    sc.arches.forEach((list, bi) => list.forEach(a => root.add(box(m(a.l), m(a.h || 0), m(a.w), C('arch'), 1, bodyX[bi] + m(a.x + a.l / 2), m(a.h || 0) / 2, m(a.y + a.w / 2)))));
    sc.existing.forEach((list, bi) => list.forEach((r, k) => {
      const hgt = r.block || !r.h ? m(B[bi].H) : m(r.h);
      const g = box(m(r.l) - 0.01, hgt, m(r.w) - 0.01, C('exist'), r.block || !r.h ? 0.28 : 0.62, bodyX[bi] + m(r.x + r.l / 2), hgt / 2, m(r.y + r.w / 2), C('ink-2'));
      g.userData = { ref: { kind: 'e', id: bi + ':' + k } }; root.add(g); pick.push(g);
    }));
    for (const p of R.placed) {
      const it = itemOf(p.gid); if (!it) continue;
      const col = C('c' + (it.c || 1)), g = new THREE.Group(), known = p.h > 0, op = known ? 1 : 0.45;
      const L = m(p.l), W = m(p.w), Hh = known ? m(p.h) : 1.0;
      if (p.shape === 'pallet' || p.shape === 'bag-pallet') {
        g.add(box(L, 0.144, W, '#b48a5c', 1, 0, 0.072, 0, '#6b4f2e'));
        g.add(box(L * 0.97, Math.max(0.05, Hh - 0.15), W * 0.97, col, op, 0, 0.144 + (Hh - 0.15) / 2, 0, C('ink')));
      } else if (p.shape === 'box') {
        const lh = m(p.lh || 400), n = p.layers || 1;
        for (let k = 0; k < n; k++) g.add(box(L * 0.985, lh * 0.97, W * 0.985, col, 1, 0, k * lh + lh / 2, 0, C('ink')));
      } else if (p.shape && p.shape.startsWith('cyl')) {
        const r = Math.min(L, W, Hh) / 2 * 0.98, len = p.shape === 'cyl-up' ? Hh : p.shape === 'cyl-x' ? L : W;
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 28), mat(col));
        if (p.shape === 'cyl-x') { mesh.rotation.z = Math.PI / 2; mesh.position.y = r; } else if (p.shape === 'cyl-y') { mesh.rotation.x = Math.PI / 2; mesh.position.y = r; } else mesh.position.y = len / 2;
        g.add(mesh);
      } else g.add(box(L * 0.98, Hh, W * 0.98, col, op, 0, Hh / 2, 0, C('ink')));
      g.position.set(bodyX[p.body] + m(p.x + p.l / 2), 0, m(p.y + p.w / 2));
      g.userData = { ref: { kind: 'u', id: p.uid } };
      if (sc.sel && sc.sel.kind === 'u' && sc.sel.id === p.uid) g.add(box(L + 0.03, 0.02, W + 0.03, C('ink'), 1, 0, 0.01, 0));
      root.add(g); pick.push(g);
    }
    R.bulk.rects.forEach((list, bi) => list.forEach(r => { const it = itemOf(r.gid); if (it) root.add(box(m(r.l), m(r.h), m(r.w), C('c' + (it.c || 1)), 0.22, bodyX[bi] + m(r.x + r.l / 2), m(r.h) / 2, m(r.y + r.w / 2))); }));
    (R.bulk.tops || []).forEach((list, bi) => list.forEach(t => { const it = itemOf(t.gid); if (it) root.add(box(m(t.l), m(t.z1 - t.z0), m(t.w), C('c' + (it.c || 1)), 0.25, bodyX[bi] + m(t.x + t.l / 2), m((t.z0 + t.z1) / 2), m(t.y + t.w / 2))); }));
    if (resetCam) {
      const tot = acc - m(GAPB), Wm = m(Math.max(...B.map(b => b.W)));
      Object.assign(orb, { tx: (tot - 1.8) / 2, ty: 0.4, tz: Wm / 2, r: Math.max(6, tot * 0.92 + 4), th: 1.2, ph: 1.0 });
    }
    size(); draw();
  }

  // ---------- миша ----------
  const cv: HTMLCanvasElement = renderer.domElement, ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let mode: 'orbit' | 'pan' | 'drag' | null = null, last = { x: 0, y: 0 };
  let dd: { ref: Sel; rc: DragRect; obj: any; p0: any; cand: { rc: Rect; bi: number; v: MoveCheck } | null; moved: boolean } | null = null;
  const setRay = (e: PointerEvent) => { const bb = cv.getBoundingClientRect(); ndc.set(((e.clientX - bb.left) / bb.width) * 2 - 1, -((e.clientY - bb.top) / bb.height) * 2 + 1); ray.setFromCamera(ndc, camera); };
  const hit = (e: PointerEvent) => { setRay(e); const hs = ray.intersectObjects(pick, true); if (!hs.length) return null; let o = hs[0].object; while (o && !(o.userData && o.userData.ref)) o = o.parent; return o; };
  const floorAt = (e: PointerEvent) => { setRay(e); const pt = new THREE.Vector3(); return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt) ? pt : null; };
  cv.addEventListener('pointerdown', (e: PointerEvent) => {
    cv.setPointerCapture(e.pointerId); last = { x: e.clientX, y: e.clientY };
    const o = (!e.shiftKey && e.button === 0) ? hit(e) : null;
    if (o) {
      const ref = o.userData.ref as Sel, rc = d.rectOf(ref), p0 = floorAt(e);
      if (rc && p0) { d.onSelect(ref); dd = { ref, rc, obj: o, p0, cand: null, moved: false }; mode = 'drag'; return; }
    }
    mode = (e.shiftKey || e.button === 2) ? 'pan' : 'orbit';
  });
  cv.addEventListener('pointermove', (e: PointerEvent) => {
    if (!mode) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
    if (mode === 'orbit') { orb.th += dx * 0.008; orb.ph = Math.min(1.5, Math.max(0.12, orb.ph - dy * 0.008)); draw(); }
    else if (mode === 'pan') { const k = orb.r * 0.0016, sx = Math.sin(orb.th), cx = Math.cos(orb.th); orb.tx += (sx * dx + cx * dy) * k; orb.tz += (-cx * dx + sx * dy) * k; draw(); }
    else if (mode === 'drag' && dd) {
      const sc = d.scene(); const p = floorAt(e); if (!p || !sc) return; dd.moved = true;
      let bi = dd.rc.body; const gx = bodyX[dd.rc.body] + dd.rc.x / 1000 + (p.x - dd.p0.x);
      for (let k = 0; k < sc.bodies.length; k++) if (gx + dd.rc.l / 2000 >= bodyX[k] && gx + dd.rc.l / 2000 <= bodyX[k] + sc.bodies[k].L / 1000) bi = k;
      const rc = d.snapRect({ x: (gx - bodyX[bi]) * 1000, y: dd.rc.y + (p.z - dd.p0.z) * 1000, l: dd.rc.l, w: dd.rc.w }, bi, dd.ref);
      const v = d.validRect(rc, bi, dd.ref); dd.cand = { rc, bi, v };
      dd.obj.position.x = bodyX[bi] + (rc.x + rc.l / 2) / 1000; dd.obj.position.z = (rc.y + rc.w / 2) / 1000;
      dd.obj.traverse((n: any) => { if (n.isMesh && n.material && n.material.emissive) n.material.emissive.set(v.ok ? 0x000000 : 0x7a0000); });
      draw();
    }
  });
  const up = () => {
    if (mode === 'drag' && dd) {
      const x = dd; dd = null; mode = null;
      if (!x.moved || !x.cand) { build(false); d.onIdle(); return; }
      if (x.cand.v.ok) d.onCommit(x.ref, x.cand.bi, x.cand.rc); else { d.onReject(x.cand.v); build(false); }
      return;
    }
    mode = null;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('contextmenu', (e: Event) => e.preventDefault());
  cv.addEventListener('wheel', (e: WheelEvent) => { e.preventDefault(); orb.r = Math.min(60, Math.max(2, orb.r * Math.exp(e.deltaY * 0.001))); draw(); }, { passive: false });

  return {
    build, draw,
    destroy() {
      ro.disconnect();
      while (root.children.length) { const c = root.children.pop(); c.traverse((n: any) => { if (n.geometry) n.geometry.dispose(); if (n.material) n.material.dispose(); }); }
      renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss();
      cv.remove();
    },
  };
}
