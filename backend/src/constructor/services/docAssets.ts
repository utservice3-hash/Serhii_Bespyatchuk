/**
 * Підпис і печатка для вшивання в документи.
 * PNG З ПРОЗОРИМ ФОНОМ (рішення 08.10: печатка поверх тексту, текст читається) —
 * байти в assets/docx/*.png ті САМІ, що вшиті в затверджений макет —
 * не замінювати на «кращі» скани без пере-затвердження вигляду документа.
 * ФОП: печатки немає (рішення 29.09 — «ЮТС і ФОП Беспятчук один і той самий підпис»,
 * тому підпис той самий файл, що в ЮТС).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocImages, EntityKey } from './docgen.js';
import { DEFAULT_IMG_DIM } from './docgen.js';

const FILES: Record<EntityKey, { sig: string; sigDim: [number, number]; stamp?: string; stampDim?: [number, number] }> = {
  uts: { sig: 'sig-bespyatchuk.png', sigDim: DEFAULT_IMG_DIM.sigB, stamp: 'stamp-uts.png', stampDim: DEFAULT_IMG_DIM.stU },
  avm: { sig: 'sig-kovtonyuk.png', sigDim: DEFAULT_IMG_DIM.sigK, stamp: 'stamp-avtomuv.png', stampDim: DEFAULT_IMG_DIM.stA },
  fop: { sig: 'sig-bespyatchuk.png', sigDim: DEFAULT_IMG_DIM.sigB }, // без печатки
};

const cache = new Map<string, Uint8Array>();

/**
 * 🔧 Дашборд (30.09.2026): картинки лежать ЛИШЕ на сервері (`backend/documents/constructor-assets`,
 * поза git — репозиторій публічний). Файла немає → зрозуміла відмова з назвою файла, а не 500 з ENOENT.
 */
export class AssetsMissing extends Error {}

function read(assetsDir: string, name: string): Uint8Array {
  const key = join(assetsDir, name);
  let v = cache.get(key);
  if (!v) {
    try { v = new Uint8Array(readFileSync(key)); }
    catch { throw new AssetsMissing(`На сервері немає файла підпису/печатки «${name}». Зніміть «Авто-підпис і печатка» або зверніться до адміністратора.`); }
    cache.set(key, v);
  }
  return v;
}

/** stampOn = перемикач «Авто-підпис і печатка» з форми; false → документ без картинок. */
export function loadDocImages(assetsDir: string, ent: EntityKey, stampOn: boolean): DocImages {
  if (!stampOn) return {};
  const f = FILES[ent];
  const img: DocImages = { sig: read(assetsDir, f.sig), sigDim: f.sigDim };
  if (f.stamp) { img.stamp = read(assetsDir, f.stamp); img.stampDim = f.stampDim; }
  return img;
}

/** data:-URI тих самих байтів — для printTemplate (PDF/прев'ю), щоб збігалося з docx. */
export function docImageDataUris(assetsDir: string, ent: EntityKey, stampOn: boolean): { sig?: string; stamp?: string } {
  if (!stampOn) return {};
  const f = FILES[ent];
  const uri = (u: Uint8Array) => 'data:image/png;base64,' + Buffer.from(u).toString('base64');
  const out: { sig?: string; stamp?: string } = { sig: uri(read(assetsDir, f.sig)) };
  if (f.stamp) out.stamp = uri(read(assetsDir, f.stamp));
  return out;
}
