/**
 * Картинки, що вшиваються в документи: логотип юрособи, підпис і печатка.
 * PNG З ПРОЗОРИМ ФОНОМ (рішення 08.10: печатка поверх тексту, текст читається) —
 * байти в assets/docx/*.png ті САМІ, що вшиті в затверджений макет (IMG.*) —
 * не замінювати на «кращі» скани без пере-затвердження вигляду документа.
 *
 * Логотип (рішення 14–15.10): ЮТС — logo-uts.png, АвтоМув — logo-avm.png (напис AVTOMUV зі стрілкою,
 * без слогану), ФОП — без логотипа. Логотип є завжди — перемикач «Авто-підпис і печатка» його не прибирає.
 * ФОП: печатки немає (рішення 29.09 — «ЮТС і ФОП Беспятчук один і той самий підпис»).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocImages, EntityKey } from './docgen.js';
import { DEFAULT_IMG_DIM } from './docgen.js';

interface EntityFiles {
  logo?: string; logoDim?: [number, number];
  sig: string; sigDim: [number, number];
  stamp?: string; stampDim?: [number, number];
}

const FILES: Record<EntityKey, EntityFiles> = {
  uts: { logo: 'logo-uts.png', logoDim: DEFAULT_IMG_DIM.logoU,
         sig: 'sig-bespyatchuk.png', sigDim: DEFAULT_IMG_DIM.sigB, stamp: 'stamp-uts.png', stampDim: DEFAULT_IMG_DIM.stU },
  avm: { logo: 'logo-avm.png', logoDim: DEFAULT_IMG_DIM.logoA,
         sig: 'sig-kovtonyuk.png', sigDim: DEFAULT_IMG_DIM.sigK, stamp: 'stamp-avtomuv.png', stampDim: DEFAULT_IMG_DIM.stA },
  fop: { sig: 'sig-bespyatchuk.png', sigDim: DEFAULT_IMG_DIM.sigB }, // без логотипа і без печатки
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

/** Для docx. stampOn = перемикач «Авто-підпис і печатка» з форми: false → без підпису й печатки (логотип лишається). */
export function loadDocImages(assetsDir: string, ent: EntityKey, stampOn: boolean): DocImages {
  const f = FILES[ent];
  const img: DocImages = {};
  if (f.logo) { img.logo = read(assetsDir, f.logo); img.logoDim = f.logoDim; }
  if (!stampOn) return img;
  img.sig = read(assetsDir, f.sig); img.sigDim = f.sigDim;
  if (f.stamp) { img.stamp = read(assetsDir, f.stamp); img.stampDim = f.stampDim; }
  return img;
}

/** data:-URI тих самих байтів — для printTemplate (PDF/прев'ю), щоб збігалося з docx. */
export function docImageDataUris(assetsDir: string, ent: EntityKey, stampOn: boolean): { logo?: string; sig?: string; stamp?: string } {
  const f = FILES[ent];
  const uri = (u: Uint8Array) => 'data:image/png;base64,' + Buffer.from(u).toString('base64');
  const out: { logo?: string; sig?: string; stamp?: string } = {};
  if (f.logo) out.logo = uri(read(assetsDir, f.logo));
  if (!stampOn) return out;
  out.sig = uri(read(assetsDir, f.sig));
  if (f.stamp) out.stamp = uri(read(assetsDir, f.stamp));
  return out;
}
