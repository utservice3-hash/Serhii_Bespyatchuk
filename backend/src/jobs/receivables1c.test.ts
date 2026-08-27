import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsApi } from "../testMode.js";
import {
  parse1cPayload,
  payloadVerdict,
  resolveManagerId,
  invoiceRefOf,
  dealIdOf,
  managerHintOf,
  MIN_ROWS_ABS,
  MIN_ROWS_RATIO,
  loadReceivables1c,
} from "../core/receivables1c.js";
import { normalizeClientName } from "../utils/clientName.js";

/**
 * ГЕЙТИ ПЕРЕХОДУ ДЕБІТОРКИ НА ПРЯМЕ 1С (#119…#125).
 *
 * Фікстура нижче — СИНТЕТИЧНА, але злiплена з реальних форм, які віддає 1С
 * (замір 21.08.2026): три різні формати коментаря, порожній ЄДРПОУ, порожня
 * назва контрагента, рядок `Sum: 0` при `SumVal > 0`, телефон, схожий на № угоди.
 * Кожен із цих випадків уже існує в живій відповіді — фікстура не вигадує форму,
 * вона її фіксує.
 */
const FIXTURE = [
  {
    Contractor: "ФОРА ТОВ",
    DetailInfo: [
      { EDRPOU: "32294897", Account: "Счет на оплату покупателю 000006460 від 07.08.2026 00:00:00",
        Comment: "Семенюк Дмитро, Загружен из amoCRM по сделке №62556749", Sum: 83000, SumVal: 0 },
      { EDRPOU: "32294897", Account: "Счет на оплату покупателю 000005719 від 16.07.2026 00:00:00",
        Comment: "Семенюк Дмитро, Загружен из amoCRM по сделке №62477793", Sum: 5550, SumVal: 0 },
    ],
  },
  {
    Contractor: "E-TRADE GROUP SP.z o.o",
    DetailInfo: [
      { EDRPOU: "", Account: "Счет на оплату покупателю 000006846 від 07.08.2026 18:47:20",
        Comment: "62550507 / Хомік Вікторія", Sum: 49088.12, SumVal: 950 },
    ],
  },
  {
    Contractor: "ППМ ГРУПП ТОВ",
    DetailInfo: [
      { EDRPOU: "", Account: "Счет на оплату покупателю 000004777 від 02.06.2026 10:00:00",
        Comment: "Ксенія / 62197315", Sum: 13000, SumVal: 0 },
    ],
  },
  {
    Contractor: "УКРЕНЕРГО-АЛЬЯНС ТОВ",
    DetailInfo: [
      // 🪤 «3456547» — це ХВІСТ ТЕЛЕФОНУ, а не № угоди. Живий рядок 1С.
      { EDRPOU: "36471838", Account: "Счет на оплату покупателю 00000003074 від 25.07.2023 00:00:00",
        Comment: "Возович Антон,  38(068)3456547 - 25.07.2023 - Рено ВС8654Р", Sum: 28000, SumVal: 0 },
    ],
  },
  {
    // 🪤 Порожня назва: борг є, контрагента 1С не назвав. Ключа не буде.
    Contractor: "",
    DetailInfo: [
      { EDRPOU: "", Account: "Счет на оплату покупателю 00000003165 від 01.05.2026 00:00:00",
        Comment: "Цалко Олександр, Загружен из amoCRM по сделке №62152663", Sum: 2000, SumVal: 0 },
    ],
  },
  {
    // 🪤 Гривневий еквівалент нульовий, валютний борг є (жива форма з -362).
    Contractor: "SYNCHRON SRL",
    DetailInfo: [
      { EDRPOU: "RO6228610", Account: "Счет на оплату покупателю 000006061 від 29.07.2026 17:11:38",
        Comment: "62507447/ Чукін Євген", Sum: 0, SumVal: 15 },
    ],
  },
  { Contractor: "БЕЗ ДЕТАЛЕЙ ТОВ", DetailInfo: null },
];

const parsed = () => parse1cPayload(FIXTURE);

// ─────────────────────────────── G1 ───────────────────────────────

test("#119 G1 РОЗБІР 1С: склад рядків, № і дата у 100%, відкинуте НАЗВАНЕ", () => {
  const { rows, skipped } = parsed();
  // 7 контрагентів → 8 рядків деталей; мінус порожня назва, мінус «без DetailInfo».
  assert.equal(rows.length, 6, "рядків після розбору");
  assert.equal(skipped.noName, 1, "рядок без назви контрагента відкинуто й ПОРАХОВАНО");
  assert.equal(skipped.noDetail, 1, "контрагент без DetailInfo відкинуто й ПОРАХОВАНО");
  assert.equal(skipped.noAmount, 0, "рядок Sum=0/SumVal=15 НЕ відкидається — борг є");

  // 🔴 №/дата — у 100%: саме на цьому тримається ключ нотаток до рахунків.
  assert.equal(rows.filter((r) => r.invoiceNo != null).length, rows.length, "№ витягнуто в усіх");
  assert.equal(rows.filter((r) => r.invoiceDate != null).length, rows.length, "дата витягнута в усіх");
  const nos = rows.map((r) => r.invoiceNo);
  assert.equal(new Set(nos).size, nos.length, "№ рахунків не дублюються");

  const fora = rows.find((r) => r.invoiceNo === "000006460")!;
  assert.equal(fora.invoiceDate, "2026-08-07", "дата у ISO, день і місяць не переставлені");
  assert.equal(fora.amount, 83000);
  assert.equal(fora.clientKey, normalizeClientName("ФОРА ТОВ"));

  const synchron = rows.find((r) => r.clientName === "SYNCHRON SRL")!;
  assert.equal(synchron.amount, 0);
  assert.equal(synchron.amountVal, 15, "валютна сума збережена окремо від гривневої");
});

test("#119b G1 ДЗЕРКАЛО: не масив — це ЗЛАМАНЕ джерело, а не «нуль боргів»", () => {
  // Порожній результат мусить кричати, а не мовчати: мовчазний `[]` тут і був би
  // тим самим хибно-зеленим, що «успіх за 0 мс».
  assert.throws(() => parse1cPayload(null), /не масив/);
  assert.throws(() => parse1cPayload({ Contractor: "х" }), /не масив/);
  assert.throws(() => parse1cPayload("[]"), /не масив/);
  // А ось порожній МАСИВ — розбирається без винятку: це вже питання порогів (G2),
  // і плутати «джерело зламане» з «джерело віддало мало» не можна.
  assert.deepEqual(parse1cPayload([]).rows, []);
});

test("#120 № УГОДИ: три живі форми ловляться, ТЕЛЕФОН — ні", () => {
  assert.equal(dealIdOf("Семенюк Дмитро, Загружен из amoCRM по сделке №62556749"), 62556749);
  assert.equal(dealIdOf("62550507 / Хомік Вікторія"), 62550507, "id попереду");
  assert.equal(dealIdOf("Ксенія / 62197315"), 62197315, "id позаду");
  // 🪤 Головне твердження гейта: вільний `\d{7,}` дав би тут 3456547.
  assert.equal(dealIdOf("Возович Антон,  38(068)3456547 - 25.07.2023 - Рено ВС8654Р"), null);
  assert.equal(dealIdOf(""), null);
  assert.equal(dealIdOf(undefined), null);
});

// ─────────────────────────────── G2 ───────────────────────────────

test("#121 G2 ПОРОЖНЯ/МАЛА ВІДПОВІДЬ = ПРОВАЛ: три умови", () => {
  assert.equal(payloadVerdict(0, 296).ok, false, "порожньо → провал");
  assert.match((payloadVerdict(0, 296) as { reason: string }).reason, /порожн/i);

  assert.equal(payloadVerdict(MIN_ROWS_ABS - 1, 0).ok, false, "менше абсолютного порога → провал");
  assert.equal(payloadVerdict(MIN_ROWS_ABS, 0).ok, true, "рівно поріг → проходить");

  // Обвал проти минулого разу: 296 → 100 це менше за половину.
  assert.equal(payloadVerdict(100, 296).ok, false, "обвал удвічі → провал");
  assert.equal(payloadVerdict(Math.floor(296 * MIN_ROWS_RATIO), 296).ok, true, "рівно половина → проходить");
  assert.equal(payloadVerdict(296, 296).ok, true, "звичайний прогін → проходить");

  // 🔴 ПЕРШИЙ ЗАПУСК: без цієї гілки запобіжник заблокував би саме те, заради
  // чого стоїть, — початкове наповнення порожньої бази.
  assert.equal(payloadVerdict(296, 0).ok, true, "попереднього прогону не було → частка не застосовується");
});

test("#121b G2 ПОВЕДІНКОЮ: порожня відповідь ВІДХИЛЯЄТЬСЯ, а не повертає []", async () => {
  await assert.rejects(() => loadReceivables1c(async () => [], 296), /порожн/i);
  await assert.rejects(() => loadReceivables1c(async () => FIXTURE, 296), /рядків/i,
    "6 рядків проти 296 минулого разу — теж провал");
  await assert.rejects(() => loadReceivables1c(async () => null, 0), /не масив/);
  // 🪞 ДЗЕРКАЛО: правдоподібна відповідь ПРОХОДИТЬ. Без нього гейт зеленів би
  // і тоді, коли `loadReceivables1c` кидає ЗАВЖДИ, — тобто коли синк мертвий.
  const many = Array.from({ length: 60 }, (_, i) => ({
    Contractor: `КЛІЄНТ ${i} ТОВ`,
    DetailInfo: [{ EDRPOU: "", Account: `Счет на оплату покупателю 00000${1000 + i} від 01.08.2026 00:00:00`,
      Comment: `Хтось, Загружен из amoCRM по сделке №6200000${i % 10}`, Sum: 100 + i, SumVal: 0 }],
  }));
  const ok = await loadReceivables1c(async () => many, 60);
  assert.equal(ok.length, 60);
});

test("#121c G2 ПОРЯДОК: перевірка стоїть ДО того, як джоба чіпає таблиці", () => {
  // ⚠️ ЧЕСНА МЕЖА: довести «TRUNCATE не викликано» поведінкою можна лише з живою
  // БД, а `pool` — модульний синглтон. Тому тут перевіряється ПОРЯДОК у джерелі:
  // `loadReceivables1c` (який кидає на поганій відповіді) мусить стояти вище за
  // `pool.connect()` і `TRUNCATE`. Це той самий прийом, що в #52b — гейт стереже
  // РІШЕННЯ, а не текст, і без нього перестановка двох рядків тихо зняла б захист.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "../../src/jobs/syncReceivables.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function syncReceivables"));
  const guard = body.indexOf("loadReceivables1c(");
  const connect = body.indexOf("pool.connect()");
  const truncate = body.indexOf("TRUNCATE receivables");
  assert.ok(guard > 0 && connect > 0 && truncate > 0, "усі три орієнтири знайдено");
  assert.ok(guard < connect, "перевірка відповіді — ДО з'єднання з БД");
  assert.ok(guard < truncate, "перевірка відповіді — ДО TRUNCATE");
});

// ─────────────────────────────── G4 ───────────────────────────────

test("#122 G4 КЛЮЧІ НЕ ЗСУНУЛИСЬ: нотатки приклеюються тим самим виразом", () => {
  // 🔴 ЩО САМЕ СТЕРЕЖЕМО. `receivable_notes` (PK client_key) і
  // `receivable_invoice_notes` (PK client_key + invoice_no) переживають TRUNCATE
  // і приклеюються назад ПО КЛЮЧУ. Зміна джерела не сміє змінити ключ — інакше
  // 104 нотатки тімлідів мовчки відірвуться від своїх боргів.
  // Еталон — вираз, яким жила гугл-таблиця ДО міграції, відтворений тут дослівно.
  const legacyInvoiceNo = (cell: string) => (cell.match(/(\d{5,})/) ?? [])[1] ?? null;
  const legacyDate = (cell: string) => {
    const m = cell.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  };
  for (const c of FIXTURE) {
    for (const d of (c.DetailInfo ?? []) as { Account: string }[]) {
      const ref = invoiceRefOf(d.Account);
      assert.equal(ref.no, legacyInvoiceNo(d.Account), `№ рахунку ${d.Account}`);
      assert.equal(ref.date, legacyDate(d.Account), `дата ${d.Account}`);
    }
  }
  // 🔴 КЛЮЧ — ЛІТЕРАЛАМИ, А НЕ `normalizeClientName(name)`. Порівняння з тією ж
  // функцією, якою ключ і рахується, — це заборонена перевірка «A = A»: вона
  // лишиться зеленою, навіть якщо нормалізація перестане нормалізувати.
  const keyOf = (name: string) => parsed().rows.find((r) => r.clientName === name)!.clientKey;
  assert.equal(keyOf("ФОРА ТОВ"), "фора", "«ТОВ» зрізано, регістр знижено");
  assert.equal(keyOf("УКРЕНЕРГО-АЛЬЯНС ТОВ"), "укренергоальянс", "дефіс і пробіли схлопнуто");
  assert.equal(keyOf("E-TRADE GROUP SP.z o.o"), normalizeClientName("E-TRADE GROUP SP.z o.o"));
  // ⚠️ Останній рядок СВІДОМО через функцію: латиниця з крапками — саме той
  // випадок, де зашитий літерал протух би при будь-якій правці нормалізації,
  // не сказавши нічого корисного. Два літерали вище тримають суть.
});

// ─────────────────────────────── G6 ───────────────────────────────

test("#123 G6 МЕНЕДЖЕР: перевага Kommo, фолбек на ПІБ, і дзеркало", () => {
  const byName = new Map([["Деревенчук Крістіна", 189], ["Шаврова Лілія", 81]]);
  const byDeal = new Map([[61725029, 81]]);
  const ctx = { managerIdByDeal: byDeal, managerIdByName: byName };

  // 🔴 РОЗБІЖНІСТЬ: 1С підписав звільнену людину, Kommo знає чинну. Виграє Kommo.
  assert.equal(
    resolveManagerId({ dealId: 61725029, managerHint: "Деревенчук Крістіна" }, ctx), 81,
    "№ угоди б'є ПІБ із коментаря"
  );
  // 🪞 ДЗЕРКАЛО: без цього «перевага Kommo» могла б бути реалізована як
  // «ігноруй ПІБ» — і 11 рахунків без № угоди лишились би без менеджера.
  assert.equal(
    resolveManagerId({ dealId: null, managerHint: "Деревенчук Крістіна" }, ctx), 189,
    "немає № угоди — працює фолбек на ПІБ"
  );
  // Угода відома, але її немає в `deals` (старша за горизонт) → фолбек теж живий.
  assert.equal(
    resolveManagerId({ dealId: 60146721, managerHint: "Шаврова Лілія" }, ctx), 81,
    "угоди немає в базі — падаємо на ПІБ, а не в null"
  );
  assert.equal(
    resolveManagerId({ dealId: null, managerHint: "Хтось Невідомий" }, ctx), null,
    "жодне джерело не спрацювало — чесний null, а не вгаданий менеджер"
  );
  // Підказка-ПІБ уміє зняти провідний «id /» — інакше форма «62550507 / ПІБ»
  // ніколи не дала б збігу з `managers.name`.
  assert.equal(managerHintOf("62550507 / Хомік Вікторія"), "Хомік Вікторія");
  assert.equal(managerHintOf("Семенюк Дмитро, Загружен из amoCRM"), "Семенюк Дмитро");
});

// ─────────────────────────────── G3 (живий) ───────────────────────────────

test("#124 G3 Σ 1С == Σ БАЗИ, Δ0 (і РЯДКИ, і сума)", { ...needsApi() }, async () => {
  // 🔴 ЦЕЙ ГЕЙТ НЕ ЗАРЕЄСТРОВАНО В ДОЗВОЛЕНИХ ПРОД-СКІПАХ, І ЦЕ НАВМИСНО.
  // З прод-сервера 1С досяжний (заміряно: 200, ~0.8 c), тож у `test:prod` гейт
  // МУСИТЬ виконатись. Дозволити йому скіпатись означало б дозволити мовчати
  // саме тоді, коли джерело лягло, — тобто зробити з нього декорацію.
  // У контейнері 1С недосяжний, але там інший режим: `npm test` скіпає його
  // разом з усіма живими гейтами через `needsApi()`, і це законний скіп.
  const { config } = await import("../config.js");
  const { pool } = await import("../db/pool.js");

  const res = await fetch(config.receivables1cUrl);
  assert.equal(res.ok, true, "1С відповів");
  const { rows } = parse1cPayload(await res.json());
  assert.ok(rows.length > 0, "1С віддав непорожній перелік");

  // Звіряємо РІВНО ті пари (клієнт, №), які прийшли з 1С. Готівкові рядки в цю
  // множину не потрапляють за побудовою, тож окремий фільтр по них не потрібен —
  // а той, що я написав спершу (по вигляду `service_url`), після міграції
  // перестав би фільтрувати будь-що: лінк на угоду тепер і в 1С-рядків.
  const pairs = rows.map((r) => `${r.clientKey}|${r.invoiceNo}`);
  const db = await pool.query<{ n: string; sum: string }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS sum
       FROM receivable_invoices
      WHERE client_key || '|' || COALESCE(invoice_no, '') = ANY($1)`,
    [pairs]
  );
  // 🔴 І КІЛЬКІСТЬ, І СУМА. Сама лише сума зеленіла б, якби один рядок зник, а
  // інший подвоївся — рівно той клас, від якого рятує дедуп у грошових метриках.
  assert.equal(Number(db.rows[0].n), rows.length,
    `рядків: 1С ${rows.length}, у базі ${db.rows[0].n}`);
  const fromSource = rows.reduce((s, r) => s + r.amount, 0);
  const delta = Math.abs(Number(db.rows[0].sum) - fromSource);
  assert.ok(delta < 1,
    `Σ 1С ${fromSource.toFixed(2)} vs Σ бази ${Number(db.rows[0].sum).toFixed(2)}, Δ ${delta.toFixed(2)}`);
});

test("#125 G3b ЖИВІ НОТАТКИ НЕ ВТРАТИЛИ ПАРИ", { ...needsApi() }, async () => {
  const { config } = await import("../config.js");
  const { pool } = await import("../db/pool.js");
  const { CASH_RECEIVABLE_CLIENTS } = await import("./syncReceivables.js");
  const res = await fetch(config.receivables1cUrl);
  const { rows } = parse1cPayload(await res.json());

  // 🔴 ОЧІКУВАНА МНОЖИНА — З ДВОХ ДЖЕРЕЛ, БО `receivables` НАПОВНЮЮТЬ ДВІ ГІЛКИ
  // ОДНІЄЇ ДЖОБИ: рядки з 1С і готівкові з CRM (`insertCashReceivables`).
  // Готівка не має безнальних рахунків у принципі (правило з CLAUDE.md), тож
  // готівковий клієнт законно є в дебіторці й законно відсутній у 1С. Поки гейт
  // звіряв лише з 1С, він червонів САМЕ ТОМУ, що обидві гілки відпрацювали як
  // задумано: заміряно на проді 21.08.2026 — «45 ≠ 44», і вся різниця це
  // «МГЕР (готівка)» на 231 417 ₴ із 25 угодами типу «Наличные».
  //
  // ⚠️ ЧОМУ НЕ ПРОСТО ВЗЯТИ КЛЮЧІ З `receivables`. Це перетворило б перевірку на
  // «A == A»: таблиця звірялася б сама з собою і зеленіла б за будь-якого зсуву
  // ключів у синку — тобто рівно тоді, коли гейт і потрібен. Тому обидві половини
  // очікуваного беруться з ДЖЕРЕЛ: 1С — живим запитом через те саме ядро розбору,
  // готівка — з реєстру `CASH_RECEIVABLE_CLIENTS`, за яким синк і пише рядок.
  const cashKeys = CASH_RECEIVABLE_CLIENTS.map((c) => c.keys[0]);
  const keys = new Set([...rows.map((r) => r.clientKey), ...cashKeys]);
  const pairs = new Set(rows.map((r) => `${r.clientKey}|${r.invoiceNo}`));

  const inDbKeys = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM receivable_notes n
      WHERE EXISTS (SELECT 1 FROM receivables r WHERE r.client_key = n.client_key)`
  );
  const expectKeys = (await pool.query<{ client_key: string }>(`SELECT client_key FROM receivable_notes`))
    .rows.filter((n) => keys.has(n.client_key)).length;
  // 🔴 Не «≥ нуля», а саме: скільки нотаток МАЮТЬ пару за даними 1С, стільки їх
  // і має мати пару в базі. Різниця означає, що синк порахував ключ інакше, ніж
  // ядро, — тобто рівно та тиха поломка, від якої гейт і стоїть.
  assert.equal(Number(inDbKeys.rows[0].n), expectKeys,
    "нотаток по клієнту з живою парою: база vs джерела (1С ∪ готівка)");

  const invRows = await pool.query<{ client_key: string; invoice_no: string }>(
    `SELECT client_key, invoice_no FROM receivable_invoice_notes`
  );
  const expectInv = invRows.rows.filter((n) => pairs.has(`${n.client_key}|${n.invoice_no}`)).length;
  // ⚠️ ТА САМА АСИМЕТРІЯ, ЩО Й ВИЩЕ, тільки на рівні рахунків: готівкові рахунки
  // теж пише `insertCashReceivables` (їхній `invoice_no` — це `kommo_id` угоди), і
  // в 1С їх немає. Очікувана сторона їх не бачить, фактична бачила б — тобто гейт
  // почервонів би від першої ж нотатки на готівковому рахунку.
  // 🔴 ЧЕСНА МЕЖА, НАЗВАНА ВГОЛОС: нотатки до ГОТІВКОВИХ рахунків цей гейт не
  // перевіряє взагалі — обидві сторони їх виключають однаково. Прибирати їх лише
  // з однієї сторони означало б підганяти число; тягнути очікування з таблиці —
  // знову «A == A». Ризик тут малий: `invoice_no` готівкового рахунку це id угоди
  // Kommo, а не нормалізований ключ, тож «зсунутись» йому нема від чого.
  const haveInv = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM receivable_invoice_notes nn
      WHERE EXISTS (SELECT 1 FROM receivable_invoices ri
                     WHERE ri.client_key = nn.client_key AND COALESCE(ri.invoice_no,'') = nn.invoice_no
                       AND NOT (ri.client_key = ANY($1)))`,
    [cashKeys]
  );
  assert.equal(Number(haveInv.rows[0].n), expectInv,
    "нотаток до рахунків з живою парою: база vs 1С");
});

/**
 * #199cf — ЧАС ІЗ 1С: СЕНТИНЕЛ ПІВНОЧІ СТАЄ `null` У ПАРСЕРІ, ОДИН РАЗ.
 *
 * 🔴 ЩО ДОВЕДЕНО ЗАМІРОМ, А НЕ ПРИПУЩЕНО (живий фід, 27.08.2026, 73 контрагенти
 * → 293 рядки-рахунки):
 *
 *   без часу в рядку взагалі:   0
 *   рівно 00:00:00:           121
 *   справжній час:            172
 *
 * Доказ, що `00:00:00` — заглушка, а не мить доби: у годині `00` НЕМАЄ ЖОДНОГО
 * іншого значення (ні `00:07`, ні `00:41`), тоді як решта годин дає нормальний
 * робочий день — 09h:20, 10h:24, 11h:14, 12h:19, 13h:19, пік 09-13. Одне
 * значення, повторене 121 раз. Той самий клас, що `utm_source: ""` у Ringostat.
 *
 * 🔗 ЦЕ СПІЛЬНИЙ ПАРСЕР: його кличуть `syncReceivables` (колонка `invoice_at`) і
 * `#124` (виключення рахунків, виписаних пізніше за синк). Другий вираз того
 * самого правила розійшовся б мовчки, тому вираз один.
 */
test("#199cf час із 1С: сентинел півночі → null, справжній час → HH:MM:SS", async () => {
  const { invoiceRefOf } = await import("../core/receivables1c.js");
  const A = (s: string) => invoiceRefOf(s);

  // Справжній час — розбирається повністю, разом із наївним `at`.
  const real = A("Счет на оплату покупателю 000007004 від 26.08.2026 14:46:16");
  assert.equal(real.no, "000007004");
  assert.equal(real.date, "2026-08-26");
  assert.equal(real.time, "14:46:16");
  assert.equal(real.at, "2026-08-26 14:46:16",
    "🔴 `at` мусить бути НАЇВНИМ локальним рядком — зону накладає споживач, не парсер");

  // 🔴 СЕНТИНЕЛ. Дата лишається, час стає null.
  const mid = A("Счет на оплату покупателю 000006958 від 24.08.2026 00:00:00");
  assert.equal(mid.date, "2026-08-24", "🔴 сентинел зʼїв разом із часом ще й дату");
  assert.equal(mid.time, null,
    "🔴 `00:00:00` прийнято за час. У 1С це ЗАГЛУШКА: 121 із 293 рядків, і в годині 00 "
    + "немає жодного іншого значення. 121 рахунок дістав би впевнену мить доби, якої ми не знаємо");
  assert.equal(mid.at, null, "🔴 `at` зібрано з неіснуючого часу");

  // Часу немає взагалі — той самий результат, і це навмисно: обидва стани
  // означають «не знаємо», і розрізняти їх на екрані нема для чого.
  const noTime = A("Счет на оплату покупателю 000006958 від 24.08.2026");
  assert.equal(noTime.date, "2026-08-24");
  assert.equal(noTime.time, null);
  assert.equal(noTime.at, null);

  // 🪞 ДЗЕРКАЛО: сторож не вирізає ВСЕ підряд. Сусідні до півночі значення — час.
  for (const t of ["00:00:01", "00:01:00", "23:59:59", "08:05:00"]) {
    const r = A(`Счет 000001234 від 24.08.2026 ${t}`);
    assert.equal(r.time, t, `🔴 «${t}» прийнято за заглушку — сторож зарізав справжній час`);
    assert.equal(r.at, `2026-08-24 ${t}`);
  }

  // Порожній вхід не кидає й не вигадує.
  assert.deepEqual(A(""), { no: null, date: null, time: null, at: null });
  assert.deepEqual(invoiceRefOf(null), { no: null, date: null, time: null, at: null });

  // 🔴 СТАРІ ДВА ПОЛЯ НЕ ЗРУШЕНО. Ключ `receivable_invoice_notes` — це
  // (client_key, invoice_no); зміна розбору номера осиротила б усі нотатки.
  assert.equal(A("Счет на оплату покупателю 000006809 від 20.08.2026 10:28:44").no, "000006809");
  assert.equal(A("Счет на оплату покупателю 000006809 від 20.08.2026").no, "000006809");

  // 🔴 НИЖНЯ МЕЖА ДОВЖИНИ — ПʼЯТЬ ЦИФР, І ЦЕ ПЕРЕВІРЯЄТЬСЯ ОКРЕМО.
  // Спіймано власним саботажем: звуження `\d{5,}` → `\d{8,}` лишило гейт
  // ЗЕЛЕНИМ, бо всі номери у фікстурах девʼятизначні. Перевірка, що не може
  // впасти від зміни, яку стереже, — не перевірка. Той самий урок, що «гейт на
  // одне ЗНАЧЕННЯ властивості не перевіряє властивість».
  assert.equal(A("Счет 12345 від 24.08.2026 09:15:00").no, "12345",
    "🔴 пʼятизначний номер більше не витягується — межу `\\d{5,}` звузили, і рахунки з "
    + "короткими номерами лишились би без ключа, а їхні нотатки осиротіли б");
  // І дзеркало: рік із дати номером НЕ стає, навіть коли номера немає.
  assert.equal(A("Счет б/н від 24.08.2026 09:15:00").no, null,
    "🔴 у рядку без номера парсер вигадав номер — майже напевно схопив цифри дати");
});
