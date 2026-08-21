/**
 * Розбір відповіді 1С «дебіторська заборгованість»
 * (`rest-bk/hs/service/debit-balance-account-361` / `-362`).
 *
 * 🔴 МОДУЛЬ ЧИСТИЙ: без мережі й без БД. Причина не стилістична — з контейнера
 * асистента ендпоінт 1С недосяжний (заміряно: таймаут), а `db/pool.js` тягне
 * `config.js`, який кидає без `DATABASE_URL` ще НА ІМПОРТІ. Тримаючи розбір і
 * пороги тут, ми даємо гейтам G1/G2/G6 бігти у звичайному `npm test`, а не
 * скіпатись — тобто перевірятись щоразу, а не «колись на сервері».
 *
 * Форма (перевірено на живій відповіді 21.08.2026, 73 контрагенти / 296 рахунків):
 *   [ { "Contractor": "ФОРА ТОВ",
 *       "DetailInfo": [ { "EDRPOU": "32294897",
 *                         "Account": "Счет на оплату покупателю 000006460 від 07.08.2026 00:00:00",
 *                         "Comment": "Семенюк Дмитро, Загружен из amoCRM по сделке №62556749",
 *                         "Sum": 83000, "SumVal": 0 } ] } ]
 */

import { normalizeClientName } from "../utils/clientName.js";

/** Сирий рядок рахунку так, як його віддає 1С. Поля `unknown` навмисно: джерело
 *  зовнішнє, і жодне з них не гарантоване — типізувати їх як `string` означало б
 *  повірити чужій системі на слово. */
export interface Detail1c {
  EDRPOU?: unknown;
  Account?: unknown;
  Comment?: unknown;
  Sum?: unknown;
  SumVal?: unknown;
}

export interface Contractor1c {
  Contractor?: unknown;
  DetailInfo?: unknown;
}

export interface Receivable1cRow {
  clientKey: string;
  clientName: string;
  invoiceNo: string | null;
  invoiceDate: string | null; // ISO YYYY-MM-DD
  /** Гривнева сума. Для -362 це гривневий еквівалент. */
  amount: number;
  /** Сума у валюті (`SumVal`); для -361 завжди 0. */
  amountVal: number;
  edrpou: string | null;
  /** Сирий `Comment` — провенанс. На екран не йде, лишається для розслідувань. */
  comment: string | null;
  dealId: number | null;
  /** ПІБ із коментаря — ФОЛБЕК атрибуції, коли № угоди не дав менеджера. */
  managerHint: string;
}

export interface Parse1cResult {
  rows: Receivable1cRow[];
  /** Названі причини відкидання. Порожній результат мусить пояснювати себе:
   *  «0 рядків» і «0 рядків, бо у всіх немає назви» — різні діагнози. */
  skipped: { noName: number; noAmount: number; noDetail: number };
}

/**
 * № рахунку й дата з поля `Account`.
 * 🔴 Regex НЕ переписаний — це буквально той самий вираз, яким два роки жив
 * `parseInvoice` для гугл-таблиці, і саме тому ключ `receivable_invoice_notes`
 * (`client_key, invoice_no`) переживає зміну джерела. Заміряно на живій
 * відповіді: № витягується у 308 із 308 рядків, дата — теж, дублів нуль.
 */
export function invoiceRefOf(cell: unknown): { no: string | null; date: string | null } {
  const s = typeof cell === "string" ? cell : "";
  if (!s) return { no: null, date: null };
  const noMatch = s.match(/(\d{5,})/);
  const dateMatch = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return {
    no: noMatch ? noMatch[1] : null,
    date: dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null,
  };
}

/**
 * № угоди Kommo з коментаря 1С. Три ФОРМИ, усі три заміряні на живих даних:
 *   «ПІБ, Загружен из amoCRM по сделке №62556749»  (281 рядок)
 *   «62550507 / Хомік Вікторія»                    (8 рядків)
 *   «Ксенія / 62197315»                            (1 рядок)
 *
 * 🔴 ЧОМУ НЕ ПРОСТО `\d{7,}` ПО ВСЬОМУ РЯДКУ. Спокусливо й коротше — і ловить
 * телефон: «Возович Антон,  38(068)3456547 - 25.07.2023» дає «3456547», сім
 * цифр, схожих на id. Вільний вираз знайшов 296 «угод», з них 2 неіснуючі;
 * ці три патерни — 294, з них 1 неіснуюча (60146721 — справжня угода, просто
 * старша за наш 12-місячний горизонт, тобто це не хиба розбору).
 * Число прив'язується до ГРОШЕЙ конкретного менеджера, тож хибний збіг тут
 * дорожчий за пропущений.
 */
export function dealIdOf(comment: unknown): number | null {
  const s = typeof comment === "string" ? comment : "";
  if (!s) return null;
  const byPhrase = s.match(/по\s+сделке\s*№?\s*(\d{7,})/i);
  if (byPhrase) return Number(byPhrase[1]);
  const leading = s.match(/^\s*(\d{7,})\s*[/,]/);
  if (leading) return Number(leading[1]);
  const trailing = s.match(/\/\s*(\d{7,})\s*$/);
  if (trailing) return Number(trailing[1]);
  return null;
}

/**
 * ПІБ із коментаря для ФОЛБЕК-атрибуції. Наївне «до першої коми» дає 285 збігів
 * з `managers.name`; зі зняттям провідного «id /» — 291. Різниця маленька саме
 * тому, що у формі «id / ПІБ» ми зазвичай уже маємо № угоди й фолбек не потрібен;
 * але лишати підказку свідомо гіршою, коли правильна коштує один regex, — ні.
 */
export function managerHintOf(comment: unknown): string {
  const s = typeof comment === "string" ? comment : "";
  const head = s.split(",")[0].trim();
  const afterId = head.match(/^\s*\d{5,}\s*[/,]\s*(.+)$/);
  return (afterId ? afterId[1] : head).trim();
}

/**
 * Розбирає відповідь 1С у пласкі рядки рахунків.
 *
 * 🔴 КЛЮЧ КЛІЄНТА — `utils/clientName.normalizeClientName`, ІМПОРТОВАНИЙ, а не
 * переданий параметром і не переписаний поруч. Параметр виглядав би гнучкіше й
 * саме тому був би гірший: він дозволяв би джобі підсунути свою нормалізацію,
 * і ключ дебіторки розійшовся б із ключем клієнтських екранів мовчки. Модуль
 * лишається чистим — `utils/clientName` не імпортує нічого взагалі.
 *
 * ⚠️ Кидає, якщо payload не масив: «не масив» — це не «нуль боргів», це зламане
 * джерело, і мовчазний порожній результат тут був би тим самим хибно-зеленим,
 * що «успіх за 0 мс».
 */
export function parse1cPayload(payload: unknown): Parse1cResult {
  if (!Array.isArray(payload)) {
    throw new Error("1С віддав не масив — відповідь не розібрано");
  }
  const rows: Receivable1cRow[] = [];
  const skipped = { noName: 0, noAmount: 0, noDetail: 0 };

  for (const raw of payload as Contractor1c[]) {
    const clientName = typeof raw?.Contractor === "string" ? raw.Contractor.trim() : "";
    const details = Array.isArray(raw?.DetailInfo) ? (raw.DetailInfo as Detail1c[]) : null;
    if (!details) { skipped.noDetail++; continue; }
    // Ключ рахуємо РАЗ на контрагента: інакше та сама назва дала б різні ключі
    // при різних рядках, і борг клієнта розʼїхався б по кількох рядках екрана.
    const clientKey = clientName ? normalizeClientName(clientName) : null;

    for (const d of details) {
      if (!clientKey) { skipped.noName++; continue; }
      const amount = Number(d?.Sum);
      const amountVal = Number(d?.SumVal);
      const uah = Number.isFinite(amount) ? amount : 0;
      const val = Number.isFinite(amountVal) ? amountVal : 0;
      // Порожній рядок — це той, де немає НІ гривні, НІ валюти. Умова ширша за
      // теперішню (`amount === 0` → пропустити) навмисно: у -362 трапляється
      // `Sum: 0` при `SumVal: 15` — гривневий еквівалент нульовий, борг є.
      // Для -361 обидві умови дають те саме (рядків із нульовою сумою нуль).
      if (uah === 0 && val === 0) { skipped.noAmount++; continue; }

      const inv = invoiceRefOf(d?.Account);
      const comment = typeof d?.Comment === "string" ? d.Comment.trim() : "";
      const edrpou = typeof d?.EDRPOU === "string" ? d.EDRPOU.trim() : "";
      rows.push({
        clientKey,
        clientName,
        invoiceNo: inv.no,
        invoiceDate: inv.date,
        amount: uah,
        amountVal: val,
        edrpou: edrpou || null,
        comment: comment || null,
        dealId: dealIdOf(comment),
        managerHint: managerHintOf(comment),
      });
    }
  }
  return { rows, skipped };
}

// ───────────────────────── ЗАПОБІЖНИК: порожня відповідь = ПРОВАЛ ─────────────────────────

/**
 * 🔴 Пороги живуть ТУТ, поруч із правилом, і більше ніде. Літерал у тілі джоби
 * означав би, що наступний, хто його змінить, змінить його в одному місці з двох.
 */
export const MIN_ROWS_ABS = 50;
export const MIN_ROWS_RATIO = 0.5;

export type PayloadVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Чи можна пускати цю відповідь у базу.
 *
 * 🔴 НАВІЩО ВЗАГАЛІ. Теперішній захист тримається випадково: `fetch` стоїть до
 * `BEGIN`, тож обрив мережі не доходить до `TRUNCATE`. Але `HTTP 200` з `[]`
 * проходить наскрізь — екран дебіторки обнуляється, а джоба звітує успіхом.
 * Це рівно `syncCalls`, яка годинами «успішно» привозила нуль рядків.
 *
 * Три умови (рішення власника):
 *   1) щось узагалі розібралось;
 *   2) не менше `MIN_ROWS_ABS` — при живих 296 це шестикратний запас;
 *   3) не менше половини попереднього успішного прогону.
 *
 * ⚠️ Умова 3 вимикається, коли попереднього прогону не було (`previousCount = 0`),
 * інакше вона заблокувала б ПЕРШИЙ запуск на порожній базі — тобто запобіжник
 * не пустив би саме те, заради чого його ставлять.
 */
export function payloadVerdict(rowCount: number, previousCount: number): PayloadVerdict {
  if (rowCount <= 0) {
    return { ok: false, reason: "1С повернув порожній перелік — знімок дебіторки лишено без змін" };
  }
  if (rowCount < MIN_ROWS_ABS) {
    return {
      ok: false,
      reason: `1С повернув ${rowCount} рядків — менше за поріг ${MIN_ROWS_ABS}; знімок лишено без змін`,
    };
  }
  const floor = Math.floor(previousCount * MIN_ROWS_RATIO);
  if (previousCount > 0 && rowCount < floor) {
    return {
      ok: false,
      reason: `1С повернув ${rowCount} рядків проти ${previousCount} минулого разу (поріг ${floor}); знімок лишено без змін`,
    };
  }
  return { ok: true };
}

/**
 * Тягне рахунки дебіторки з 1С, розбирає й перевіряє правдоподібність.
 *
 * 🔴 ЖИВЕ В ЯДРІ, А НЕ В ДЖОБІ, І ЦЕ НЕ СМАК. Джоба імпортує `config.js`, який
 * кидає без `DATABASE_URL`/`JWT_SECRET` ще НА ІМПОРТІ — тобто гейт, що хоче
 * підсунути сюди `async () => []`, у контейнері без .env впав би на імпорті
 * замість перевірити запобіжник. Тут функція нічого не імпортує з оточення,
 * тож `#121b` доводить захист ПОВЕДІНКОЮ і біжить у звичайному `npm test`.
 * Мережа приходить параметром; у БД функція не пише нічого, тож її провал
 * фізично не може дійти до `TRUNCATE`.
 */
export async function loadReceivables1c(
  fetchPayload: () => Promise<unknown>,
  previousCount: number
): Promise<Receivable1cRow[]> {
  const payload = await fetchPayload();
  // Кидає, якщо це не масив: «не масив» ≠ «нуль боргів».
  const { rows, skipped } = parse1cPayload(payload);
  const verdict = payloadVerdict(rows.length, previousCount);
  if (!verdict.ok) {
    // Причини відкидання йдуть у повідомлення: порожній результат мусить
    // пояснювати СЕБЕ, інакше «0 рядків» читається як «боргів немає».
    throw new Error(
      `${verdict.reason} (відкинуто: без назви ${skipped.noName}, без суми ${skipped.noAmount}, без DetailInfo ${skipped.noDetail})`
    );
  }
  return rows;
}

// ───────────────────────── АТРИБУЦІЯ МЕНЕДЖЕРА ─────────────────────────

/**
 * Менеджер рахунку: № угоди Kommo, фолбек — ПІБ із коментаря.
 *
 * 🔴 ПЕРЕВАГА KOMMO — рішення власника, і воно підперте заміром. З 308 живих
 * рядків обидва способи дають відповідь у 279, і в ШЕСТИ вони розходяться;
 * у ЧОТИРЬОХ із цих шести менеджер, названий у 1С, деактивований — тобто це
 * угоди, перепризначені після звільнення людини, і 1С просто зберіг підпис
 * того, хто виставляв рахунок. Kommo там правий беззастережно.
 *
 * Фолбек лишається не «про всяк випадок», а тому, що покриття неповне:
 * № угоди дає 290 із 308, ПІБ — 281, разом 292; без фолбека 11 рахунків
 * лишились би без менеджера, тобто випали б із розрізів по людях і командах.
 */
export function resolveManagerId(
  row: Pick<Receivable1cRow, "dealId" | "managerHint">,
  ctx: { managerIdByDeal: Map<number, number | null>; managerIdByName: Map<string, number> }
): number | null {
  if (row.dealId != null) {
    const byDeal = ctx.managerIdByDeal.get(row.dealId);
    if (byDeal != null) return byDeal;
  }
  return ctx.managerIdByName.get(row.managerHint) ?? null;
}
