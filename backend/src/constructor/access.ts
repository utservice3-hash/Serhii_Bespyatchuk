/**
 * 📄 КОНСТРУКТОР ДОКУМЕНТІВ — межа доступу й перевірка вхідного стану. Чисті функції без БД.
 *
 * Рішення Сергія 30.09.2026 (Telegram, дослівно): «кожен тільки свої бачить»; «Адмін має
 * бачить пул заявок, тобто окреме місце доступне де все видно». Отже:
 *  - автор бачить свої документи — у списку, за прямим id, у Word і PDF;
 *  - право `view_all_constructor_docs` бачить усі (пул);
 *  - більше НІХТО: ні тімлід, ні КВП без права. Чужий документ — 404, а не 403, щоб id не
 *    підтверджував існування чужого запису.
 *
 * 🔴 Одна функція на всі чотири місця (список, картка, Word, PDF) — щоб документ, схований у
 * списку, не відкривався за прямим посиланням. Той самий принцип, що `canSeeDocument` у модулі
 * «Регламенти та документи».
 */
import { ENTITIES } from './data/entities.js';
import type { DocumentState, EntityKey, DocKind, Party } from './services/docgen.js';

export const VIEW_ALL_PERM = 'view_all_constructor_docs';

export function canSeeConstructorDoc(viewerUserId: number, createdBy: number, canSeeAll: boolean): boolean {
  if (canSeeAll) return true;
  return Number.isInteger(viewerUserId) && viewerUserId > 0 && viewerUserId === createdBy;
}

const DOCS: readonly DocKind[] = ['once', 'main', 'carr', 'nrmain', 'nrapp', 'annex'];

/**
 * Знімок стану з тіла запиту → `DocumentState` або текст відмови.
 * У пакеті невідома юрособа падала 500-ю (`ENTITIES[undefined].name`); тут — 400 зі словами.
 * Сторона виводиться з виду документа: заявка перевізнику — завжди `carrier`, решта — `client`
 * (так само, як у формі пакета; розбіжність дала б перевізницький текст із клієнтською таблицею).
 * Менеджера з тіла НЕ беремо: він приходить із сесії (рішення 29.09 у README пакета).
 */
export function stateFromBody(body: unknown, manager: { name: string; phone: string }): DocumentState | string {
  const b = ((body as { state?: unknown })?.state ?? body ?? {}) as Record<string, unknown>;
  const ent = String(b.ent ?? '') as EntityKey;
  if (!(ent in ENTITIES)) return 'Оберіть юрособу: ЮТС, АвтоМув або ЄЛОГІСТ.';
  // ФОП прибрано з конструктора 30.10.2026 (місце — ЄЛОГІСТ). Архів ФОП перевидається з рядка БД (`routes/constructor.ts`
  // `stateFromRow`), не звідси, — тож нових документів ФОП не буде, а старі відкриваються як були.
  if (ent === 'fop') return 'ФОП більше не оформлюється — оберіть ЮТС, АвтоМув або ЄЛОГІСТ.';
  const doc = String(b.doc ?? '') as DocKind;
  if (!DOCS.includes(doc)) return 'Невідомий вид документа.';
  const party: Party = doc === 'carr' ? 'carrier' : 'client';
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {});
  const pay = obj(b.pay);
  return {
    ent, doc, party,
    intl: !!b.intl || doc === 'nrmain' || doc === 'nrapp', stamp: b.stamp !== false, fopAcc: Number(b.fopAcc) | 0,
    cp: obj(b.cp), trip: obj(b.trip),
    pay: { sum: String(pay.sum ?? ''), cur: String(pay.cur ?? 'грн'), form: String(pay.form ?? ''), order: String(pay.order ?? '') },
    dealNo: String(b.dealNo ?? '').trim(), docDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.docDate ?? '')) ? String(b.docDate) : '',
    mainNo: String(b.mainNo ?? '').trim(), mainDate: String(b.mainDate ?? ''), mainUntil: String(b.mainUntil ?? '').trim(),
    manager,
  };
}

/**
 * 📎 Що записати за клієнтом як його річний договір (задача 5777): лише основний договір і заявка-додаток, лише з
 * номером і впізнаваним кодом клієнта (ЄДРПОУ 8 / ІПН ФОП 10). Інакше `null` — не пишемо нічого.
 */
export function contractMemo(s: DocumentState): { code: string; no: string; date: string | null } | null {
  const code = (s.cp.edrpou || '').replace(/\D/g, '');
  if (!(s.doc === 'main' || s.doc === 'annex') || !s.mainNo || !/^\d{8}$|^\d{10}$/.test(code)) return null;
  return { code, no: s.mainNo, date: s.mainDate || null };
}

/** Безпечне ім'я файла з номера: лише літери, цифри й дефіс. */
export function fileBase(num: string): string {
  return num.replace(/[^\w-]/g, '-') || 'document';
}
