/**
 * 🧾 КОД ЄДРПОУ ЯК ДОКАЗ «ЦЕ ОДИН КЛІЄНТ» (задача 11225; Роман 27.11.2026: «давай робити як ідентифікатор - код єдрпоу
 * і там vat чи ще щось так», і його питання: чи не втратимо дані).
 *
 * Прохід 1: лише СПИСОК кандидатів. Нічого не зливається, `client_key` на код не міняється, реєстр псевдонімів
 * (`client_key_alias`) цей модуль не чіпає. Код береться з оплат 1С по угодах (`onec_deal_payments.edrpou`): це гроші,
 * які справді заплатила ця юрособа, тож сильніший доказ, ніж поле в картці CRM.
 *
 * Три види, і плутати їх не можна:
 *   · `clean`      — один код звʼязує кілька записів клієнта (назва і телефон, одруківка): чистий дубль;
 *   · `multi`      — у групі кілька кодів: це або кілька юросіб одного клієнта, або різні клієнти; вирішує людина;
 *   · `collective` — ЗБІРНЕ ІМʼЯ («Название не указано», «Замовник», «Сергій»): під ним лежать різні фірми.
 *
 * 🔴 ЗБІРНІ ІМЕНА ВИКИДАЮТЬСЯ ДО ГРУПУВАННЯ, А НЕ ПІСЛЯ. Групи — це компоненти звʼязності («A і B мають спільний код»),
 * і один збірний ключ склеює ланцюжком усе, до чого торкається. Заміряно 27.11.2026: через «Название не указано»
 * (71 різний код) перший замір зліпив 26 записів в одного «клієнта» (за всі роки 67). Тому збірний ключ не стає
 * вершиною графа взагалі; він показується окремим списком із числом кодів під ним.
 *
 * ⚠️ `COLLECTIVE_NAME_KEYS` — перелік, а перелік бреше мовчки: імені, якого тут немає, модуль не впізнає, і воно
 * потрапить у звичайну групу. Це прийнятно рівно тому, що прохід 1 нічого не зливає: групу бачить людина.
 */
import type { Db } from "./finance.js";
import { GENERIC_CLIENT_KEYS_SQL } from "./adCampaign.js";

/** З якої дати оплати 1С беремо в список за замовчуванням: 2026 рік, як у замірі 27.11.2026 і у вкладці «Безпека». */
export const CODE_GROUPS_FROM = "2026-01-01";
/** Скільки прикладів кодів показуємо під збірним іменем; решта — числом. */
export const COLLECTIVE_SAMPLE = 5;

/** Ключі-заглушки з `GENERIC_CLIENT_KEYS_SQL` (те саме джерело, що в привʼязці дзвінків) — розбором рядка, без копії. */
export const GENERIC_KEYS: readonly string[] = [...GENERIC_CLIENT_KEYS_SQL.matchAll(/'([^']*)'/g)].map((m) => m[1]);

/**
 * Ключі-імена: запис клієнта, названий іменем людини або словом «замовник». Ключ уже нормалізований
 * (`normalizeClientName`: нижній регістр, без пробілів), тому порівняння точне, а не «містить».
 */
export const COLLECTIVE_NAME_KEYS: ReadonlySet<string> = new Set([
  "замовник", "заказчик", "клієнт", "клиент", "client", "customer", "дубль", "тест", "test", "невідомо", "неизвестно",
  "олександр", "александр", "саша", "олександра", "александра", "сергій", "сергей", "андрій", "андрей", "роман", "рома",
  "дмитро", "дмитрий", "діма", "дима", "іван", "иван", "ваня", "євген", "евгений", "євгеній", "женя", "микола", "николай", "коля",
  "володимир", "владимир", "вова", "віктор", "виктор", "вітя", "олег", "ігор", "игорь", "юрій", "юрий", "юра", "василь", "василий", "вася",
  "петро", "петр", "михайло", "михаил", "міша", "миша", "максим", "макс", "артем", "артём", "денис", "богдан", "віталій", "виталий",
  "тарас", "павло", "павел", "паша", "антон", "ярослав", "руслан", "вадим", "олексій", "алексей", "льоша", "леша", "анатолій", "анатолий",
  "валерій", "валерий", "григорій", "григорий", "костянтин", "константин", "костя", "леонід", "леонид", "назар", "остап", "степан",
  "станіслав", "станислав", "стас", "вячеслав", "вʼячеслав", "слава", "едуард", "эдуард", "борис", "геннадій", "геннадий", "кирило", "кирилл",
  "наталя", "наталія", "наталья", "наталия", "наташа", "надя", "надія", "надежда", "олена", "елена", "лєна", "лена", "ольга", "оля",
  "тетяна", "татьяна", "таня", "ірина", "ирина", "іра", "ира", "світлана", "светлана", "света", "марія", "мария", "маша", "анна", "аня",
  "юлія", "юлия", "юля", "оксана", "катерина", "екатерина", "катя", "людмила", "люда", "галина", "галя", "вікторія", "виктория", "віка", "вика",
  "інна", "инна", "алла", "лариса", "валентина", "валя", "любов", "любовь", "люба", "тамара", "ніна", "нина", "віра", "вера", "дарина", "дарья",
  "даша", "христина", "кристина", "анастасія", "анастасия", "настя", "маргарита", "рита", "діана", "диана", "аліна", "алина", "яна", "зоя",
]);

/** Чи це збірний ключ: заглушка CRM або імʼя людини. Єдине місце рішення; саме його саботує гейт `#11256`. */
export function isCollectiveKey(key: string): boolean {
  return GENERIC_KEYS.includes(key) || COLLECTIVE_NAME_KEYS.has(key);
}

/** `edrpou` — 8 цифр (юрособа); `ipn` — 10 цифр (ФОП, фізособа) або 12 (ІПН платника ПДВ); `other` — будь-що інше. */
export type CodeKind = "edrpou" | "ipn" | "other";

/**
 * Що за код лежить у полі 1С. Групуємо лише за `edrpou` та `ipn`; `other` рахуємо окремим числом і в групи не беремо:
 * це може бути VAT нерезидента, обрізаний код (1С зʼїла нуль попереду) чи текст, і про це ще нічого не заміряно.
 * Порожнє й самі нулі — не код (заповнене поле, яке нічого не означає).
 */
export function codeOf(raw: string | null | undefined): { code: string; kind: CodeKind } | null {
  const s = String(raw ?? "").replace(/\s+/g, "");
  if (!s || /^0+$/.test(s)) return null;
  if (/^\d{8}$/.test(s)) return { code: s, kind: "edrpou" };
  if (/^(\d{10}|\d{12})$/.test(s)) return { code: s, kind: "ipn" };
  return { code: s, kind: "other" };
}

/** Рядок запиту: пара «запис клієнта, сирий код» (код `null` — оплати без коду) і факти про сам запис. */
export interface CodePairRow {
  key: string; code_raw: string | null; payments: number; last_paid: string | null; kontragent: string | null;
  paid_deals: number; name: string | null;
}

export interface CodeGroupCode { code: string; kind: CodeKind; kontragent: string | null }
export interface CodeGroupKey {
  key: string; name: string | null; paidDeals: number;
  /** Оплат 1С цього запису, що несуть хоч один код групи, і дата останньої з них. */
  payments: number; lastPaid: string | null;
  /** Ключ із самих цифр: фізособа, записана за телефоном. */
  phoneKey: boolean;
}
export interface CodeGroup { kind: "clean" | "multi"; codes: CodeGroupCode[]; keys: CodeGroupKey[]; paidDeals: number }
export interface CollectiveEntry {
  key: string; name: string | null; paidDeals: number;
  /** Скільки різних кодів лежить під цим іменем і скільки ЗВИЧАЙНИХ записів клієнта мають ті самі коди. */
  codes: number; shared: number; sample: CodeGroupCode[];
}
export interface CodeGroups {
  /** Записів клієнта з оплатою 1С у періоді; з них з кодом ЄДРПОУ чи ІПН. */
  clients: number; withCode: number;
  /** Оплат 1С у періоді; з них із кодом ЄДРПОУ чи ІПН. `codedPayments = 0` при `payments > 0` означає «синк коду ще не приніс». */
  payments: number; codedPayments: number;
  /** Коди іншого вигляду (не 8, 10 чи 12 цифр): скільки різних і в скількох оплатах. У групи не входять. */
  otherCodes: number; otherPayments: number;
  clean: CodeGroup[]; multi: CodeGroup[]; collective: CollectiveEntry[];
  /** На скільки записів стане менше, якщо підтвердити всі чисті дублі. */
  minusClean: number;
}

/**
 * Чисте правило: пари → три списки. Збірні ключі відкладаються ДО побудови груп (див. шапку файла).
 * Група — компонента звʼязності звичайних ключів через спільний код; `clean`, якщо всі коди всіх її ключів — один код.
 */
export function codeGroupsOf(rows: readonly CodePairRow[], collective: (key: string) => boolean = isCollectiveKey): CodeGroups {
  type Fact = { name: string | null; paidDeals: number };
  const fact = new Map<string, Fact>();
  /** key → code → {оплат, остання} */
  const byKey = new Map<string, Map<string, { payments: number; lastPaid: string | null }>>();
  const codeInfo = new Map<string, CodeGroupCode & { at: string }>();
  const other = new Map<string, number>();
  let payments = 0, codedPayments = 0;
  for (const r of rows) {
    if (!fact.has(r.key)) fact.set(r.key, { name: r.name, paidDeals: Number(r.paid_deals) || 0 });
    const n = Number(r.payments) || 0;
    payments += n;
    const c = codeOf(r.code_raw);
    if (!c) continue;
    if (c.kind === "other") { other.set(c.code, (other.get(c.code) ?? 0) + n); continue; }
    codedPayments += n;
    const m = byKey.get(r.key) ?? new Map<string, { payments: number; lastPaid: string | null }>();
    const prev = m.get(c.code) ?? { payments: 0, lastPaid: null };
    const last = [prev.lastPaid, r.last_paid].filter((x): x is string => !!x).sort().pop() ?? null;
    m.set(c.code, { payments: prev.payments + n, lastPaid: last });
    byKey.set(r.key, m);
    // Назву контрагента для коду беремо з найсвіжішої оплати: у 1С її перейменовують, код лишається.
    const at = r.last_paid ?? "";
    const seen = codeInfo.get(c.code);
    if (!seen || at > seen.at) codeInfo.set(c.code, { code: c.code, kind: c.kind, kontragent: r.kontragent || seen?.kontragent || null, at });
  }
  const codeRow = (code: string): CodeGroupCode => { const i = codeInfo.get(code)!; return { code: i.code, kind: i.kind, kontragent: i.kontragent }; };

  // Звичайні ключі з кодом: вершини графа. Збірні сюди не потрапляють за побудовою.
  const plain = [...byKey.keys()].filter((k) => !collective(k));
  const parent = new Map<string, string>(plain.map((k) => [k, k]));
  const find = (a: string): string => { let x = a; while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const keysOfCode = new Map<string, string[]>();
  for (const k of plain) for (const code of byKey.get(k)!.keys()) keysOfCode.set(code, [...(keysOfCode.get(code) ?? []), k]);
  for (const ks of keysOfCode.values()) for (const o of ks.slice(1)) parent.set(find(o), find(ks[0]));
  const comp = new Map<string, string[]>();
  for (const k of plain) { const r = find(k); comp.set(r, [...(comp.get(r) ?? []), k]); }

  const groups: CodeGroup[] = [];
  for (const ks of comp.values()) {
    if (ks.length < 2) continue;
    const codes = [...new Set(ks.flatMap((k) => [...byKey.get(k)!.keys()]))].sort();
    const keys: CodeGroupKey[] = ks.map((k) => {
      const cs = [...byKey.get(k)!.values()];
      return { key: k, name: fact.get(k)?.name ?? null, paidDeals: fact.get(k)?.paidDeals ?? 0,
        payments: cs.reduce((a, x) => a + x.payments, 0), lastPaid: cs.map((x) => x.lastPaid).filter((x): x is string => !!x).sort().pop() ?? null,
        phoneKey: /^\d{9,12}$/.test(k) };
    }).sort((a, b) => b.paidDeals - a.paidDeals || a.key.localeCompare(b.key));
    groups.push({ kind: codes.length === 1 ? "clean" : "multi", codes: codes.map(codeRow), keys, paidDeals: keys.reduce((a, x) => a + x.paidDeals, 0) });
  }
  groups.sort((a, b) => b.paidDeals - a.paidDeals || a.keys[0].key.localeCompare(b.keys[0].key));

  // Збірні імена: показуємо ті, де під іменем кілька кодів або код збігається зі звичайним записом клієнта.
  const collectiveList: CollectiveEntry[] = [];
  for (const [k, m] of byKey) {
    if (!collective(k)) continue;
    const codes = [...m.keys()];
    const shared = new Set(codes.flatMap((c) => keysOfCode.get(c) ?? [])).size;
    if (codes.length < 2 && shared === 0) continue;
    const sample = codes.sort((a, b) => m.get(b)!.payments - m.get(a)!.payments || a.localeCompare(b)).slice(0, COLLECTIVE_SAMPLE).map(codeRow);
    collectiveList.push({ key: k, name: fact.get(k)?.name ?? null, paidDeals: fact.get(k)?.paidDeals ?? 0, codes: codes.length, shared, sample });
  }
  collectiveList.sort((a, b) => b.codes - a.codes || a.key.localeCompare(b.key));

  const clean = groups.filter((g) => g.kind === "clean");
  return {
    clients: fact.size, withCode: byKey.size, payments, codedPayments,
    otherCodes: other.size, otherPayments: [...other.values()].reduce((a, x) => a + x, 0),
    clean, multi: groups.filter((g) => g.kind === "multi"), collective: collectiveList,
    minusClean: clean.reduce((a, g) => a + g.keys.length - 1, 0),
  };
}

/**
 * Пари «запис клієнта, код» з оплат 1С по ОПЛАЧЕНИХ угодах ($1 — дата, з якої беремо оплати, або NULL = за весь час).
 * `client_key` береться з угоди в момент запиту, тож список сам іде за реєстром псевдонімів: злиті записи зникають із груп.
 * Рядок із `code_raw IS NULL` потрібен: без нього «записів з оплатою» не порахувати, і частка з кодом стала б 100%.
 * `paid_deals` — оплачені угоди запису за ВЕСЬ час (не за період): це вага запису, а не оборот періоду.
 */
export const CLIENT_CODE_PAIRS_SQL = `
  WITH pay AS (
    SELECT d.client_key AS key, NULLIF(btrim(p.edrpou), '') AS code_raw, COUNT(*)::int AS payments, MAX(p.paid_on) AS last_paid,
           (array_agg(NULLIF(btrim(p.kontragent), '') ORDER BY p.paid_on DESC NULLS LAST))[1] AS kontragent
      FROM onec_deal_payments p
      JOIN deals d ON d.kommo_id = p.deal_id
      JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       AND ($1::date IS NULL OR p.paid_on >= $1::date)
     GROUP BY 1, 2
  ), fact AS (
    SELECT d.client_key AS key, COUNT(*)::int AS paid_deals,
           (array_agg(d.client_name ORDER BY d.closed_at_kommo DESC NULLS LAST) FILTER (WHERE d.client_name IS NOT NULL))[1] AS name
      FROM deals d
      JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE psm.funnel_stage = 'paid' AND d.client_key IN (SELECT key FROM pay)
     GROUP BY 1
  )
  SELECT pay.key AS key, pay.code_raw AS code_raw, pay.payments AS payments, to_char(pay.last_paid, 'YYYY-MM-DD') AS last_paid,
         pay.kontragent AS kontragent, fact.paid_deals AS paid_deals, fact.name AS name
    FROM pay JOIN fact ON fact.key = pay.key`;

/** Три списки кандидатів. `all = true` — оплати за весь час; інакше з `CODE_GROUPS_FROM`. */
export async function clientCodeGroups(db: Db, all = false): Promise<CodeGroups & { from: string | null }> {
  const from = all ? null : CODE_GROUPS_FROM;
  const r = await db.query<CodePairRow>(CLIENT_CODE_PAIRS_SQL, [from]);
  return { from, ...codeGroupsOf(r.rows) };
}
