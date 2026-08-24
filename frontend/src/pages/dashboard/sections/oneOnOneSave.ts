import type { OneOnOneAnswers, O2ONotes } from "../../../api";

/**
 * 💾 ЗБЕРЕЖЕННЯ 1×1: ПОМИЛКА МУСИТЬ БУТИ ВИДИМОЮ, А НЕЗБЕРЕЖЕНЕ — НЕ ЗНИКАТИ МОВЧКИ.
 *
 * 🔴 ПРИВІД. `save`, `doReview` і `addTask` у секції стояли як `try { await … }
 * finally { setSaving(false) }` — БЕЗ `catch`. На 403/500 кнопка просто переставала
 * крутитись: анкети в базі немає, на екрані все на місці, підпис «збережено ЧЧ:ХХ»
 * лишався старим. Це рівно той клас, що коштував нам коментаря в Задачнику: система
 * мовчить саме тоді, коли має кричати.
 *
 * 🔴 І ДРУГА ПОЛОВИНА ТІЄЇ САМОЇ ДІРИ. Анкета живе в локальному стані до натискання
 * «Зберегти», а перемикання дати/людини/типу перезавантажує запис із сервера. Тобто
 * набраний, але не збережений текст зникав без жодного питання — не через помилку, а
 * «штатно». Для типу В там нотатки HR: обставини, болі, прохання. Другого разу людина
 * цього не переказує.
 *
 * ✅ ЧОМУ ТУТ ЧИСТІ ФУНКЦІЇ, А НЕ ЛОГІКА ВСЕРЕДИНІ КОМПОНЕНТА. Обидва правила треба
 * доводити САБОТАЖЕМ (гейти #140/#140b), а компонент без браузера не запускається.
 * Ці три функції — те, що можна прогнати як є, справжнім модулем, а не переказом.
 */

/** Чернетка анкети — РІВНО ті поля, що їдуть у `POST /one-on-ones/record`. */
export interface O2ODraft {
  answers: OneOnOneAnswers;
  enpsScore: number | null;
  enpsReason: string;
  satisfaction: number | null;
  notes: O2ONotes;
}

/** Текст попередження при виході з незбереженої анкети. */
export const UNSAVED_PROMPT =
  "У цій анкеті є незбережені зміни.\n\nЯкщо перейти зараз — набране зникне. " +
  "Скасувати й натиснути «Зберегти»?\n\nOK — перейти й втратити зміни.";

/** Текст для браузерного попередження при закритті вкладки (текст показує сам браузер). */
export const UNSAVED_BEFOREUNLOAD = "У анкеті 1×1 є незбережені зміни.";

/**
 * Текст помилки збереження. Ніколи не повертає порожній рядок — інакше «показ
 * помилки» знову перетворився б на тишу.
 *
 * 🔴 ПОРЯДОК ДЖЕРЕЛ НЕ ДОВІЛЬНИЙ. Спершу повідомлення СЕРВЕРА (роути 1×1 віддають
 * `{error:"…"}` і формулюють причину людськими словами: «Цей запис проводив інший»,
 * «Субʼєкт поза вашим скоупом»). Якщо його немає — код стану, бо «сервер відповів
 * 403» і «немає звʼязку» вимагають від людини РІЗНИХ дій, і злити їх в одне
 * «Помилка» означало б віддати їй здогад замість відповіді.
 */
export function saveErrorText(e: unknown, fallback = "Не вдалося зберегти"): string {
  const ax = e as { response?: { status?: number; data?: { error?: unknown } }; message?: string };
  const srv = ax?.response?.data?.error;
  if (typeof srv === "string" && srv.trim()) return srv.trim();
  const status = ax?.response?.status;
  if (typeof status === "number") return `${fallback} — сервер відповів ${status}`;
  return `${fallback} — немає звʼязку з сервером`;
}

/**
 * Нормалізація перед порівнянням. Прибирає те, що НЕ є зміною для людини:
 * порожній текст, `null`/`undefined`, і — головне — ПОРЯДОК КЛЮЧІВ.
 *
 * 🔴 БЕЗ ЦЬОГО ЗАХИСТ СТАВ БИ ШУМОМ. `answers` лежить у Postgres як `jsonb`, а він
 * порядок ключів не зберігає: після перезавантаження запису поля повертаються в
 * іншому порядку, і наївне порівняння рядків оголосило б анкету «зміненою», ще поки
 * до неї ніхто не торкнувся. Попередження, що зринає щоразу, люди прощіпують не
 * читаючи — і тоді воно не рятує вже НІЧОГО, включно зі справжньою втратою тексту.
 * Те саме з порожнім текстом: набрав і стер — це не правка.
 */
function norm(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") { const t = v.trim(); return t === "" ? undefined : t; }
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const nv = norm((v as Record<string, unknown>)[k]);
      if (nv !== undefined) out[k] = nv;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
}

/** Стабільний відбиток чернетки: однаковий зміст → однаковий рядок, попри порядок ключів. */
export function draftKey(d: O2ODraft): string {
  return JSON.stringify(norm({
    answers: d.answers, enpsScore: d.enpsScore, enpsReason: d.enpsReason,
    satisfaction: d.satisfaction, notes: d.notes,
  }) ?? {});
}

/**
 * Чи є незбережені правки. `snapshot === null` = запис ще не завантажений, тобто
 * берегти нічого — і питати теж нічого (інакше перше ж відкриття екрана зустріло б
 * людину попередженням про втрату того, чого вона не писала).
 */
export function hasUnsavedEdits(snapshot: string | null, cur: O2ODraft): boolean {
  return snapshot !== null && draftKey(cur) !== snapshot;
}
