import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { pickRowNote, type RowNote } from "./receivableNotePick.js";

/**
 * 🗒 #253–#253c — НОТАТКИ, ЩО ЛИШИЛИСЬ НА ПСЕВДОНІМАХ ПІСЛЯ ОБʼЄДНАННЯ.
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

test("#253c НІЧИЯ ЗА ДАТОЮ не втрачає коментар — випадок «автострадавк»", () => {
  // ⚠️ ФІКСТУРА СИНТЕТИЧНА, І ЦЕ СВІДОМО. Спершу цей гейт спирався на нібито
  // живий випадок: «обидві нотатки автострадавк оновлені в одну хвилину». Замір
  // із повною точністю (01.09.2026, після скріншота) показав різницю **4.376 с**
  // — 09:43:46.071 проти 09:43:41.695. Тобто нічиєї в живих даних НЕМАЄ, і
  // «одна хвилина» була артефактом округлення, а не фактом.
  //
  // Гейт лишається, бо нічия можлива за побудовою (пакетний запис дає однаковий
  // `updated_at`), а розвʼязувати її випадково не можна. Але фікстура тепер
  // чесно названа своїм іменем: вона перевіряє ВЛАСТИВІСТЬ порядку, а не
  // відтворює сьогоднішній стан бази — інакше гейт зеленів би рівно доти, доки
  // в базі випадково є потрібна пара (клас `#220`/`#221`).
  const same = "2026-08-27T09:43:00Z";
  const picked = pickRowNote([
    note({ clientKey: "групакомпаній", counterpartyName: "ГРУПА КОМПАНІЙ АВТОСТРАДА ТОВ",
           comment: "", dueDate: "2026-08-29", updatedAt: same, isCanonical: false }),
    note({ clientKey: "автострадавк", counterpartyName: "АВТОСТРАДА ВК",
           comment: "чекаємо оплату до кінця тижня", dueDate: "2026-08-28", updatedAt: same, isCanonical: true }),
  ]);

  assert.equal(picked.primary?.comment, "чекаємо оплату до кінця тижня",
    "🔴 нічия розвʼязана на користь ПОРОЖНЬОГО запису — екран показує менше, ніж до зміни");
  assert.equal(picked.primary?.dueDate, "2026-08-28",
    "🔴 дедлайн зсунувся через нічию — рядок змінився без жодної зміни в даних");
  assert.deepEqual(picked.otherNames, ["ГРУПА КОМПАНІЙ АВТОСТРАДА ТОВ"]);

  // 🔴 ВИРІШАЛЬНИЙ ВИПАДОК — ЗМІСТ НА БОЦІ ПСЕВДОНІМА, і без нього гейт беззубий.
  // На живому «автострадавк» коментар має САМЕ канонічний, тож правило «має
  // коментар» і правило «канонічний виграє» дають там ОДНАКОВУ відповідь — і
  // прибирання першого лишається непоміченим. Заміряно саботажем: `byText = 0`
  // проходив увесь гейт зеленим, поки цієї пари тут не було. Тобто фікстура з
  // одного боку межі не перевіряє властивість, а лише те, що функція щось віддає.
  const contentOnAlias = pickRowNote([
    note({ clientKey: "канон", counterpartyName: "КАНОН", comment: "   ",
           updatedAt: same, isCanonical: true }),
    note({ clientKey: "псевдо", counterpartyName: "ПСЕВДО", comment: "домовились на середу",
           updatedAt: same, isCanonical: false }),
  ]);
  assert.equal(contentOnAlias.primary?.clientKey, "псевдо",
    "🔴 за нічиєї виграв ПОРОЖНІЙ канонічний — зміст, що лежить на псевдонімі, лишився невидимим");

  // 🪞 Дзеркало: свіжіша дата все одно виграє. Правило «має коментар» — це
  // розвʼязання НІЧИЄЇ, а не пріоритет над часом; переплутати їх означало б
  // назавжди приморозити порожній свіжий запис під старим текстом.
  const newerEmpty = pickRowNote([
    note({ clientKey: "псевдо", counterpartyName: "ПСЕВДО", comment: "",
           updatedAt: "2026-08-31T10:00:00Z", isCanonical: false }),
    note({ clientKey: "канон", counterpartyName: "КАНОН", comment: "старий текст",
           updatedAt: "2026-08-20T10:00:00Z", isCanonical: true }),
  ]);
  assert.equal(newerEmpty.primary?.clientKey, "псевдо",
    "🔴 «має коментар» переважило ДАТУ — старий текст заморозив свіжий запис");

  // ⚖️ Повна нічия аж до ключа: канонічний попереду, порядок відтворюваний.
  const full = pickRowNote([
    note({ clientKey: "яяя", counterpartyName: "Я", isCanonical: false }),
    note({ clientKey: "ааа", counterpartyName: "А", isCanonical: true }),
  ]);
  assert.equal(full.primary?.clientKey, "ааа",
    "🔴 за повної нічиєї виграв не канонічний — запис людини йде саме туди");

  // 🕳 Нерозбірна дата — НАЙСТАРІША, а не «зараз»: інакше зіпсований рядок
  // витіснив би справжній свіжий запис.
  const broken = pickRowNote([
    note({ clientKey: "зламаний", counterpartyName: "З", updatedAt: "не дата", isCanonical: false }),
    note({ clientKey: "канон", counterpartyName: "К", updatedAt: "2026-08-20T10:00:00Z", isCanonical: true }),
  ]);
  assert.equal(broken.primary?.clientKey, "канон",
    "🔴 запис із нерозбірною датою витіснив справжній");
});
