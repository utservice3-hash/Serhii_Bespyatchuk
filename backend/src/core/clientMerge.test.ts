import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsDb } from "../testMode.js";
import {
  MERGED_RECEIVABLE_ROW_SQL, hadAmountRefusal, hadDaysRefusal, mergeDateLabel,
  mergedLimitAmount, mergedLimitDays, mergedLimitNote, type MergeLimitRow,
} from "./mergeLimits.js";
import { mergeSourceOf, revokeAllowed, revokeDenyReason, type MergePairScope } from "../auth/mergeScope.js";

// Шлях у ДЖЕРЕЛА, а не в `dist`: гейти читають .ts, якого в збірці немає.
const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const SRC = (p: string) => srcOf(`../${p}`);
const FE = (p: string) => srcOf(`../../../frontend/src/${p}`);

/** Тіло роута обʼєднання — від його оголошення до наступного роута. */
function mergeRouteBody(): string {
  const src = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  const from = src.indexOf('dashboardRouter.post("/receivables/merge"');
  assert.ok(from > 0, "🔴 роут обʼєднання не знайдено — гейт міряє порожнечу");
  const to = src.indexOf("dashboardRouter.", from + 40);
  return src.slice(from, to > from ? to : undefined);
}

const row = (clientKey: string, limitDays: number | null, limitAmount: number | null): MergeLimitRow =>
  ({ clientKey, limitDays, limitAmount });

/* ───────────────────────── ЧИСТІ ПРАВИЛА ЗВЕДЕННЯ ───────────────────────── */

test("#240 дні зводяться МЕНШИМ, і NULL не вдає нуля", () => {
  // Відстрочка не складається: 30 + 10 дало б 40 днів, яких ніхто не погоджував.
  assert.equal(mergedLimitDays([row("a", 30, null), row("b", 10, null)]), 10);
  // 🔴 ВІДМОВА ПО ДНЯХ ВИГРАЄ САМА — це властивість мінімуму, а не окрема гілка.
  assert.equal(mergedLimitDays([row("a", 30, null), row("b", 0, null)]), 0);
  // 🔴 NULL — «ніколи не ставили», а не нуль. Наївний Math.min по Number(null)
  // зробив би відмовою кожне злиття, де хоч одна сторона ліміту не мала. Та сама
  // пастка, що коштувала заміру в `limitState` (54 клієнти замість девʼяти).
  assert.equal(mergedLimitDays([row("a", 30, null), row("b", null, null)]), 30,
    "🔴 NULL прикинувся нулем — сторона без ліміту стала відмовою");
  assert.equal(mergedLimitDays([row("a", null, null), row("b", null, null)]), null,
    "🔴 «нікому не ставили» перетворилось на число");

  // 🔴 ІНВАРІАНТ, ЯКИЙ ВЛАСНИК НАЗВАВ ОКРЕМО: зведене НЕ МОЖЕ вийти суворішим
  // за найсуворішу зі сторін. Для мінімуму це істинно за побудовою — і саме
  // тому воно тут: твердження перевіряє ВИБІР ОПЕРАЦІЇ, а не арифметику.
  for (const set of [[7, 21, 30], [0, 14], [5], [365, 1]]) {
    const rows = set.map((d, i) => row(`k${i}`, d, null));
    const m = mergedLimitDays(rows)!;
    assert.equal(m, Math.min(...set));
    assert.ok(m >= Math.min(...set), "🔴 зведені дні суворіші за найсуворішу сторону");
  }
});

test("#240b сума зводиться СКЛАДАННЯМ, і порожнеча лишається порожнечею", () => {
  assert.equal(mergedLimitAmount([row("a", null, 40000), row("b", null, 10000)]), 50000);
  assert.equal(mergedLimitAmount([row("a", null, 40000), row("b", null, null)]), 40000,
    "🔴 сторона без ліміту зʼїла погоджену суму");
  assert.equal(mergedLimitAmount([row("a", null, null), row("b", null, null)]), null,
    "🔴 «суму нікому не ставили» стало нулем, тобто ВІДМОВОЮ — це різні стани");
});

/**
 * #240c — «ВІДМОВА · 0 ₴» СКЛАДАЄТЬСЯ, ЯК І РЕШТА.
 *
 * 🔴 ЦЕЙ ГЕЙТ НАВМИСНО СТВЕРДЖУЄ ПРОТИЛЕЖНЕ ДО `#240`, і без цього абзацу
 * наступний читач вирішить, що це помилка, і «полагодить» на мінімум.
 *
 * Рішення власника 27.08.2026, дослівно: **0 + 40 000 = 40 000**. Причина —
 * ліміт суми це стеля БОРГУ, а борг після злиття складається; мінімум зробив би
 * перелімітником клієнта, який не зробив нічого, крім того, що до нього
 * приєднали другу юрособу.
 *
 * ⚠️ І САМЕ ТОМУ СЛІД ВІДМОВИ МУСИТЬ ЛИШИТИСЬ СЛОВАМИ. З числа він зникає
 * безслідно (нуль розчиняється в сумі), тож журнал ліміту зобовʼязаний назвати
 * його — інакше через місяць ніхто не пояснить, звідки в клієнта стеля, якої
 * йому не давали.
 */
test("#240c відмова «0 ₴» складається — а слід про неї лишається СЛОВАМИ", () => {
  assert.equal(mergedLimitAmount([row("a", null, 0), row("b", null, 40000)]), 40000,
    "🔴 відмова по сумі перебила погоджений ліміт — це скасовує рішення власника 27.08.2026");
  assert.equal(hadAmountRefusal([row("a", null, 0), row("b", null, 40000)]), true);
  assert.equal(hadAmountRefusal([row("a", null, null), row("b", null, 40000)]), false,
    "🔴 «ніколи не ставили» порахувалось як відмова");

  const note = mergedLimitNote([row("a", null, 0), row("b", null, 40000)], "2026-08-27");
  assert.match(note, /зведено при обʼєднанні 27\.08/, "🔴 у примітці немає дати зведення");
  assert.match(note, /відмова \(0 ₴\)/,
    "🔴 СЛІД ВІДМОВИ ЗНИК: число її не показує (нуль розчинився в сумі), а примітка мовчить");
  // 🪞 ДЗЕРКАЛО: без відмови примітка про неї НЕ бреше. Інакше текст стояв би
  // завжди, і його перестали б читати — той самий кінець, що в гейта, який
  // червоніє не з нашої вини.
  const clean = mergedLimitNote([row("a", null, 10000), row("b", null, 40000)], "2026-08-27");
  assert.doesNotMatch(clean, /відмова/,
    "🔴 примітка каже про відмову там, де її не було — підпис, якому перестануть вірити");
  // Відмова по ДНЯХ теж названа, хоч вона (на відміну від суми) ще й видна в
  // самому значенні: мінімум = 0.
  assert.match(mergedLimitNote([row("a", 0, null), row("b", 14, null)], "2026-08-27"), /по днях/);
  assert.equal(hadDaysRefusal([row("a", 0, null)]), true);
  assert.equal(mergeDateLabel("2026-08-27"), "27.08");
});

/* ─────────────────────── ПРАВО НА РОЗʼЄДНАННЯ ─────────────────────── */

/**
 * #246 — ВІДКІТ ПИТАЄ ТІ САМІ ДВЕРІ, У ЯКІ ЗАЙШЛО ЗЛИТТЯ.
 *
 * 📐 ЧЕСНА МЕЖА, НАЗВАНА ВГОЛОС: заміряно на проді 27.08.2026 — у реєстрі 178
 * злиттів і **жодного скасованого за всю історію**. Тобто відкіт на живих даних
 * не перевірявся НІ РАЗУ, і все, що про нього відомо, — це те, що написано.
 */
test("#246 право на розʼєднання визначає ДЖЕРЕЛО злиття", () => {
  const leadOwnsBoth: MergePairScope =
    { canAll: false, leadTeamId: 5, aliasTeamId: 5, canonicalTeamId: 5 };
  const nobody: MergePairScope =
    { canAll: false, leadTeamId: null, aliasTeamId: null, canonicalTeamId: null };

  // 🔴 ДІРКА ПЕРША: тімлід, у якого обидва боки свої, міг ВІДКОТИТИ злиття,
  // зроблене в дебіторці, — тобто скасувати дію, яку сам зробити не міг.
  assert.equal(revokeAllowed({ source: "receivables", hasMergeReceivables: false, pair: leadOwnsBoth }), false,
    "🔴 тімлід скасовує дію, доступ до якої має лише КВП/СЕО/ОД/адмін");
  // 🪞 ДЗЕРКАЛО ДО НЕЇ: у «Клієнтах» той самий тімлід відкочує, як і відкочував.
  assert.equal(revokeAllowed({ source: "clients", hasMergeReceivables: false, pair: leadOwnsBoth }), true,
    "🔴 звузили зайве — тімлід втратив відкіт власного злиття в «Клієнтах»");

  // 🔴 ДІРКА ДРУГА, ДЗЕРКАЛЬНА: роль із правом дебіторки мусить МОГТИ відкотити
  // своє злиття, навіть не маючи `merge_clients`. Інакше це незворотна кнопка —
  // рівно та, через яку Шевчука Назара довелось повертати SQL-ом по проду.
  assert.equal(revokeAllowed({ source: "receivables", hasMergeReceivables: true, pair: nobody }), true,
    "🔴 хто зліпив — не може роз'єднати: дія, недоступна для скасування тим самим інтерфейсом");
  assert.equal(revokeAllowed({ source: "clients", hasMergeReceivables: true, pair: nobody }), false,
    "🔴 право дебіторки почало відчиняти чужі двері «Клієнтів»");

  // Невідоме джерело читається як «Клієнти» — історичний дефолт: записи без
  // поля `source` зроблені саме там.
  assert.equal(mergeSourceOf({ source: "receivables" }), "receivables");
  assert.equal(mergeSourceOf({ approvedAt: "2026-01-01" }), "clients");
  assert.equal(mergeSourceOf(null), "clients");
  assert.equal(mergeSourceOf(undefined), "clients");

  // Причина відмови називає ТІ двері, а не абстрактне «Forbidden».
  assert.match(revokeDenyReason({ source: "receivables", hasMergeReceivables: false, pair: leadOwnsBoth }),
    /дебіторц/i, "🔴 відмова не називає, куди саме людина не проходить");
});

/* ─────────────────────── ДІАЛОГ: ПРИРЕЧЕНА ДІЯ ─────────────────────── */

test("#245 діалог позначає ключі, які вже приймають псевдоніми — і не пускає їх у псевдоніми", async () => {
  // ⚠️ Специфікатор У ЗМІННІЙ — навмисно (той самий прийом, що в `#199…`):
  // `tsc` бекенду не має права тягнути файл поза своїм `rootDir`, а рантайм
  // node роздягає типи й імпортує його без збірки.
  const VIEW = "../../../frontend/src/pages/dashboard/receivablesView.ts";
  type Side = { clientKey: string; clientName: string; amount: number; invoices: number; alreadyCanonical: number };
  const V = (await import(VIEW)) as {
    mergeProblem: (a: readonly Side[], b: Side | null, reason: string) => string | null;
    mergeSummary: (a: readonly Side[], b: Side | null) => { parties: number; amount: number; invoices: number };
    MERGE_LIMIT_RULE: string;
  };
  const side = (k: string, already = 0): Side =>
    ({ clientKey: k, clientName: k.toUpperCase(), amount: 100, invoices: 2, alreadyCanonical: already });

  const plain = side("п1"), canon = side("канон"), hub = side("вузол", 11);

  // 🔴 ЛАНЦЮЖОК — ПРИРЕЧЕНА ДІЯ. Тригер `client_key_alias_no_chain` відхилить її
  // в БД (доведено в `#243`), і без цієї перевірки людина дізнавалась би правило
  // з тексту помилки 409 — тобто вчилась би на дії, яка не могла спрацювати.
  const chained = V.mergeProblem([hub], canon, "спільний контакт");
  assert.ok(chained && /лише основним/.test(chained),
    "🔴 діалог пропонує зробити псевдонімом ключ, який уже приймає псевдоніми");
  assert.ok(chained.includes("11"),
    "🔴 позначка не називає ЧИСЛА — «уже обʼєднує» без кількості нічого не пояснює");

  // 🪞 ДЗЕРКАЛО ПЕРШЕ: ТОЙ САМИЙ ключ ОСНОВНИМ — цілком законно. Заборона
  // однобічна: на проді один канонічний тримає 11 псевдонімів і може прийняти
  // ще. Без цього дзеркала «забороняти завжди» було б зеленим.
  assert.equal(V.mergeProblem([plain], hub, "спільний контакт"), null,
    "🔴 звузили зайве: ключ, що вже приймає псевдоніми, перестав бути придатним ОСНОВНИМ");

  // 🪞 ДЗЕРКАЛО ДРУГЕ: звичайний набір проходить — інакше кнопка була б сірою
  // завжди, і гейт читався б як надійність.
  assert.equal(V.mergeProblem([plain, side("п2")], canon, "спільний ЄДРПОУ"), null);

  // Решта відмов названа своїми словами, а не спільним «оберіть сторони».
  assert.match(V.mergeProblem([], canon, "причина")!, /кого приєднати/);
  assert.match(V.mergeProblem([plain], null, "причина")!, /основного/);
  assert.match(V.mergeProblem([canon], canon, "причина")!, /із самим собою/);
  assert.match(V.mergeProblem([plain], canon, "   ")!, /Причина обовʼязкова/);

  // Підсумок рахує ВСІ сторони, включно з основним: інакше людина підтверджувала
  // б суму, меншу за ту, що побачить у рядку.
  const sum = V.mergeSummary([plain, side("п2")], canon);
  assert.equal(sum.parties, 3);
  assert.equal(sum.amount, 300, "🔴 підсумок загубив основного — підтверджують не той результат");
  assert.equal(sum.invoices, 6);

  // 🔴 ПРАВИЛО ЛІМІТІВ — СЛОВАМИ, І ЦЕ СВІДОМА ВІДМОВА ВІД ПЕРЕДПОКАЗУ ЧИСЛОМ:
  // друге обчислення того самого правила на фронті розійшлося б із ядром мовчки.
  assert.match(V.MERGE_LIMIT_RULE, /менший/, "🔴 діалог не каже, що дні беруться меншим");
  assert.match(V.MERGE_LIMIT_RULE, /складеться/, "🔴 діалог не каже, що сума складається");
  assert.match(V.MERGE_LIMIT_RULE, /0 ₴/,
    "🔴 діалог мовчить про те, що відмова «0 ₴» ДОДАЄ НУЛЬ, а не обнуляє ліміт");

  // Джерело діалогу: рядок із ланцюжком не ховається, а ПОЯСНЮЄТЬСЯ. Зникле без
  // пояснення читається як «клієнта немає».
  const dlg = readFileSync(FE("pages/dashboard/sections/MergeDialog.tsx"), "utf8");
  assert.match(dlg, /alreadyCanonical > 0/, "🔴 діалог більше не читає стан реєстру");
  assert.match(dlg, /уже обʼєднує \{s\.alreadyCanonical\}/,
    "🔴 позначка зі списку зникла — людина побачила б лише сірий чекбокс без причини");
});

/* ─────────────────────── ПОВЕДІНКА ПРОТИ СХЕМИ ─────────────────────── */

test("#241 рядок злитого клієнта отримує ЗВЕДЕНІ ліміти одразу, а не через синк", needsDb(), async (t) => {
  // 🔴 ВИКОНАННЯМ, А НЕ ЧИТАННЯМ. Дефект був у ПЕРЕЛІКУ КОЛОНОК: `limit_amount`
  // у ньому не існувало, `limit_days` вставлявся NULL. Такого «схоже написаний»
  // SQL не ловить у принципі — тому женемо САМ текст запиту роута.
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SRC("db/schema.sql"), "utf8"));
    await c.query(
      `INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, invoice_no, amount, invoice_date)
       VALUES ('канон','канон','ОСНОВНА',        '100001', 1000, CURRENT_DATE - 40),
              ('канон','псевдо','ПРИЄДНАНА',     '100002',  500, CURRENT_DATE - 10)`);
    await c.query(MERGED_RECEIVABLE_ROW_SQL, ["канон", 10, 40000]);
    const r = await c.query<{ amount: string; limit_days: number | null; limit_amount: string | null; client_name: string }>(
      `SELECT amount, limit_days, limit_amount, client_name FROM receivables WHERE client_key = 'канон'`);
    assert.equal(r.rowCount, 1, "🔴 рядок злитого клієнта не зібрався");
    assert.equal(Number(r.rows[0].amount), 1500, "🔴 борг обох юросіб не склався");
    assert.equal(Number(r.rows[0].limit_days), 10, "🔴 зведені ДНІ не доїхали до рядка");
    assert.equal(Number(r.rows[0].limit_amount), 40000,
      "🔴 зведена СУМА не доїхала до рядка — до синку клієнт стоїть перелімітником, "
      + "бо неузгоджений ліміт поводиться як нульовий");
    assert.equal(r.rows[0].client_name, "ОСНОВНА",
      "🔴 назва взялась не з канонічної юрособи — рядок називався б приєднаною");
  } finally { await c.end(); scratch.dispose(); }
});

test("#242 нотатка до рахунка ПЕРЕЖИВАЄ обʼєднання клієнтів", needsDb(), async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    const schema = readFileSync(SRC("db/schema.sql"), "utf8");
    await c.query(schema);
    // ДО злиття: ключ ще сам собі канонічний, нотатка писалась саме під ним.
    await c.query(
      `INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, invoice_no, amount, invoice_date)
       VALUES ('псевдо','псевдо','ПРИЄДНАНА','100002', 500, CURRENT_DATE - 10)`);
    await c.query(
      `INSERT INTO receivable_invoice_notes (client_key, invoice_no, due_date, comment)
       VALUES ('псевдо','100002', CURRENT_DATE + 3, 'обіцяли у пʼятницю')`);
    // 🧾 БЕКФІЛ — ЧАСТИНА МІГРАЦІЇ, і він мусить спрацювати на повторному прогоні
    // схеми, а не «колись руками».
    await c.query(schema);
    const filled = await c.query<{ client_key_raw: string | null }>(
      `SELECT client_key_raw FROM receivable_invoice_notes WHERE invoice_no = '100002'`);
    assert.equal(filled.rows[0].client_key_raw, "псевдо",
      "🔴 бекфіл не проставив сирий ключ — нотатка лишилась привʼязаною до рухомого");

    // Обʼєднання: рахунок переїхав під канонічний ключ, сирий не зрушив.
    await c.query(`UPDATE receivable_invoices SET client_key = 'канон' WHERE invoice_no = '100002'`);
    const byRaw = await c.query(
      `SELECT nn.comment FROM receivable_invoices ri
         LEFT JOIN receivable_invoice_notes nn
                ON nn.client_key_raw = ri.client_key_raw AND nn.invoice_no = COALESCE(ri.invoice_no,'')
        WHERE ri.invoice_no = '100002'`);
    assert.equal(byRaw.rows[0].comment, "обіцяли у пʼятницю",
      "🔴 нотатка відчепилась від рахунка після обʼєднання");
    // 🔴 НЕГАТИВНИЙ КОНТРОЛЬ: старий звʼязок по канонічному ключу справді ЗЛАМАНИЙ.
    // Без нього гейт зеленів би й тоді, коли обидва способи однакові, тобто не
    // доводив би нічого.
    const byCanon = await c.query(
      `SELECT nn.comment FROM receivable_invoices ri
         LEFT JOIN receivable_invoice_notes nn
                ON nn.client_key = ri.client_key AND nn.invoice_no = COALESCE(ri.invoice_no,'')
        WHERE ri.invoice_no = '100002'`);
    assert.equal(byCanon.rows[0].comment, null,
      "🔴 фікстура не відтворює поломку: по канонічному ключу нотатка ще знаходиться");

    // 🔒 ДРУГА НОТАТКА НА ТОЙ САМИЙ РАХУНОК — НЕМОЖЛИВА. Без часткового
    // унікального індексу запис після склейки створив би ДРУГИЙ рядок, і
    // `LEFT JOIN` показав би рахунок ДВІЧІ.
    await assert.rejects(
      () => c.query(`INSERT INTO receivable_invoice_notes (client_key, client_key_raw, invoice_no, comment)
                     VALUES ('канон','псевдо','100002','друга')`),
      /duplicate|унікальн/i, "🔴 БД прийняла другу нотатку на той самий рахунок");

    // 🔴 І ДЖЕРЕЛО РОУТА МУСИТЬ ЧИТАТИ САМЕ ТАК. Властивість даних доведена вище;
    // без цієї перевірки роут міг би й далі джойнити по канонічному.
    const src = readFileSync(SRC("routes/dashboard.ts"), "utf8");
    assert.match(src, /nn\.client_key_raw\s*=\s*ri\.client_key_raw/,
      "🔴 розкриття джойнить нотатки по КАНОНІЧНОМУ ключу — після склейки вони зникнуть");
  } finally { await c.end(); scratch.dispose(); }
});

test("#243 N псевдонімів під ОДНИМ канонічним — законні, і це не ланцюжок", needsDb(), async (t) => {
  // 📐 Модель це вміла завжди (на проді «компаніяштайнерукраїна» тримає 11);
  // не вмів РОУТ. Гейт закріплює саме те, на чому стоїть увесь прохід.
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SRC("db/schema.sql"), "utf8"));
    for (const a of ["п1", "п2", "п3"]) {
      await c.query(
        `INSERT INTO client_key_alias (alias_key, canonical_key, reason, evidence)
         VALUES ($1,'канон','один клієнт','{"source":"receivables"}'::jsonb)`, [a]);
    }
    const n = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM client_key_alias WHERE canonical_key='канон' AND revoked_at IS NULL`);
    assert.equal(Number(n.rows[0].n), 3, "🔴 N→1 не склалось — увесь прохід стоїть на цьому");
    // 🔴 А ЛАНЦЮЖОК — ЗАБОРОНЕНИЙ, і саме тому діалог позначає такі ключі: без
    // позначки людина дізнавалась би правило з тексту 409.
    await assert.rejects(
      () => c.query(`INSERT INTO client_key_alias (alias_key, canonical_key, reason)
                     VALUES ('канон','інший','спроба ланцюжка')`),
      /ланцюж/i, "🔴 БД пустила ланцюжок — позначка в діалозі стереже неіснуюче правило");
  } finally { await c.end(); scratch.dispose(); }
});

test("#247 обʼєднання НЕ рухає суму боргу", needsDb(), async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SRC("db/schema.sql"), "utf8"));
    await c.query(
      `INSERT INTO receivable_invoices (client_key, client_key_raw, client_name, invoice_no, amount, invoice_date)
       VALUES ('канон','канон','ОСНОВНА','1', 1000, CURRENT_DATE - 5),
              ('псевдо','псевдо','ДРУГА',  '2',  250, CURRENT_DATE - 5),
              ('чужий','чужий','ТРЕТЯ',    '3',  777, CURRENT_DATE - 5)`);
    const total = async () => Number((await c.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount),0) AS s FROM receivable_invoices`)).rows[0].s);
    const before = await total();
    // Склейка застосовується до рахунків тим самим виразом, що й у синку.
    await c.query(`UPDATE receivable_invoices SET client_key = 'канон' WHERE client_key_raw = 'псевдо'`);
    await c.query(MERGED_RECEIVABLE_ROW_SQL, ["канон", null, null]);
    assert.equal(await total(), before, "🔴 обʼєднання змінило суму боргу — воно має лише ПЕРЕГРУПУВАТИ");
    const rec = await c.query<{ s: string }>(`SELECT COALESCE(SUM(amount),0) AS s FROM receivables`);
    assert.equal(Number(rec.rows[0].s), 1250,
      "🔴 рядок злитого клієнта не дорівнює сумі своїх рахунків");
  } finally { await c.end(); scratch.dispose(); }
});

/* ─────────────────────── СТРУКТУРА РОУТА ─────────────────────── */

test("#244 реєстр і перебудова — в ОДНІЙ транзакції", () => {
  /**
   * 🔴 ЩО БУЛО ЗЛАМАНО. Запис у `client_key_alias` стояв ОКРЕМИМ запитом ПЕРЕД
   * транзакцією: падіння перебудови лишало псевдонім у реєстрі, а рядок
   * дебіторки — старим. Наступна спроба діставала 409 «такий псевдонім уже є»,
   * тобто дія була НЕЗАВЕРШЕНОЮ і НЕПОВТОРЮВАНОЮ одночасно.
   */
  const body = mergeRouteBody();
  const begin = body.indexOf('query("BEGIN")');
  const alias = body.indexOf("INSERT INTO client_key_alias");
  const commit = body.indexOf('query("COMMIT")');
  assert.ok(begin > 0 && alias > 0 && commit > 0, "🔴 транзакції або вставки в реєстр більше немає");
  assert.ok(alias > begin,
    "🔴 ЗАПИС У РЕЄСТР ВИЙШОВ ІЗ ТРАНЗАКЦІЇ: падіння перебудови лишить псевдонім у реєстрі, "
    + "і дія стане незавершеною та неповторюваною одночасно");
  assert.ok(alias < commit, "🔴 запис у реєстр опинився після COMMIT");
  assert.match(body, /ROLLBACK/, "🔴 зник відкіт — часткове злиття лишалось би в базі");
  // Ліміти зводить ЯДРО, а не SQL на місці: інакше правило існувало б удруге.
  assert.match(body, /mergeLimits\.mergedLimitDays\(/, "🔴 дні зводяться повз ядро");
  assert.match(body, /mergeLimits\.mergedLimitAmount\(/, "🔴 сума зводиться повз ядро");
  assert.match(body, /mergeLimits\.mergedLimitNote\(/,
    "🔴 журнал ліміту більше не пишеться — слід відмови «0 ₴» зникне безслідно");
});

/**
 * #248 — ПРАВО ПЕРШИМ, СКОУП ДРУГИМ.
 *
 * `#199cg` стверджує, що вираз скоупу ОДИН на всі пʼять місць. Тут — те, чого
 * в решти чотирьох немає: у цього роута ПЕРЕД скоупом стоїть ще й право, і
 * порядок між ними не косметика. Валідація тіла або похід у БД перед гейтом
 * дали б 400/500 замість 403 і зламали гарантію матриці «403 == спрацював
 * гейт» — на цьому вже раз відкочували прод (04.08.2026).
 */
test("#248 у обʼєднанні право стоїть ПЕРЕД скоупом і перед будь-яким походом у БД", () => {
  const body = mergeRouteBody();
  const perm = body.indexOf('roleHasPerm(auth.roleKey, "merge_receivables")');
  const scope = body.indexOf("receivablesScope(auth");
  const firstDb = body.indexOf("await pool.");
  assert.ok(perm > 0, "🔴 гейт права зник із обʼєднання");
  assert.ok(scope > perm,
    "🔴 СКОУП РАХУЄТЬСЯ ДО ПЕРЕВІРКИ ПРАВА — відповідь чужій ролі перестала бути чистим 403");
  assert.ok(firstDb < 0 || firstDb > perm,
    "🔴 роут іде в БД до перевірки права: 500 замість 403 ламає гарантію матриці");
  // Скоуп не просто ПОРАХОВАНО — він ВИКОРИСТАНИЙ. Перша редакція дзеркала в
  // `#199cg` була беззуба саме на цьому: `void mine;` лишав її зеленою.
  assert.match(body, /visibleKeys/,
    "🔴 скоуп пораховано і не використано — вираз спільний, а межі немає");
  assert.match(body, /status\(403\)/, "🔴 зникла відмова для клієнта поза скоупом");
});
