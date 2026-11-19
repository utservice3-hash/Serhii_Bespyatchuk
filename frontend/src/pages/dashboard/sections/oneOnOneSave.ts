import type { OneOnOneAnswers, O2ONotes, O2OTaskReview } from "../../../api";

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

// ── ЧЕРНЕТКА ПЕРЕЖИВАЄ ПЕРЕЗАВАНТАЖЕННЯ (задача 5760, Роман 15.10.2026) ─────────────────────────────────────────────
// «Коли випадково перевантажив сторінку — все пропадає, сам з цим зіштовхнувся». Попередження `beforeunload` легко
// проклацати, а Safari на телефоні його не показує взагалі; перехід в інший розділ дашборда і зовсім не питає. Тому
// незбережена анкета пишеться в браузер (localStorage) і підставляється назад, коли відкриваєш ту саму зустріч.

/** Чернетки старші за тиждень — не відновлюються й прибираються: стара анкета не має тихо затерти свіжу. */
export const DRAFT_TTL_DAYS = 7;
export const DRAFT_PREFIX = "o2oDraft:";

/**
 * Ключ чернетки — РІВНО ключ запису на сервері (тип, субʼєкт, дата) плюс АКАУНТ, що її набирав. Без акаунта на
 * спільному компʼютері чернетка одного проводжувача підставилась би іншому; без будь-якого з решти трьох — чернетка
 * зустрічі з однією людиною відкрилась би в анкеті іншої.
 */
export function draftStoreKey(userId: number, type: string, subjectId: number, date: string): string {
  return `${DRAFT_PREFIX}${userId}:${type}:${subjectId}:${date}`;
}

/**
 * `base` — відбиток (`draftKey`) СЕРВЕРНИХ відповідей, від яких чернетка почалась (19.11.2026). Без нього єдиною
 * мірою «чи не затре чернетка свіжіше» був час запису на сервері — а його посуває й рев'ю задачі, яке відповідей не
 * чіпає. Старі чернетки без `base` живуть за старим правилом.
 */
export interface StoredDraft { at: string; draft: O2ODraft; base?: string }

/** Розбір того, що лежить у сховищі. Сміття (чужий формат, обрізаний JSON) — `null`, а не виняток посеред екрана. */
export function parseStoredDraft(raw: string | null): StoredDraft | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof v?.at !== "string" || Number.isNaN(Date.parse(v.at)) || !v.draft || typeof v.draft !== "object") return null;
    return typeof v.base === "string" ? { at: v.at, draft: v.draft, base: v.base } : { at: v.at, draft: v.draft };
  } catch { return null; }
}

/** Чернетка прострочена (старша за `DRAFT_TTL_DAYS`). */
export function draftExpired(at: string, now: Date): boolean {
  return now.getTime() - Date.parse(at) > DRAFT_TTL_DAYS * 86_400_000;
}

/**
 * Чи підставляти чернетку замість завантаженого з сервера запису. Так — лише коли ВСЕ разом:
 *  · вона є й не прострочена;
 *  · вона ВІДРІЗНЯЄТЬСЯ від серверного запису (`draftKey`) — інакше показувати «відновлено» нема чого;
 *  · вона НОВІША за останнє збереження на сервері. 🔴 Без цієї умови стара чернетка з цього компʼютера затерла б
 *    запис, який хтось (чи ти сам з іншого пристрою) зберіг пізніше.
 */
export function draftToRestore(stored: StoredDraft | null, serverKey: string, serverUpdatedAt: string | null, now: Date): O2ODraft | null {
  if (!stored || draftExpired(stored.at, now)) return null;
  if (draftKey(stored.draft) === serverKey) return null;
  // 🔁 ЧЕРНЕТКА ЗНАЄ, ВІД ЧОГО ПОЧАЛАСЬ (19.11.2026). Відповіді на сервері ті самі, що були, коли почали набирати, —
  // отже ніхто їх не перезаписав, і чернетка повертається, навіть якщо час запису посунуло рев'ю задачі («✓ Виконано»
  // пише в той самий запис і оновлює `updated_at`). Відповіді змінились — хтось зберіг інше, і перемагає сервер.
  if (typeof stored.base === "string") return stored.base === serverKey ? stored.draft : null;
  if (serverUpdatedAt && Date.parse(serverUpdatedAt) >= Date.parse(stored.at)) return null;
  return stored.draft;
}

// ── КУДИ ПОВЕРТАТИСЬ ПІСЛЯ ПЕРЕЗАВАНТАЖЕННЯ (19.11.2026) ─────────────────────────────────────────────────────────────
// Досі місяць лежав у сховищі НАЗАВЖДИ (`o2oMonth`): хто колись глянув вересень, той і в листопаді відкривав вересень —
// а сьогоднішня зустріч тоді виглядала зниклою. Тепер місце (тип, людина, дата) повертається лише свіжим; старше —
// екран відкривається на сьогодні.

/** Скільки годин місце на екрані вважається «щойно був тут». */
export const SEL_FRESH_HOURS = 12;

/** Чи ще свіже збережене місце. Без часу (запис старого формату) — не свіже. */
export function selStillFresh(at: string | null | undefined, now: Date): boolean {
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return false;
  const age = now.getTime() - Date.parse(at);
  return age >= 0 && age <= SEL_FRESH_HOURS * 3_600_000;
}

// ── ЩО ВИРІШИЛИ НА ЦІЙ ЗУСТРІЧІ (19.11.2026) ──────────────────────────────────────────────────────────────────────────
// «✓ Виконано / ✗ Ні / ✗ Знято» одразу пишеться в запис зустрічі (`task_reviews`), але на формі ніде не показувалось:
// позначена задача просто зникала з блоку, і після перезавантаження не лишалось сліду, що її обговорили.

/** Останнє рішення по кожній задачі цієї зустрічі (позначку могли змінити — показується підсумок), у порядку дій. */
export function reviewsOfMeeting(reviews: readonly O2OTaskReview[] | null | undefined): O2OTaskReview[] {
  const last = new Map<number, O2OTaskReview>();
  for (const r of reviews ?? []) {
    if (!r || typeof r.taskId !== "number") continue;
    const prev = last.get(r.taskId);
    if (!prev || Date.parse(r.at) >= Date.parse(prev.at)) last.set(r.taskId, r);
  }
  return [...last.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
