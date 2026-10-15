import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 💾 #140–#140b — ЗБЕРЕЖЕННЯ 1×1: ПОМИЛКА ВИДИМА, НЕЗБЕРЕЖЕНЕ НЕ ЗНИКАЄ МОВЧКИ.
 *
 * 🔴 БАГ, ЩО ЦЕ ПОРОДИВ. `save`, `doReview` і `addTask` у секції «Ван-ту-ван» стояли
 * як `try { await … } finally { setSaving(false) }` — БЕЗ `catch`. На 403/500 кнопка
 * просто переставала крутитись: анкети в базі немає, на екрані все на місці, підпис
 * «збережено ЧЧ:ХХ» лишався старим. Друга половина тієї самої діри: набране до
 * натискання «Зберегти» живе в локальному стані, а перемикання дати/людини/типу
 * перезавантажує запис — тобто текст зникав навіть без жодної помилки.
 *
 * 🔴 ЧОМУ ГЕЙТ «ЗБЕРЕГТИ → ПРОЧИТАТИ НАЗАД» ЦЬОГО НЕ ЛОВИТЬ. Він зелений: роут
 * справний, `POST /one-on-ones/record` пише і віддає. Ламався ПОКАЗ — рівно як у
 * Задачнику. Гейт, поставлений не на ту ланку, дав би багу зелене світло.
 *
 * ✅ ТОМУ ТУТ ГАНЯЄТЬСЯ СПРАВЖНІЙ МОДУЛЬ ФРОНТУ (транспіляція на льоту), а межі —
 * перевіряються по ДЖЕРЕЛУ секції. Переписати логіку «схоже» в тесті означало б
 * доводити ні про що: саботаж у справжньому файлі мусить червонити цей гейт.
 */

const FE_ROOT = new URL("../../../frontend/src/", import.meta.url);
const SAVE_TS = fileURLToPath(new URL("pages/dashboard/sections/oneOnOneSave.ts", FE_ROOT));
const SECTION = fileURLToPath(new URL("pages/dashboard/sections/OneOnOneSection.tsx", FE_ROOT));

/**
 * 🔴 КОМЕНТАРІ ВИРІЗАЮТЬСЯ ПЕРЕД ПОШУКОМ. У доках фіксу я цитую САМЕ хибні рядки
 * (`setSelId(s.id)`, «без catch»), і без вирізання гейт ловив би цитату — тобто
 * документування помилки робило б перевірку неможливою. Прийом уже вживаний (#58, #127).
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/** Транспіляція СПРАВЖНЬОГО модуля фронту → готовий до імпорту JS. */
async function loadSave(): Promise<{
  saveErrorText: (e: unknown, fallback?: string) => string;
  draftKey: (d: unknown) => string;
  hasUnsavedEdits: (snap: string | null, cur: unknown) => boolean;
  draftStoreKey: (userId: number, type: string, subjectId: number, date: string) => string;
  parseStoredDraft: (raw: string | null) => { at: string; draft: unknown } | null;
  draftExpired: (at: string, now: Date) => boolean;
  draftToRestore: (stored: { at: string; draft: unknown } | null, serverKey: string, serverUpdatedAt: string | null, now: Date) => unknown;
  DRAFT_TTL_DAYS: number;
}> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(SAVE_TS, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/** Тіло названої функції-стрілки в джерелі секції (для перевірки МЕЖІ, а не згадки імені). */
function bodyOf(src: string, name: string): string {
  const re = new RegExp(`const ${name} = (?:async )?\\(`);
  const m = re.exec(src);
  if (!m) return "";
  const from = m.index;
  // до кінця оголошення: рядок `};` на рівні тіла компонента, або `;` того ж рядка
  const tail = src.slice(from);
  const end = /\n {2}\};/.exec(tail);
  const oneLine = tail.indexOf("\n");
  return end && end.index < 1200 ? tail.slice(0, end.index) : tail.slice(0, oneLine);
}

/**
 * #140 — ПРОВАЛ ЗБЕРЕЖЕННЯ ДОХОДИТЬ ДО ЛЮДИНИ.
 *
 * 🧨 САБОТАЖ (виконано): прибрати `catch` із `save` — гейт червоніє на тілі save;
 * прибрати рендер `{err && …}` — червоніє на останній перевірці (стан, який ставлять
 * і не показують, — це та сама тиша, лише дорожча).
 */
test("#140 помилка збереження 1×1 не зникає мовчки", async () => {
  const { saveErrorText } = await loadSave();

  // 1. Повідомлення СЕРВЕРА доходить дослівно — роути 1×1 формулюють причину людськими
  //    словами («Цей запис проводив інший»), і підмінити її своїм «Помилка» = зробити
  //    гірше, ніж було.
  assert.equal(saveErrorText({ response: { status: 403, data: { error: "Цей запис проводив інший" } } }),
    "Цей запис проводив інший");

  // 2. Немає тексту від сервера — лишається КОД СТАНУ. «403» і «немає звʼязку» вимагають
  //    від людини різних дій, тож зливати їх в одне слово не можна.
  const s500 = saveErrorText({ response: { status: 500, data: {} } }, "Зустріч не збережена");
  assert.match(s500, /500/);
  assert.match(s500, /Зустріч не збережена/);

  // 3. 🔴 ГОЛОВНЕ: ПОРОЖНЬОГО ТЕКСТУ НЕ БУВАЄ НІ ЗА ЯКОГО ВХОДУ. Порожній рядок
  //    відрендерився б як відсутність помилки — тобто повернув би нас рівно в той баг,
  //    який лікуємо.
  for (const bad of [undefined, null, new Error("Network Error"), {}, { response: {} },
                     { response: { data: { error: "" } } }, { response: { data: { error: { zod: 1 } } } }]) {
    const txt = saveErrorText(bad);
    assert.equal(typeof txt, "string");
    assert.ok(txt.trim().length > 0, `🔴 порожній текст помилки для входу ${JSON.stringify(bad)}`);
  }

  // 4. Межа проходить по ДІЯХ: усі три записи мусять мати `catch`, що САМЕ показує помилку.
  const src = stripComments(readFileSync(SECTION, "utf8"));
  for (const fn of ["save", "doReview", "addTask"]) {
    const body = bodyOf(src, fn);
    assert.ok(body, `🔴 не знайдено ${fn} — гейт втратив предмет`);
    assert.match(body, /catch\s*\([\s\S]{0,20}\)\s*\{[\s\S]{0,160}setErr\(\s*saveErrorText\(/,
      `🔴 ${fn} ковтає помилку: немає catch, що показує її на екрані`);
  }

  // 5. 🪞 ДЗЕРКАЛО: стан помилки МАЄ бути відрендерений. Без цього все вище зеленіло б
  //    і для коду, який акуратно кладе текст у стан, якого ніхто не малює.
  assert.match(src, /\{err && \(/, "🔴 помилка нікуди не рендериться — знову тиша");
  assert.match(src, /⚠️ \{err\}/, "🔴 у банері немає самого тексту помилки");
});

/**
 * #140b — НЕЗБЕРЕЖЕНЕ НЕ ЗНИКАЄ ПРИ ПЕРЕХОДІ.
 *
 * 🧨 САБОТАЖ (виконано): повернути `onClick={() => setSelId(s.id)}` у списку людей →
 * червоніє на переліку переходів; зробити `leaveGuard = () => true` → червоніє на
 * перевірці, що замок узагалі когось питає.
 */
test("#140b перехід між датою/людиною/типом не викидає набране", async () => {
  const { draftKey, hasUnsavedEdits } = await loadSave();
  const base = { answers: { a1: { score: 8, text: "перше" } }, enpsScore: null,
    enpsReason: "", satisfaction: 7, notes: { pains: "затримки оплат" } };

  // 1. 🔴 ПОРЯДОК КЛЮЧІВ І ПОРОЖНІЙ ТЕКСТ — НЕ ПРАВКА. `answers` лежить у jsonb, який
  //    порядку не зберігає: без нормалізації попередження зринало б на КОЖНОМУ переході
  //    ще до того, як людина щось написала, — і його б перестали читати.
  const snap = draftKey(base);
  const reordered = { notes: { pains: "затримки оплат" }, satisfaction: 7, enpsReason: "",
    enpsScore: null, answers: { a1: { text: "перше", score: 8 } } };
  assert.equal(hasUnsavedEdits(snap, reordered), false, "🔴 інший порядок ключів прочитано як правку");
  assert.equal(hasUnsavedEdits(snap, { ...base, enpsReason: "   " }), false,
    "🔴 порожній текст прочитано як правку");

  // 2. Справжня правка — бачиться. По кожному полю окремо: якби бралось лише `answers`,
  //    нотатки HR (тип В) губились би тихо, і саме вони тут найдорожчі.
  assert.equal(hasUnsavedEdits(snap, { ...base, answers: { a1: { score: 8, text: "друге" } } }), true);
  assert.equal(hasUnsavedEdits(snap, { ...base, answers: { a1: { score: 9, text: "перше" } } }), true);
  assert.equal(hasUnsavedEdits(snap, { ...base, satisfaction: 3 }), true);
  assert.equal(hasUnsavedEdits(snap, { ...base, notes: { pains: "інше" } }), true);
  assert.equal(hasUnsavedEdits(snap, { ...base, enpsScore: 9 }), true);

  // 3. Запис ще не завантажено — питати нема про що.
  assert.equal(hasUnsavedEdits(null, base), false, "🔴 порожній знімок читається як незбережене");

  // 4. Замок справді КОГОСЬ питає — інакше «захист» був би написом.
  const src = stripComments(readFileSync(SECTION, "utf8"));
  const guard = bodyOf(src, "leaveGuard");
  assert.ok(guard, "🔴 не знайдено leaveGuard — гейт втратив предмет");
  assert.match(guard, /!dirty/, "🔴 замок не дивиться на наявність незбереженого");
  // Питає діалог дашборда з 09.10.2026 (прохід B, `#1510`); твердження те саме — замок когось питає.
  assert.match(guard, /await dlg\.confirm\(/, "🔴 замок нічого не питає — перехід тихий, як був");

  // 5. Усі ЧОТИРИ виходи з анкети йдуть через замок.
  for (const fn of ["pickSubject", "pickDate", "pickType", "pickMonth"]) {
    // З `await`: замок тепер повертає обіцянку, і без нього `if (!leaveGuard())` пропускав би перехід мовчки (`#1510b`).
    assert.match(bodyOf(src, fn), /await leaveGuard\(\)/, `🔴 ${fn} міняє екран повз замок (або кличе його без await)`);
  }

  // 6. 🔴 І САМІ ОБРОБНИКИ МУСЯТЬ КЛИКАТИ pick*, А НЕ СЕТЕР НАВПРОСТЕЦЬ. Правильна
  //    функція нічого не варта, поки виклик іде повз неї — рівно так виглядав баг
  //    Задачника (`patchTaskLocal` бездоганний, а поруч `.then(setTasks)`).
  assert.doesNotMatch(src, /onClick=\{\(\) => setSelId\(/,
    "🔴 вибір людини повернувся до прямого setSelId — набране знову зникає");
  assert.doesNotMatch(src, /onChange=\{\(v\) => v && setDateSel\(/,
    "🔴 вибір дати повернувся до прямого setDateSel");
  assert.doesNotMatch(src, /onClick=\{\(\) => setDateSel\(/,
    "🔴 чип журналу повернувся до прямого setDateSel");
  assert.doesNotMatch(src, /onClick=\{\(\) => \{ setType\(/,
    "🔴 перемикач типу повернувся до прямого setType");
});

/**
 * #1761 — ЧЕРНЕТКА 1×1 ПЕРЕЖИВАЄ ПЕРЕЗАВАНТАЖЕННЯ, АЛЕ НЕ ЗАТИРАЄ СВІЖІШЕ (задача 5760, Роман 15.10.2026: «коли
 * випадково перевантажив сторінку — все пропадає»). Правила — справжнім модулем, по обидва боки кожної межі.
 * Червоніє, якщо стара чернетка підставиться поверх пізнішого збереження, прострочена — відновиться, чернетка однієї
 * людини / дати / типу / акаунта потрапить в іншу анкету, або сміття в сховищі зламає екран.
 */
test("#1761 ЧЕРНЕТКА 1×1: відновлюється лише своя, свіжа й новіша за сервер; ключ — акаунт, тип, людина, дата", async () => {
  const { draftKey, draftStoreKey, parseStoredDraft, draftExpired, draftToRestore, DRAFT_TTL_DAYS } = await loadSave();
  const server = { answers: { a1: { score: 7 } }, enpsScore: null, enpsReason: "", satisfaction: 6, notes: {} };
  const typed = { ...server, answers: { a1: { score: 7, text: "просив перевести на інший напрям" } } };
  const now = new Date("2026-10-15T12:00:00Z");
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const sk = draftKey(server);

  // 1. Набране після останнього збереження — повертається.
  assert.deepEqual(draftToRestore({ at: at(1), draft: typed }, sk, at(5), now), typed, "🔴 незбережена чернетка не відновилась");
  assert.deepEqual(draftToRestore({ at: at(1), draft: typed }, sk, null, now), typed, "🔴 чернетка нової зустрічі (запису ще немає) не відновилась");
  // 2. 🔴 Сервер новіший за чернетку — перемагає сервер (зберіг пізніше, можливо з іншого пристрою).
  assert.equal(draftToRestore({ at: at(5), draft: typed }, sk, at(1), now), null, "🔴 стара чернетка затерла пізніше збереження");
  // 3. Те саме, що на сервері, — нічого відновлювати (інакше плашка «відновлено» на порожньому місці).
  assert.equal(draftToRestore({ at: at(1), draft: server }, sk, at(5), now), null, "🔴 «відновлено» без жодної різниці");
  // 4. Строк: межа по обидва боки.
  assert.equal(DRAFT_TTL_DAYS, 7);
  assert.equal(draftExpired(at(24 * 7 - 1), now), false, "🔴 шестиденна чернетка вважається простроченою");
  assert.equal(draftExpired(at(24 * 7 + 1), now), true, "🔴 чернетка старша за тиждень не прострочена");
  assert.equal(draftToRestore({ at: at(24 * 8), draft: typed }, sk, null, now), null, "🔴 прострочена чернетка відновилась");
  // 5. Сміття в сховищі — null, а не виняток.
  for (const raw of [null, "", "{", "[]", '{"at":"вчора","draft":{}}', '{"at":"2026-10-15T10:00:00Z"}']) {
    assert.equal(parseStoredDraft(raw), null, `🔴 сміття «${String(raw)}» прочитано як чернетку`);
  }
  assert.deepEqual(parseStoredDraft(JSON.stringify({ at: at(1), draft: typed })), { at: at(1), draft: typed });
  // 6. Ключ розрізняє КОЖЕН із чотирьох вимірів.
  const k = draftStoreKey(50, "A", 104, "2026-10-15");
  for (const other of [draftStoreKey(51, "A", 104, "2026-10-15"), draftStoreKey(50, "B", 104, "2026-10-15"),
    draftStoreKey(50, "A", 105, "2026-10-15"), draftStoreKey(50, "A", 104, "2026-10-14")]) {
    assert.notEqual(other, k, "🔴 чернетка однієї зустрічі відкриється в іншій");
  }
});

/**
 * #1761b — ЧЕРНЕТКА ПІДКЛЮЧЕНА В СЕКЦІЮ. Правила нічого не варті, поки секція кличе їх повз. Червоніє, якщо завантаження
 * не звіряється з чернеткою, знімок перестане бути СЕРВЕРНИМ (тоді відновлене виглядало б збереженим і «Зберегти» не
 * питали б), запис піде під ключ ще не завантаженого запису, «Зберегти» не прибере чернетку, або зникне плашка.
 */
test("#1761b ЧЕРНЕТКА В СЕКЦІЇ: звірка на завантаженні, знімок — серверний, запис лише у звірений ключ, «Зберегти» і «перейти» прибирають", () => {
  const src = stripComments(readFileSync(SECTION, "utf8"));
  assert.match(src, /const restore = draftToRestore\(stored, draftKey\(loaded\), r\.updated_at \?\? null, new Date\(\)\);/, "🔴 завантаження не звіряється з чернеткою");
  assert.match(src, /setNotes\(shown\.notes\); setSavedAt\(r\.updated_at \?\? null\); snap\(loaded\);/, "🔴 знімок узято з відновленого, а не з сервера — відновлене виглядає збереженим");
  assert.match(src, /if \(!key \|\| draftFor\.current !== key\) return;/, "🔴 чернетка пишеться під ключ запису, який ще не звірено");
  assert.match(src, /setTimeout\(\(\) => ls\.set\(key, JSON\.stringify\(\{ at: new Date\(\)\.toISOString\(\), draft \}\)\)/, "🔴 набране не пишеться в браузер");
  assert.match(bodyOf(src, "save"), /ls\.del\(draftStoreKey\(userId, type, selId, dateSel\)\)/, "🔴 «Зберегти» лишає чернетку — вона «відновиться» поверх збереженого");
  assert.match(bodyOf(src, "leaveGuard"), /ls\.del\(draftFor\.current\)/, "🔴 «перейти й втратити» лишає чернетку — вона воскресне");
  assert.match(src, /\{restoredAt && dirty && \(/, "🔴 немає плашки «відновлено» — людина не знає, що це ще не збережено");
  assert.match(src, /useState<O2OType>\(\(\) => restoreSel\.current\?\.type \?\? "A"\)/, "🔴 після перезавантаження не повертається тип анкети");
});
