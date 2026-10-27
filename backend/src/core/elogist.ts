/**
 * 🟣 eLogist — ОКРЕМИЙ КАНАЛ, А НЕ РЕКЛАМА UTS (рішення власника 27.10.2026, «варіант А»).
 *
 * eLogist (elogist.com.ua) — сестринський бренд. Його заявки падають у ту саму «Кваліфікацію»,
 * і до 27.10.2026 рахувались РЕКЛАМНИМИ дотиками UTS: лід Кваліфікації без лідоген-маркерів =
 * реклама (`reclassifyAdChannel`), а угода з `client_source ∈ adSources` — теж реклама
 * (`adDealSql`). Тобто бюджет UTS «окуповувався» заявками чужого сайту. Тепер eLogist —
 * четвертий канал (`lead_channel = 'elogist'`) поруч із `ad` / `leadgen` / `other`.
 *
 * 🔴 ЦЕЙ МОДУЛЬ — ЄДИНЕ МІСЦЕ ОЗНАЧЕННЯ «eLogist-лід». SQL-фрагмент і TS-предикат нижче
 * будуються з ТИХ САМИХ констант; другої копії умови ніде немає (тримає `#2490b`).
 *
 * ОЗНАЧЕННЯ (власник 27.10.2026). Угода воронки «Кваліфікація» (8921928 / стара 7336928), що
 * має БУДЬ-ЯКУ з трьох ознак:
 *   ① «Источник клиента» (поле 2098035) = `elogist.com.ua` — значення enum 6348933, заведене в
 *     Kommo 27.10.2026; нові ліди отримують його з цього дня;
 *   ② назва починається з `eLogist` — так бот із серпня 2026 називав ліди («eLogist — +380…»);
 *     власник погодив цю ознаку для ІСТОРІЇ, бо поля ① тоді ще не було;
 *   ③ етап «Заявки eLogist (сайт)» (108581472) — там ці ліди створюються.
 *
 * ⚖️ ДВІ ФОРМИ, І РІЗНИЦЯ МІЖ НИМИ — ЛИШЕ ВОРОНКА:
 *   • `elogistLeadSql` / `isElogistLead` — означення власника дослівно: Кваліфікація ∧ (①∨②∨③).
 *     Це «eLogist-дотик» для `reclassifyAdChannel`.
 *   • `elogistMarkSql` / `isElogistMark` — «угода САМА прийшла з eLogist» у будь-якій воронці:
 *     ① ∨ ② ∨ (Кваліфікація ∧ ③). Потрібна тому, що лід Кваліфікації ПЕРЕЇЖДЖАЄ в Повний цикл
 *     ТІЄЮ САМОЮ угодою (`kommo_id` зберігається, `pipeline_id` змінюється) — і з цієї миті
 *     перша форма його вже не бачить, хоча назва й «Источник клиента» лишились при ньому.
 *     Етап ③ існує лише в Кваліфікації, тож за її межами він ознакою не є.
 *   Для Кваліфікації обидві форми дають ОДНУ відповідь — це й доводить `#2490`.
 *
 * ⚠️ НАЗВА — З МЕЖЕЮ СЛОВА (`eLogist` і далі не буква/цифра): «eLogistics …» чи назва
 * компанії-клієнта, що лише ПОЧИНАЄТЬСЯ так само, eLogist-лідом не є. Регістр — як у бота.
 *
 * 🔴 МОДУЛЬ ЧИСТИЙ (жодного імпорту з `db/pool`) — та сама причина, що в `dealSourceState.ts`:
 * пул тягне `config.js`, який кидає на відсутньому `DATABASE_URL`, і гейт на означення
 * мовчки скіпався б саме там, де він найпотрібніший.
 */
import { QUALIFICATION_PIPELINES } from "./leadgenStages.js";

/** Значення каналу в `deals.lead_channel`. */
export const ELOGIST_CHANNEL = "elogist";
/** Поле Kommo «Источник клиента». */
export const ELOGIST_SOURCE_FIELD_ID = 2098035;
/** Текст значення enum у «Источник клиента» — саме він лежить у `deals.client_source`. */
export const ELOGIST_CLIENT_SOURCE = "elogist.com.ua";
/** id значення enum (довідка для `CRM_SCHEMA.md`; синк читає ТЕКСТ, а не id). */
export const ELOGIST_CLIENT_SOURCE_ENUM_ID = 6348933;
/** Етап «Заявки eLogist (сайт)» воронки Кваліфікація (8921928). */
export const ELOGIST_STAGE_ID = 108581472;
/** Префікс назви, яким бот називав ліди з серпня 2026. */
export const ELOGIST_NAME_PREFIX = "eLogist";

/** Ознака ② у TS: префікс + межа слова (наступний символ — не буква/цифра або кінець рядка). */
const NAME_RE = new RegExp(`^${ELOGIST_NAME_PREFIX}(?![\\p{L}\\p{N}_])`, "u");
/**
 * Ознака ② у SQL: те саме правило POSIX-регуляркою. `\M` у Postgres — «кінець слова»; на
 * кінці рядка він теж спрацьовує. Зворотний слеш подвоєний, бо це JS-рядок.
 */
const NAME_SQL_RE = `^${ELOGIST_NAME_PREFIX}\\M`;

const qualArray = `ARRAY[${QUALIFICATION_PIPELINES.join(", ")}]::bigint[]`;

/** Вхід TS-предиката — рівно ті поля угоди, які читає SQL-форма. */
export interface ElogistDealInput {
  pipelineId: number | null;
  statusId: number | null;
  name: string | null;
  clientSource: string | null;
}

/** ① ∨ ② — ознаки, що їдуть разом з угодою в будь-яку воронку. */
function ownMark(d: ElogistDealInput): boolean {
  return (d.clientSource ?? "").trim() === ELOGIST_CLIENT_SOURCE || NAME_RE.test((d.name ?? "").trim());
}
const isQual = (d: ElogistDealInput): boolean =>
  d.pipelineId != null && QUALIFICATION_PIPELINES.includes(Number(d.pipelineId));

/** «Угода сама прийшла з eLogist», будь-яка воронка: ① ∨ ② ∨ (Кваліфікація ∧ ③). */
export function isElogistMark(d: ElogistDealInput): boolean {
  return ownMark(d) || (isQual(d) && Number(d.statusId) === ELOGIST_STAGE_ID);
}

/** Означення власника дослівно: лід Кваліфікації з будь-якою з трьох ознак. */
export function isElogistLead(d: ElogistDealInput): boolean {
  return isQual(d) && isElogistMark(d);
}

/** SQL-форма `isElogistMark` над аліасом таблиці `deals`. Колонки: client_source, name, pipeline_id, status_id. */
export function elogistMarkSql(alias = "d"): string {
  return `(COALESCE(btrim(${alias}.client_source), '') = '${ELOGIST_CLIENT_SOURCE}'
     OR COALESCE(btrim(${alias}.name), '') ~ '${NAME_SQL_RE}'
     OR (${alias}.pipeline_id = ANY(${qualArray}) AND ${alias}.status_id = ${ELOGIST_STAGE_ID}))`;
}

/** SQL-форма `isElogistLead`. */
export function elogistLeadSql(alias = "d"): string {
  return `(${alias}.pipeline_id = ANY(${qualArray}) AND ${elogistMarkSql(alias)})`;
}

/**
 * 🚫 ВИКЛЮЧЕННЯ З РЕКЛАМИ UTS — для `adDealSql` / `paidAdSql`. Угода НЕ реклама, якщо її канал
 * уже `elogist` (повний цикл, «останній дотик») АБО вона сама несе ознаку eLogist. Друга
 * половина потрібна до того, як разовий бекфіл перемітить старі ліди Кваліфікації: без неї
 * вони рахувались би рекламою за `client_source ∈ adSources` чи за cpc-міткою.
 * `IS DISTINCT FROM`, а не `<>`: при `lead_channel IS NULL` `<>` дав би NULL і викинув рядок.
 */
export function notElogistSql(alias = "d"): string {
  return `(${alias}.lead_channel IS DISTINCT FROM '${ELOGIST_CHANNEL}' AND NOT ${elogistMarkSql(alias)})`;
}

/**
 * 🧹 РАЗОВИЙ БЕКФІЛ ІСТОРІЇ (НЕ запускається сам; див. `tools/backfillElogistChannel.ts`).
 *
 * Синк переписує `lead_channel` лише угодам, що ЗМІНИЛИСЬ у Kommo, а `reclassifyAdChannel`
 * чіпає лише Повний цикл. Тож старі ліди Кваліфікації з ознакою eLogist лишились би `ad`/`other`.
 * Цей UPDATE переводить їх у `elogist` — ЛИШЕ ліди Кваліфікації з ознакою і ЛИШЕ не-лідоген
 * (лідоген лишається лідогеном, як і на апсерті: `lead_generator` заповнений → не чіпаємо).
 * Ідемпотентний: повторний прогін не знаходить рядків (`IS DISTINCT FROM`).
 */
export function elogistBackfillWhere(alias = "d"): string {
  return `${elogistLeadSql(alias)}
     AND ${alias}.lead_generator IS NULL
     AND ${alias}.lead_channel IS DISTINCT FROM 'leadgen'
     AND ${alias}.lead_channel IS DISTINCT FROM '${ELOGIST_CHANNEL}'`;
}
export function elogistBackfillSql(): string {
  return `UPDATE deals d SET lead_channel = '${ELOGIST_CHANNEL}' WHERE ${elogistBackfillWhere("d")}`;
}
