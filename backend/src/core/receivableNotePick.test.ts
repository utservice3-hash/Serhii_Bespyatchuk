import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pickRowNote, type RowNote } from "./receivableNotePick.js";

/**
 * 🗒 #253–#253d — НОТАТКИ, ЩО ЛИШИЛИСЬ НА ПСЕВДОНІМАХ ПІСЛЯ ОБʼЄДНАННЯ.
 *
 * 📐 Заміряно 01.09.2026 на живому проді:
 *   курєрканал → смартекс          27.08 · дедлайн є · коментар 9 символів
 *   групакомпаній → автострадавк   27.08 · дедлайн є · коментар ПОРОЖНІЙ
 *   тексгруп → смартекс            20.08 · дедлайн є · коментар 5 символів
 * Усі три невидимі на екрані, бо рядок читав ЛИШЕ канонічний ключ.
 *
 * ⚠️ І ОДРАЗУ ДРУГЕ ЧИСЛО, БЕЗ ЯКОГО ПЕРШЕ БРЕШЕ: поточний тиждень почався
 * 31.08, тож ЖОДНА з трьох не стає коментарем тижня. Вони стають ВИДНИМИ
 * (підписані юрособою, з датами), але поле коментаря не займають. Це два різні
 * твердження, і плутати їх не можна — саме на цьому правило «нотатка
 * тритижневої давності вилізе як свіжа» і трималось.
 */

const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const FE_SPEC = (p: string) => srcOf(`../../../frontend/src/${p}`);

const note = (p: Partial<RowNote>): RowNote => ({
  clientKey: "канон", counterpartyName: "КАНОН ТОВ", comment: "текст",
  dueDate: "2026-08-28", updatedAt: "2026-08-27T09:43:00Z", isCanonical: true, ...p,
});

test("#253 нотатка з ПСЕВДОНІМА досяжна в наборі — і підписана юрособою", () => {
  const picked = pickRowNote([
    note({ clientKey: "канон", counterpartyName: "КАНОН ТОВ", comment: "старе",
           updatedAt: "2026-08-20T10:00:00Z", isCanonical: true }),
    note({ clientKey: "псевдо-а", counterpartyName: "ПСЕВДО-А ТОВ", comment: "свіже",
           updatedAt: "2026-08-27T09:00:00Z", isCanonical: false }),
    note({ clientKey: "псевдо-б", counterpartyName: "ПСЕВДО-Б ТОВ", comment: "давнє",
           updatedAt: "2026-07-31T10:00:00Z", isCanonical: false }),
  ]);

  assert.equal(picked.primary?.clientKey, "псевдо-а",
    "🔴 свіжіший запис із псевдоніма не дійшов до рядка — саме це й ховало склейку");
  assert.equal(picked.primary?.comment, "свіже");
  assert.equal(picked.othersCount, 2, "🔴 решта набору не порахована");
  assert.deepEqual(picked.otherNames, ["КАНОН ТОВ", "ПСЕВДО-Б ТОВ"],
    "🔴 решта названа не юрособами — «ще 2» без назв не каже людині, чого саме не видно");

  // 🏷 Без назви юрособи підписом стає ключ — порожнеча тут читалась би як
  // «запис нізвідки», а це найгірший із можливих підписів.
  const noName = pickRowNote([
    note({ clientKey: "канон", updatedAt: "2026-08-27T10:00:00Z" }),
    note({ clientKey: "сирий-ключ", counterpartyName: null, isCanonical: false,
           updatedAt: "2026-08-26T10:00:00Z" }),
  ]);
  assert.deepEqual(noName.otherNames, ["сирий-ключ"],
    "🔴 запис без назви юрособи лишився без будь-якого підпису");

  // Порожній набір — не виняток і не вигаданий запис.
  assert.deepEqual(pickRowNote([]), { primary: null, otherNames: [], othersCount: 0 });
});

test("#253b 🪞 ДЗЕРКАЛО: запис ІНШОГО тижня НЕ стає коментарем поточного", async () => {
  // Односторонній гейт тут коштує найдорожче: «показати все, що знайшли»
  // проходить #253 і оживляє тритижневу обіцянку як сьогоднішню — ми полагодили
  // б одну неправду, створивши іншу.
  const { activeNote, isCurrentWeekNote } =
    await import(FE_SPEC("pages/dashboard/receivablesView.ts"));

  // Вівторок 01.09.2026; тиждень почався в понеділок 31.08 за Києвом.
  const now = new Date("2026-09-01T12:00:00Z");

  const stale = pickRowNote([
    note({ clientKey: "тексгруп", counterpartyName: "ТЕКСГРУП ТОВ", comment: "обіцяв оплатити",
           updatedAt: "2026-08-20T10:28:00Z", isCanonical: false }),
  ]);
  assert.equal(stale.primary?.clientKey, "тексгруп",
    "🔴 запис із псевдоніма не дійшов — перевіряти далі нічого");
  assert.equal(isCurrentWeekNote(stale.primary!.updatedAt, now), false,
    "🔴 запис 20.08 визнано записом тижня, що почався 31.08");
  assert.equal(activeNote(stale.primary!.comment, stale.primary!.updatedAt, now), "",
    "🔴 тритижнева обіцянка показується як домовленість цього тижня");

  // 🪞 І другий бік: свіжий запис із псевдоніма ЗОБОВʼЯЗАНИЙ показатись.
  // Без цієї половини «завжди порожньо» було б зеленим, а фіча — мертвою.
  const fresh = pickRowNote([
    note({ clientKey: "псевдо-а", counterpartyName: "ПСЕВДО-А ТОВ", comment: "оплата в пʼятницю",
           updatedAt: "2026-08-31T08:00:00Z", isCanonical: false }),
  ]);
  assert.equal(activeNote(fresh.primary!.comment, fresh.primary!.updatedAt, now), "оплата в пʼятницю",
    "🔴 свіжий запис із псевдоніма не показується — фіча мертва, а гейт зелений");
});

test("#253c ПОРІГ 60 с: у вікні виграє запис ЗІ ЗМІСТОМ, поза вікном — свіжіший", () => {
  // 📐 Заміряно на проді 01.09.2026, «автострадавк»:
  //     псевдонім ГРУПА КОМПАНІЙ  09:43:46.071 · дедлайн 29.08 · коментар 0 символів
  //     канонічний АВТОСТРАДА ВК  09:43:41.695 · дедлайн 28.08 · коментар 29 символів
  // Різниця 4.376 с. Без порога виграє порожній запис, і екран показує МЕНШЕ,
  // ніж показував до зміни.
  //
  // 🔴 Обґрунтування порога (рішення власника): два записи на дві РІЗНІ юрособи
  // за чотири секунди не можуть бути двома людськими рішеннями — хай там що їх
  // писало. Нижче порога час не несе змісту; вище — несе.
  //
  // ⚠️ Фікстура СИНТЕТИЧНА і названа так свідомо: вона перевіряє ВЛАСТИВІСТЬ
  // порядку, а не відтворює сьогоднішній стан бази. Гейт, привʼязаний до
  // наявності потрібної пари в живих даних, зеленів би лише в ті дні, коли вона
  // там випадково є (клас `#220`/`#221`).
  const base = Date.parse("2026-08-27T09:43:41.695Z");
  const at = (ms: number) => new Date(base + ms).toISOString();

  // ① У ВІКНІ (4.376 с) — виграє той, у кого є коментар, хай він і старіший.
  const inWindow = pickRowNote([
    note({ clientKey: "групакомпаній", counterpartyName: "ГРУПА КОМПАНІЙ АВТОСТРАДА ТОВ",
           comment: "", dueDate: "2026-08-29", updatedAt: at(4376), isCanonical: false }),
    note({ clientKey: "автострадавк", counterpartyName: "АВТОСТРАДА ВК",
           comment: "чекаємо оплату до кінця тижня", dueDate: "2026-08-28", updatedAt: at(0), isCanonical: true }),
  ]);
  assert.equal(inWindow.primary?.clientKey, "автострадавк",
    "🔴 у вікні порога виграв ПОРОЖНІЙ запис — екран показує менше, ніж до зміни");
  assert.equal(inWindow.primary?.dueDate, "2026-08-28",
    "🔴 дедлайн зсунувся через різницю в 4 секунди");
  assert.deepEqual(inWindow.otherNames, ["ГРУПА КОМПАНІЙ АВТОСТРАДА ТОВ"]);

  // ② 🪞 ДЗЕРКАЛО — ПОЗА ВІКНОМ (година): час знову несе зміст, свіжіший виграє.
  // Без цієї половини «завжди виграє запис зі змістом» було б зеленим, і свіжа
  // порожня домовленість назавжди ховалась би під старим текстом.
  const outWindow = pickRowNote([
    note({ clientKey: "псевдо", counterpartyName: "ПСЕВДО", comment: "",
           dueDate: "2026-08-29", updatedAt: at(3600_000), isCanonical: false }),
    note({ clientKey: "канон", counterpartyName: "КАНОН", comment: "старий текст",
           dueDate: "2026-08-28", updatedAt: at(0), isCanonical: true }),
  ]);
  assert.equal(outWindow.primary?.clientKey, "псевдо",
    "🔴 поза вікном порога старий текст переміг свіжіший запис — поріг з'їв усе, а не нічию");

  // ③ Межа порога — рівно 60 с ще В вікні, 60.001 с уже поза ним. Обидва боки
  // названі числом: гейт із прикладом лише з одного боку не перевіряє межу.
  const edgeIn = pickRowNote([
    note({ clientKey: "псевдо", counterpartyName: "П", comment: "", updatedAt: at(60_000), isCanonical: false }),
    note({ clientKey: "канон", counterpartyName: "К", comment: "зміст", updatedAt: at(0), isCanonical: true }),
  ]);
  assert.equal(edgeIn.primary?.clientKey, "канон", "🔴 рівно 60 с опинилось ПОЗА вікном");
  const edgeOut = pickRowNote([
    note({ clientKey: "псевдо", counterpartyName: "П", comment: "", updatedAt: at(60_001), isCanonical: false }),
    note({ clientKey: "канон", counterpartyName: "К", comment: "зміст", updatedAt: at(0), isCanonical: true }),
  ]);
  assert.equal(edgeOut.primary?.clientKey, "псевдо", "🔴 60.001 с лишилось У вікні");

  // ④ ВИРІШАЛЬНИЙ ВИПАДОК — ЗМІСТ НА БОЦІ ПСЕВДОНІМА. На живому «автострадавк»
  // коментар має САМЕ канонічний, тож «має коментар» і «канонічний виграє» дають
  // там однакову відповідь, і прибирання першого лишається непоміченим. Заміряно
  // саботажем: `byText = 0` проходив увесь гейт зеленим, поки цієї пари не було.
  const contentOnAlias = pickRowNote([
    note({ clientKey: "канон", counterpartyName: "КАНОН", comment: "   ", updatedAt: at(0), isCanonical: true }),
    note({ clientKey: "псевдо", counterpartyName: "ПСЕВДО", comment: "домовились на середу",
           updatedAt: at(1000), isCanonical: false }),
  ]);
  assert.equal(contentOnAlias.primary?.clientKey, "псевдо",
    "🔴 за нічиєї виграв ПОРОЖНІЙ канонічний — зміст, що лежить на псевдонімі, лишився невидимим");

  // ⑤ Нерозбірна дата — НАЙСТАРІША, а не «зараз».
  const broken = pickRowNote([
    note({ clientKey: "зламаний", counterpartyName: "З", comment: "текст", updatedAt: "не дата", isCanonical: false }),
    note({ clientKey: "канон", counterpartyName: "К", comment: "текст", updatedAt: at(0), isCanonical: true }),
  ]);
  assert.equal(broken.primary?.clientKey, "канон", "🔴 запис із нерозбірною датою витіснив справжній");
});

test("#253d підпис «ще N» НЕ забирає ширину в коментаря — він на власному рядку", async () => {
  // 📐 Заміряно на проді 01.09.2026, ДО правки: підпис стояв у флекс-рядку колонки
  // фіксованої ширини (240 px) поруч із трьома контролами, і при довжині 243 px
  // (СМАР ТЕКС) та 368 px (АВТОСТРАДА) стискав кнопку домовленості зі 166 px до
  // **8 px**, а коментар — до **0 px**. Тобто на двох рядках коментар зникав
  // повністю, і це був регрес, а не давня тіснота.
  //
  // ⚠️ МЕЖА: DOM-харнеса в проєкті немає, отже ШИРИНУ гейт не міряє — її міряє
  // прогін рамок у браузері. Гейт стереже те, що можна перевірити без DOM:
  // підпис лежить у ВЛАСНОМУ блоці під коментарем, а не в рядку з датою.
  const src = readFileSync(srcOf("../../../frontend/src/pages/dashboard/sections/ReceivablesSection.tsx"), "utf8");
  const a = src.indexOf('className="recv-agree-text"');
  const b = src.indexOf('className="recv-note-from"');
  assert.ok(a > 0 && b > a,
    `🔴 підпис «ще N» стоїть НЕ під коментарем (коментар ${a}, підпис ${b}) — саме цей порядок і давив текст`);
  // 🔴 ТЕГ ШУКАЄМО В УСЬОМУ ДЖЕРЕЛІ, А НЕ У ЗРІЗІ ВІД `className`. Перша редакція
  // різала рядок РІВНО з `className="recv-note-from"`, тож `<div` у зріз не
  // потрапляв у принципі — перевірка не могла пройти ніколи. Класична «межа за
  // позицією», лише в мініатюрі.
  assert.match(src, /<div className="recv-note-from"/,
    "🔴 підпис не є блоком — у флекс-рядку інлайновий `span` з'їдає ширину коментаря");
  assert.ok(!/<span className="recv-note-from"/.test(src),
    "🔴 підпис повернувся інлайновим `span` — саме так він і задавив коментар до 0 px");
  const block = src.slice(b, b + 420);
  assert.match(block, /borderTop:\s*"1px dashed/,
    "🔴 зникла межа, що відділяє чужі записи від коментаря цього клієнта");
  assert.match(src.slice(a, a + 420), /WebkitLineClamp:\s*2/,
    "🔴 коментар більше не має двох рядків — заявка «мало що видно» не закрита");
});

