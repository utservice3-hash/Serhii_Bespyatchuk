/**
 * 📥 PPTX ІЗ ШАБЛОНУ ДАШІ (04.11.2026). Шаблон — її файл «UTS_щотижнева_зустріч.pptx» (сервер віддає його керівництву,
 * `GET /nominations/pptx-template`); тут — підставити в нього модель слайдів (`presentationModel.ts`) і фото. Дизайн,
 * шрифти й розкладка лишаються її; кожен текст редагується в PowerPoint.
 *
 * Без бібліотек і без імпортів під час виконання (гейт #3469 транспілює й ВИКОНУЄ цей файл): розпаковка — вбудованим
 * `DecompressionStream("deflate-raw")`, запаковка — збереженням без стиснення (той самий прийом, що генератор документів
 * конструктора). Тексти шаблону міняються ЗА ПОРЯДКОВИМ НОМЕРОМ `<a:t>` на слайді — номери зняті з її файлу; якщо Даша
 * змінить шаблон, номери треба переглянути (гейт перевіряє, що жодної заглушки на кшталт «[Ім’я Прізвище]» не лишилось).
 */
import type { PresModel, TopKey, AwardM } from "./presentationModel";

/* ─────────────────────────── zip ─────────────────────────── */

export async function unzip(u8: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("шаблон пошкоджений: не zip");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("шаблон пошкоджений: каталог");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + csize);
    if (method === 0) out.set(name, raw.slice());
    else if (method === 8) {
      const stream = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    } else throw new Error(`шаблон: невідомий метод стиснення ${method}`);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (u8: Uint8Array) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

/** Zip без стиснення («stored»). `[Content_Types].xml` — першим, як у PowerPoint. */
export function zipStore(files: Map<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], cdir: { name: Uint8Array; crc: number; size: number; off: number }[] = [];
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const names = [...files.keys()].sort((a, b) => (a === "[Content_Types].xml" ? -1 : b === "[Content_Types].xml" ? 1 : 0));
  let off = 0;
  for (const n of names) {
    const name = enc.encode(n), data = files.get(n)!, crc = crc32(data);
    const head = new Uint8Array([0x50, 0x4B, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    parts.push(head, name, data); cdir.push({ name, crc, size: data.length, off }); off += head.length + name.length + data.length;
  }
  const cdOff = off; let cdLen = 0;
  for (const c of cdir) {
    const rec = new Uint8Array([0x50, 0x4B, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(c.crc), ...u32(c.size), ...u32(c.size),
      ...u16(c.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.off)]);
    parts.push(rec, c.name); cdLen += rec.length + c.name.length;
  }
  parts.push(new Uint8Array([0x50, 0x4B, 5, 6, ...u16(0), ...u16(0), ...u16(cdir.length), ...u16(cdir.length), ...u32(cdLen), ...u32(cdOff), ...u16(0)]));
  const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

/* ─────────────────────────── правка слайдів ─────────────────────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Замінити тексти `<a:t>` за порядковим номером на слайді. */
export function setRuns(xml: string, map: Record<number, string>): string {
  let i = -1;
  return xml.replace(/<a:t>([^<]*)<\/a:t>/g, (whole) => { i++; return i in map ? `<a:t>${esc(map[i])}</a:t>` : whole; });
}
export const runsOf = (xml: string): string[] => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);

type Box = { x: number; y: number; cx: number; cy: number };
const boxOf = (block: string): Box | null => {
  const m = /<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(block);
  return m ? { x: +m[1], y: +m[2], cx: +m[3], cy: +m[4] } : null;
};
/**
 * Фото в коло шаблону: картинка-значок `rId` стає фото на всю площу кола (трохи всередині, щоб лишилась обводка), з
 * формою «еліпс»; звʼязок `rId` веде на новий файл фото. Кола без значка не чіпаємо.
 */
export function placePhoto(xml: string, rels: string, rId: string, target: string): { xml: string; rels: string } {
  const ellipses = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).filter((b) => b.includes('prst="ellipse"')).map(boxOf).filter((b): b is Box => !!b);
  const out = xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/g, (pic) => {
    if (!pic.includes(`r:embed="${rId}"`)) return pic;
    const b = boxOf(pic);
    if (!b) return pic;
    const cx = b.x + b.cx / 2, cy = b.y + b.cy / 2;
    const ring = ellipses.find((e) => cx >= e.x && cx <= e.x + e.cx && cy >= e.y && cy <= e.y + e.cy);
    if (!ring) return pic;
    const inset = Math.round(ring.cx * 0.045);
    return pic
      .replace(/<a:off x="-?\d+" y="-?\d+"\/>(\s*)<a:ext cx="\d+" cy="\d+"\/>/, `<a:off x="${ring.x + inset}" y="${ring.y + inset}"/>$1<a:ext cx="${ring.cx - 2 * inset}" cy="${ring.cy - 2 * inset}"/>`)
      .replace(/prst="rect"/, 'prst="ellipse"');
  });
  const newRels = rels.replace(new RegExp(`(<Relationship[^>]*Id="${rId}"[^>]*Target=")[^"]+(")`), `$1${target}$2`)
    .replace(new RegExp(`(<Relationship[^>]*Target=")[^"]+("[^>]*Id="${rId}")`), `$1${target}$2`);
  return { xml: out, rels: newRels };
}

/* ─────────────────────────── прив'язка до шаблону Даші ─────────────────────────── */

/** Ключі фото: `team`, `event:<вид>`, `top:<номінація>:<рядок>`, `award:<відзнака>`, `lg:maxDeal`, `lg:quotes`. */
export type PhotoSlot = string;
/** Фото, які потрібні моделі: ключ слоту → хто на ньому (менеджер Kommo чи співробітник). Компонент дістає байти. */
export function photoNeeds(m: PresModel): { slot: PhotoSlot; managerId?: number; employeeId?: number; team?: true }[] {
  const out: { slot: PhotoSlot; managerId?: number; employeeId?: number; team?: true }[] = [{ slot: "team", team: true }];
  for (const kind of ["birthday", "newcomer", "position"] as const) {
    const e = m.events?.find((x) => x.kind === kind);
    if (e) out.push({ slot: `event:${kind}`, employeeId: e.employeeId });
  }
  for (const k of ["maxDeal", "revenue", "cars", "intl"] as TopKey[]) m.tops[k].rows.forEach((r, i) => out.push({ slot: `top:${k}:${i}`, managerId: r.managerId }));
  if (m.awards) for (const [k, a] of Object.entries(m.awards) as [string, AwardM][]) {
    if (a.employeeId != null) out.push({ slot: `award:${k}`, employeeId: a.employeeId });
    else if (a.managerId != null) out.push({ slot: `award:${k}`, managerId: a.managerId });
  }
  if (m.leadgen?.maxDeal.managerId != null) out.push({ slot: "lg:maxDeal", managerId: m.leadgen.maxDeal.managerId });
  if (m.leadgen?.quotes.managerId != null) out.push({ slot: "lg:quotes", managerId: m.leadgen.quotes.managerId });
  return out;
}

const dmy = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/**
 * Заповнити шаблон. `photos` — JPEG-байти за ключем слоту (квадратні; коло обріже). Повертає нові файли архіву.
 * Слайд із фіксованою кількістю місць: зайве не влазить — хто лишився, дописуємо в підпис внизу слайда (файл редагований).
 */
export function fillPptx(files: Map<string, Uint8Array>, m: PresModel, photos: Map<PhotoSlot, Uint8Array>): Map<string, Uint8Array> {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const out = new Map(files);
  const date = dmy(m.meeting);
  // Чернетка (тиждень не зафіксовано) — словами в кожному підписі, як водяний знак на екрані.
  const foot = (extra?: string) => `UTS • Комерційний відділ • ${date}${m.draft ? " • ЧЕРНЕТКА" : ""}${extra ? ` • ${extra}` : ""}`;
  const slide = (n: number, runs: Record<number, string>, pics: Record<string, PhotoSlot> = {}) => {
    const path = `ppt/slides/slide${n}.xml`, relPath = `ppt/slides/_rels/slide${n}.xml.rels`;
    let xml = setRuns(dec.decode(out.get(path)!), runs);
    let rels = dec.decode(out.get(relPath)!);
    for (const [rId, slot] of Object.entries(pics)) {
      const bytes = photos.get(slot);
      if (!bytes) continue;
      const file = `pres-${n}-${rId}.jpg`;
      out.set(`ppt/media/${file}`, bytes);
      ({ xml, rels } = placePhoto(xml, rels, rId, `../media/${file}`));
    }
    out.set(path, enc.encode(xml)); out.set(relPath, enc.encode(rels));
  };

  // 1 · Титул
  // Підпис-заглушку «Фото команди» прибираємо, коли фото є: інакше він лягає поверх нього.
  slide(1, { 2: `Комерційний відділ • ${date}`, ...(photos.has("team") ? { 5: "" } : {}) } as Record<number, string>, { rId2: "team" });

  // 2 · Події тижня: по одній картці на вид; решта — у підпис
  const ev = m.events ?? [];
  const first = (k: "birthday" | "newcomer" | "position") => ev.find((e) => e.kind === k) ?? null;
  const card = (e: ReturnType<typeof first>, empty: string) => e ? [short(e.name), e.text, ""] : ["—", empty, ""];
  const [b, nw, ps] = [first("birthday"), first("newcomer"), first("position")];
  const rest = ev.filter((e) => e !== b && e !== nw && e !== ps).map((e) => `${e.tag.toLowerCase()}: ${short(e.name)}`);
  const [b1, b2, b3] = card(b, "Днів народження цього тижня немає"), [n1, n2, n3] = card(nw, "Новачків цього тижня немає"), [p1, p2, p3] = card(ps, "Нових посад цього тижня немає");
  slide(2, { 2: foot(rest.length ? `також: ${rest.join(", ")}` : undefined), 5: b1, 6: b2, 7: b3, 9: n1, 10: n2, 11: n3, 13: p1, 14: p2, 15: p3 },
    { rId2: "event:birthday", rId3: "event:newcomer", rId4: "event:position" });

  // Слайда без даних на екрані немає — у файлі теж: у шаблоні на ньому ПРИКЛАД Даші (чужі імена й суми, «27.10.2026»), і
  // незаповнений він пішов би на зустріч як цифри тижня.
  if (!ev.length) dropSlide(out, 2);
  if (!m.pulse) dropSlide(out, 3);
  if (!m.awards) dropSlide(out, 6);
  if (!m.leadgen) dropSlide(out, 7);
  if (!m.conv) dropSlide(out, 8);

  // 3 · Пульс плану
  if (m.pulse) {
    const q = m.pulse;
    slide(3, { 0: q.monthLabel, 2: foot(), 4: q.pct == null ? "—" : `${q.pct}%`, 8: `${num(q.fact)} /`, 9: `${num(q.plan)} ₴`, 11: q.left == null ? "план виконано" : `${num(q.left)} ₴`, 13: `${num(q.expect)} ₴` });
  }

  // 4–5 · Топ-3
  const topRuns = (k: TopKey, base: number, slot: string) => {
    const r: Record<number, string> = {}, pics: Record<string, string> = {};
    for (let i = 0; i < 3; i++) {
      const row = m.tops[k].rows[i];
      r[base + i * 3] = row ? String(row.place) : "";
      r[base + i * 3 + 1] = row ? row.name : "—";
      r[base + i * 3 + 2] = row ? `${row.text}${row.manual ? " ✎" : ""}` : "";
    }
    return { r, pics, slot };
  };
  const tiedNote = (a: TopKey, b2: TopKey) => [m.tops[a].tied, m.tops[b2].tied].filter((t) => t.length).map((t) => `з тим самим результатом: ${t.join(", ")}`).join(" • ");
  const s4a = topRuns("maxDeal", 5, "maxDeal"), s4b = topRuns("revenue", 15, "revenue");
  slide(4, { 2: foot(["однаковий результат = однакове місце", tiedNote("maxDeal", "revenue")].filter(Boolean).join(" • ")), ...s4a.r, ...s4b.r },
    { rId2: "top:maxDeal:0", rId3: "top:maxDeal:1", rId4: "top:maxDeal:2", rId5: "top:revenue:0", rId6: "top:revenue:1", rId7: "top:revenue:2" });
  const s5a = topRuns("cars", 5, "cars"), s5b = topRuns("intl", 15, "intl");
  slide(5, { 2: foot(["однаковий результат = однакове місце", tiedNote("cars", "intl")].filter(Boolean).join(" • ")), ...s5a.r, ...s5b.r },
    { rId2: "top:cars:0", rId3: "top:cars:1", rId4: "top:cars:2", rId5: "top:intl:0", rId6: "top:intl:1", rId7: "top:intl:2" });

  // 6 · Особливі відзнаки
  if (m.awards) {
    const a = m.awards, nm = (x: AwardM) => (x.names.length ? x.names.map(short).join(", ") : "немає претендентів");
    slide(6, { 2: foot("по одному переможцю, щоб не затягувати"), 7: nm(a.proryv), 8: a.proryv.value ?? "", 12: nm(a.clients), 13: a.clients.value ?? "",
      17: nm(a.sniper), 18: a.sniper.value ?? "", 22: nm(a.rookie), 23: a.rookie.value ?? "" },
    { rId3: "award:proryv", rId5: "award:clients", rId7: "award:sniper", rId9: "award:rookie" });
  }

  // 7 · Лідогенерація
  if (m.leadgen) {
    const l = m.leadgen;
    // Немає даних — «—» великим числом і пояснення дрібним рядком імені (великим шрифтом фраза не влазить у картку).
    slide(7, { 2: foot(), 5: l.maxDeal.text ? `${l.maxDeal.text}${l.maxDeal.manual ? " ✎" : ""}` : "—", 6: l.maxDeal.name ?? "дані не внесено",
      8: l.quotes.text ? `${l.quotes.text}${l.quotes.manual ? " ✎" : ""}` : "—", 9: l.quotes.name ?? "дані не внесено", 10: "Також: ", 11: "", 12: l.also },
    { rId2: "lg:maxDeal", rId3: "lg:quotes" });
  }

  // 8 · Лідерборд конверсії — 4 рядки шаблону
  if (m.conv) {
    // У шаблоні 4 рядки; хто з відмічених «на слайд» не вліз — імена в підпис, а не мовчки зникає.
    const over = m.conv.rows.slice(4).map((x) => `${x.n}. ${x.name} ${x.pct}`);
    const r: Record<number, string> = { 2: foot(["конверсія = успіх / цільові ліди", over.length ? `далі: ${over.join(", ")}` : ""].filter(Boolean).join(" • ")) };
    for (let i = 0; i < 4; i++) {
      const row = m.conv.rows[i], base = 10 + i * 6;
      [r[base], r[base + 1], r[base + 2], r[base + 3], r[base + 4], r[base + 5]] = row
        ? [String(row.n), row.name, String(row.taken), String(row.won), row.pct, row.trend] : ["", "", "", "", "", ""];
    }
    if (m.conv.comment) r[35] = m.conv.comment;
    slide(8, r);
  }

  // 9 · Фокус: є текст — ставимо; немає — лишаємо її заглушку, щоб дописати у файлі
  if (m.focus) slide(9, { 2: m.focus, 3: "", 4: "" });

  // Типи вмісту: JPEG-фото
  const ct = dec.decode(out.get("[Content_Types].xml")!);
  if (!/Extension="jpg"/i.test(ct)) out.set("[Content_Types].xml", enc.encode(ct.replace("<Types ", "<Types ").replace(/(<Types[^>]*>)/, `$1<Default Extension="jpg" ContentType="image/jpeg"/>`)));
  return out;
}
/** Прибрати слайд N шаблону з архіву: зі списку презентації, її звʼязків, типів вмісту — і сам файл. */
export function dropSlide(files: Map<string, Uint8Array>, n: number): void {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const relsPath = "ppt/_rels/presentation.xml.rels";
  const rels = dec.decode(files.get(relsPath)!);
  const rel = new RegExp(`<Relationship[^>]*Target="slides/slide${n}\\.xml"[^>]*/>`).exec(rels)?.[0];
  const rId = rel && /Id="([^"]+)"/.exec(rel)?.[1];
  if (!rel || !rId) return;
  files.set(relsPath, enc.encode(rels.replace(rel, "")));
  const pres = dec.decode(files.get("ppt/presentation.xml")!);
  files.set("ppt/presentation.xml", enc.encode(pres.replace(new RegExp(`<p:sldId [^>]*r:id="${rId}"/>`), "")));
  const ct = dec.decode(files.get("[Content_Types].xml")!);
  files.set("[Content_Types].xml", enc.encode(ct.replace(new RegExp(`<Override PartName="/ppt/slides/slide${n}\\.xml"[^>]*/>`), "")));
  files.delete(`ppt/slides/slide${n}.xml`);
  files.delete(`ppt/slides/_rels/slide${n}.xml.rels`);
}
const short = (n: string) => n.split(/\s+/).slice(0, 2).join(" ");
const num = (v: number) => Math.round(v).toLocaleString("uk-UA").replace(/[  ]/g, " ");
