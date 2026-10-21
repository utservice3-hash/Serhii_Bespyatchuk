import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  utbMissingFor, utbDocsComplete, needsManagerTask, needsHandlerTask, filterUtb, utbExportRows, UTB_EXPORT_HEAD,
  utbAccessOf, utbOwnerIds, utbDocsLabel, UTB_TASK_PREFIX, type UtbState, type UtbRowLike,
} from "./baUtbRules.js";

/**
 * 🚛 РЕЄСТР УКРТРАНСБЕЗПЕКИ (задача 6269, ТЗ Даші 19.10.2026) — гейти `#1860`–`#1860d`.
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");

const ALL = { decision: true, request: true, ttn: true };
const st = (o: Partial<UtbState> = {}): UtbState => ({ managerId: 11, handlerId: 13, ttnNumber: "TTN-1", comment: "", docs: ALL, ...o });

/**
 * #1860 — ПРАВИЛА РЕЄСТРУ: обовʼязкове зростає зі статусом, по обидва боки КОЖНОЇ вимоги. «Нова» — без вимог;
 * «Збір документів» — постанова + менеджер; «Передано» / «Переведено» — ще заявка, ТТН (файл і номер), відповідальна
 * особа; «Відмовлено» — лише коментар. Сповіщення — одне на людину. Фільтр — обидва кінці періоду включно. Excel — ті самі
 * рядки в тому самому порядку. 🧨 Червоніє, якщо прибрати будь-яку вимогу, дублювати задачу або зрізати кінець періоду.
 */
test("#1860 ПРАВИЛА УТБ: вимоги кожного статусу по обидва боки, одна задача на людину, фільтр включно, Excel = таблиця", () => {
  assert.deepEqual(utbMissingFor("new", st({ managerId: null, handlerId: null, ttnNumber: "", docs: { decision: false, request: false, ttn: false } })), [],
    "🔴 «Нова» чогось вимагає — запис кроку 1 не створиться");
  assert.deepEqual(utbMissingFor("collecting", st()), []);
  assert.deepEqual(utbMissingFor("collecting", st({ docs: { ...ALL, decision: false } })), ["файл заяви / постанови УТБ"], "🔴 збір документів без постанови");
  assert.deepEqual(utbMissingFor("collecting", st({ managerId: null })), ["відповідальний менеджер"], "🔴 збір документів без менеджера — нікому ставити задачу");
  assert.deepEqual(utbMissingFor("collecting", st({ handlerId: null, ttnNumber: "", docs: { decision: true, request: false, ttn: false } })), [],
    "🔴 «Збір документів» вимагає того, що на цьому кроці ще тільки збирають");
  for (const s of ["handed", "transferred"] as const) {
    assert.deepEqual(utbMissingFor(s, st()), [], `🔴 повний комплект не пускає в «${s}»`);
    assert.deepEqual(utbMissingFor(s, st({ docs: { ...ALL, request: false } })), ["файл заявки"], `🔴 «${s}» без заявки`);
    assert.deepEqual(utbMissingFor(s, st({ docs: { ...ALL, ttn: false } })), ["файл ТТН"], `🔴 «${s}» без файла ТТН`);
    assert.deepEqual(utbMissingFor(s, st({ docs: { ...ALL, decision: false } })), ["файл заяви / постанови УТБ"], `🔴 «${s}» без постанови`);
    assert.deepEqual(utbMissingFor(s, st({ ttnNumber: "  " })), ["номер ТТН"], `🔴 «${s}» без номера ТТН (пробіли — не номер)`);
    assert.deepEqual(utbMissingFor(s, st({ handlerId: null })), ["відповідальна особа"], `🔴 «${s}» без відповідальної особи`);
    assert.deepEqual(utbMissingFor(s, st({ managerId: null })), ["відповідальний менеджер"]);
  }
  assert.deepEqual(utbMissingFor("rejected", st({ comment: " " })), ["коментар — чому штраф не переведено"], "🔴 «Відмовлено» без коментаря");
  assert.deepEqual(utbMissingFor("rejected", st({ comment: "перевізник ліквідований", managerId: null, docs: { decision: false, request: false, ttn: false } })), [],
    "🔴 закрити без переведення можна лише з повним комплектом — а ТЗ дозволяє на будь-якому кроці");
  assert.equal(utbDocsComplete(ALL), true);
  for (const k of ["decision", "request", "ttn"] as const) assert.equal(utbDocsComplete({ ...ALL, [k]: false }), false, `🔴 комплект без «${k}» названо повним`);
  assert.equal(utbDocsLabel(ALL), "повний комплект");
  assert.equal(utbDocsLabel({ decision: true, request: false, ttn: false }), "бракує: заявка, ТТН");

  assert.equal(needsManagerTask(11, null), true, "🔴 менеджера призначено — задачі немає");
  assert.equal(needsManagerTask(11, 11), false, "🔴 повторне збереження того самого менеджера дублює задачу");
  assert.equal(needsManagerTask(12, 11), true, "🔴 новий менеджер не отримав задачу");
  assert.equal(needsManagerTask(null, 11), false);
  assert.equal(needsHandlerTask("collecting", "handed", 13, null), true, "🔴 «Передано» — відповідальна особа без задачі");
  assert.equal(needsHandlerTask("handed", "handed", 13, null), false, "🔴 повторне збереження «Передано» ставить ще одну задачу");
  assert.equal(needsHandlerTask("collecting", "handed", 13, 13), false, "🔴 повернення в «Передано» тій самій особі дублює задачу");
  assert.equal(needsHandlerTask("collecting", "transferred", 13, null), false, "🔴 задача особі не на кроці «Передано»");
  assert.equal(needsHandlerTask("collecting", "handed", null, null), false);

  const row = (ep: string, on: string, o: Partial<UtbRowLike> = {}): UtbRowLike => ({ epNumber: ep, receivedOn: on, carrier: "ФОП Жебрун", fineAmount: 17000,
    managerId: 11, managerName: "Яцик", handlerName: "Мокляк", status: "new", docs: ALL, ttnNumber: "", comment: "", ...o });
  const rows = [row("ВП-100", "2026-10-01"), row("ВП-200", "2026-10-31", { carrier: "ТОВ Вектор", managerId: 12, status: "handed" }), row("вп-300", "2026-11-01")];
  const ep = (f: Parameters<typeof filterUtb>[1]) => filterUtb(rows, f).map((r) => r.epNumber);
  assert.deepEqual(ep({ from: "2026-10-01", to: "2026-10-31" }), ["ВП-100", "ВП-200"], "🔴 кінець періоду зрізано або захоплено наступний день");
  assert.deepEqual(ep({ q: "вп-3" }), ["вп-300"]);
  assert.deepEqual(ep({ q: "ВП-3" }), ["вп-300"], "🔴 пошук за № ВП чутливий до регістру");
  assert.deepEqual(ep({ carrier: "вектор" }), ["ВП-200"]);
  assert.deepEqual(ep({ managerId: 12 }), ["ВП-200"]);
  assert.deepEqual(ep({ status: "handed" }), ["ВП-200"]);
  assert.deepEqual(ep({}), ["ВП-100", "ВП-200", "вп-300"], "🔴 порожній фільтр щось відкинув");
  const x = utbExportRows(rows);
  assert.deepEqual(x[0], [...UTB_EXPORT_HEAD]);
  assert.deepEqual(x.slice(1).map((r) => r[0]), ["ВП-100", "ВП-200", "вп-300"], "🔴 в Excel не ті рядки або не той порядок, що в таблиці");
  assert.deepEqual(x[1].slice(0, 4), ["ВП-100", "01.10.2026", "ФОП Жебрун", 17000]);
  assert.equal(x[2][6], "Передано");
});

/**
 * #1860b — ДОСТУП ДО РЕЄСТРУ (Роман 21.10.2026: «Операційний директор і адміни бачать, а веде Даша»). Дзеркало:
 * власник ВЕДЕ, адмін і ОД БАЧАТЬ, СЕО / КВП / бізнес-асистент / менеджер — НІЧОГО, хоч вкладку `ba` частина з них має.
 * Роут: кожен обробник `/utb*` першим оператором кличе `utbGate`, читання — `view`, запис — `edit`.
 * 🧨 Червоніє, якщо дати перегляд СЕО чи КВП, запис адміну-невласнику, або поставити запис за `view`.
 */
test("#1860b ДОСТУП УТБ: веде власник поіменно, бачать admin і opdir, решті — нічого; роути з тим самим вироком", () => {
  const owners = ["52"];
  assert.equal(utbAccessOf(52, "admin", owners), "edit", "🔴 Даша не веде реєстр");
  assert.equal(utbAccessOf(52, "business_assistant", owners), "edit", "🔴 власник веде лише поки адмін — роль не має знімати власність");
  assert.equal(utbAccessOf(50, "admin", owners), "view", "🔴 адмін-невласник пише в реєстр або не бачить його");
  assert.equal(utbAccessOf(1, "opdir", owners), "view", "🔴 операційний директор не бачить реєстру");
  for (const r of ["ceo", "kvp", "business_assistant", "financier", "hr", "team_lead", "manager", "candidate"]) {
    assert.equal(utbAccessOf(77, r, owners), null, `🔴 роль «${r}» бачить реєстр, хоча рішення — лише адміни й ОД`);
  }
  assert.equal(utbAccessOf(null, null, owners), null);
  assert.deepEqual(utbOwnerIds("52, 7"), ["52", "7"]);
  assert.deepEqual(utbOwnerIds(undefined), ["52"]);
  assert.deepEqual(utbOwnerIds("сміття"), ["52"], "🔴 зіпсоване ENV лишило реєстр без власника");

  const src = SRC("routes/businessAssistant.ts");
  // Кожен обробник `/utb*` — окремо: першим межа розділу (`#772b`), ДРУГИМ — межа реєстру з потрібним вироком.
  const seen: string[] = [];
  for (const m of src.matchAll(/baRouter\.(get|post|patch)\("(\/utb[^"]*)", /g)) {
    const key = `${m[1].toUpperCase()} ${m[2]}`;
    const tail = src.slice(m.index! + m[0].length, src.indexOf("baRouter.", m.index! + 1));
    const need = m[1] === "get" ? "view" : "edit";
    assert.match(tail, new RegExp(`^async \\(req, res\\) => \\{\\s*try \\{\\s*onlyBa\\(req\\); utbGate\\(req, "${need}"\\);`), `🔴 ${key}: не «onlyBa → utbGate(req, "${need}")» на початку`);
    seen.push(key);
  }
  assert.deepEqual(seen.sort(), ["GET /utb", "GET /utb/:id", "GET /utb/:id/files/:fileId", "GET /utb/carriers", "GET /utb/export.xlsx", "GET /utb/managers",
    "PATCH /utb/:id", "POST /utb", "POST /utb/:id/files"].sort(), "🔴 роут реєстру без межі або гейт його не бачить");
});

/** Фікстура: схема з нуля, власник реєстру й три менеджери. */
async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  await c.query(`INSERT INTO users (id, email, password_hash, role, is_active, full_name) VALUES (52, 'dasha@test', 'x', 'admin', true, 'Дарʼя Протас')`);
  await c.query(`INSERT INTO managers (id, name, kommo_user_id) VALUES (11, 'Яцик', 1), (12, 'Цалко', 2), (13, 'Мокляк', 3)`);
  return { c, db: c as unknown as import("./baClaims.js").Db, dispose: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #1860c — ЖИВИЙ SQL РЕЄСТРУ на схемі з нуля: процес ТЗ від «Нова» до «Передано» і закриття, по обидва боки кожної
 * межі. Створення — «Нова» з історією; повтор № ВП (інший регістр і пробіли) — 409; кожен крок без свого — 400 і запис
 * НЕ змінився; задача менеджеру — одна на менеджера, особі — одна на «Передано»; список із фільтром == `filterUtb`.
 * ⚠️ На ПРОД-сервері бінарів PostgreSQL немає → `skip` через `skipReason()` і `ALLOWED_PROD_SKIPS`.
 * 🧨 Червоніє, якщо зняти перевірку статусу, унікальність № ВП або памʼять «кому вже ставили задачу».
 */
test("#1860c ЖИВИЙ SQL УТБ: процес ТЗ по кроках, 400 без свого і без змін, № ВП унікальний, задачі без дублів", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { createUtb, updateUtb, utbCard, listUtb } = await import("./baUtb.js");
  const { insertFile } = await import("./baClaims.js");
  const { c, db } = s;
  const file = (id: number, docType: string) => insertFile(db, 52, "utb", id, { docType, name: `${docType}.pdf`, storedName: `ba-${docType}-${String(id)}.pdf`, mime: "application/pdf", size: 10 });
  const tasks = async (mgr: number) => Number((await c.query(`SELECT count(*) n FROM tasks WHERE assignee_id = $1`, [mgr])).rows[0].n);
  const status = async (id: number) => (await c.query(`SELECT status FROM ba_utb_cases WHERE id = $1`, [id])).rows[0].status as string;
  const code = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e: any) { return e?.status ?? 500; } };
  try {
    const id = await createUtb(db, 52, { epNumber: "ВП-77001", receivedOn: "2026-10-19", carrier: "ФОП Жебрун", fineAmount: "17 000" });
    assert.equal(await status(id), "new");
    assert.equal(await code(createUtb(db, 52, { epNumber: "  вп-77001 ", receivedOn: "2026-10-20", carrier: "Х", fineAmount: 1 })), 409, "🔴 той самий № ВП (регістр, пробіли) — другий запис");
    assert.equal(await code(createUtb(db, 52, { epNumber: "ВП-2", receivedOn: "2026-10-20", carrier: "", fineAmount: 1 })), 400, "🔴 запис без перевізника");
    assert.equal(await code(createUtb(db, 52, { epNumber: "ВП-3", receivedOn: "2026-10-20", carrier: "Х", fineAmount: -5 })), 400, "🔴 відʼємна сума штрафу");

    assert.equal(await code(updateUtb(db, 52, id, { status: "collecting", managerId: 11 })), 400, "🔴 «Збір документів» без постанови");
    assert.equal(await status(id), "new", "🔴 відмова все одно змінила статус");
    assert.equal(await tasks(11), 0, "🔴 відмовлене збереження поставило задачу");
    await file(id, "utb_decision");
    await updateUtb(db, 52, id, { status: "collecting", managerId: 11 });
    assert.equal(await status(id), "collecting");
    assert.equal(await tasks(11), 1, "🔴 менеджер не отримав задачу при призначенні");
    const tk = (await c.query(`SELECT title, reviewer_id, deadline FROM tasks WHERE assignee_id = 11`)).rows[0];
    assert.match(tk.title, /ВП № ВП-77001/); assert.equal(tk.reviewer_id, 52, "🔴 задачу приймає не власник реєстру"); assert.equal(tk.deadline, null, "🔴 ТЗ: дедлайни не ведуться");
    await updateUtb(db, 52, id, { managerId: 11, comment: "чекаю" });
    assert.equal(await tasks(11), 1, "🔴 повторне збереження того самого менеджера — друга задача");
    await updateUtb(db, 52, id, { managerId: 12 });
    assert.equal(await tasks(12), 1, "🔴 новий менеджер без задачі");

    assert.equal(await code(updateUtb(db, 52, id, { status: "handed", handlerId: 13, ttnNumber: "59001234567890" })), 400, "🔴 «Передано» без заявки й ТТН");
    assert.equal(await status(id), "collecting");
    assert.equal(await tasks(13), 0);
    await file(id, "request");
    assert.equal(await code(updateUtb(db, 52, id, { status: "handed", handlerId: 13, ttnNumber: "59001234567890" })), 400, "🔴 «Передано» без файла ТТН");
    await file(id, "ttn");
    assert.equal(await code(updateUtb(db, 52, id, { status: "handed", handlerId: 13, ttnNumber: "" })), 400, "🔴 «Передано» без номера ТТН");
    await updateUtb(db, 52, id, { status: "handed", handlerId: 13, ttnNumber: "59001234567890" });
    assert.equal(await status(id), "handed");
    assert.equal(await tasks(13), 1, "🔴 відповідальна особа без задачі на «Передано»");
    await updateUtb(db, 52, id, { status: "handed", comment: "ще раз" });
    assert.equal(await tasks(13), 1, "🔴 повторне «Передано» — друга задача особі");

    assert.equal(await code(updateUtb(db, 52, id, { status: "rejected", comment: "" })), 400, "🔴 «Відмовлено» без коментаря");
    await updateUtb(db, 52, id, { status: "transferred" });
    assert.equal(await status(id), "transferred");

    const card = await utbCard(db, id);
    assert.deepEqual(card.docs, { decision: true, request: true, ttn: true });
    assert.equal(card.fileList.length, 3);
    assert.ok(card.events.some((e) => /Статус → «Передано»/.test(e.what)) && card.events.some((e) => /задачу/.test(e.what)), "🔴 історія без статусу чи задачі");
    assert.ok(card.events.every((e) => e.actor === "Дарʼя Протас"), "🔴 історія без автора дії");

    const id2 = await createUtb(db, 52, { epNumber: "ВП-77002", receivedOn: "2026-11-02", carrier: "ТОВ Вектор", fineAmount: 3400, managerId: 13 });
    assert.equal(await tasks(13), 2, "🔴 менеджер, вказаний одразу при створенні, без задачі");
    await updateUtb(db, 52, id2, { status: "rejected", comment: "перевізник ліквідований" });
    assert.deepEqual((await listUtb(db, { from: "2026-10-01", to: "2026-10-31" })).map((r) => r.id), [id], "🔴 фільтр періоду в базі ≠ filterUtb");
    assert.deepEqual((await listUtb(db, {})).map((r) => r.id), [id2, id], "🔴 нові надходження не зверху");
  } finally { await s.dispose(); }
});

/**
 * #1860d — ФРОНТ РЕЄСТРУ: вкладка пʼята й лише для тих, кому сервер віддав доступ; перегляд — без кнопок запису;
 * статичний імпорт (один чанк, `#225`); перегляд файлів — тим самим блоком документів, Excel — через api з тими самими
 * фільтрами. 🧨 Червоніє, якщо показати вкладку всім, лишити «Зберегти» на перегляді або імпортувати ліниво.
 */
test("#1860d ФРОНТ УТБ: пʼята вкладка за доступом, перегляд без запису, статичний імпорт, Excel з тими самими фільтрами", () => {
  const sec = FE("pages/dashboard/sections/BusinessAssistantSection.tsx");
  assert.match(sec, /import \{ BaUtb \} from "\.\/BaUtb";/, "🔴 вкладку імпортовано не статично");
  assert.match(sec, /\["ttn", "ТТН-моніторинг", false\], \.\.\.\(meta\.utbAccess \? \[\["utb", "Реєстр Укртрансбезпеки", false\]\] as \[Tab, string, boolean\]\[\] : \[\]\)\]/,
    "🔴 «Реєстр Укртрансбезпеки» не пʼятий після «ТТН-моніторингу» або показаний без доступу");
  assert.match(sec, /\{tab === "utb" && meta\.utbAccess && <BaUtb meta=\{meta\} access=\{meta\.utbAccess\} toast=\{toast\} \/>\}/);
  const utb = FE("pages/dashboard/sections/BaUtb.tsx");
  assert.doesNotMatch(utb, /\blazy\(|\bimport\(/, "🔴 лінивий імпорт — другий чанк");
  assert.match(utb, /const canEdit = access === "edit";/);
  const btnLines = utb.split("\n").filter((l) => />\+ Запис<|"Створити" : "Зберегти"/.test(l));
  assert.equal(btnLines.length, 2, "🔴 не знайдено кнопок «+ Запис» і «Створити / Зберегти»");
  for (const l of btnLines) assert.match(l, /\{canEdit && <button/, `🔴 кнопка запису видна на перегляді: ${l.trim()}`);
  assert.equal((utb.match(/disabled=\{!canEdit\}/g) ?? []).length >= 8, true, "🔴 поля картки редагуються на перегляді");
  assert.match(utb, /<Docs kind="utb" ownerId=\{card\.id\} files=\{card\.fileList\} types=\{meta\.utbDocTypes\} maxBytes=\{meta\.fileMaxBytes\} toast=\{toast\} onAdded=\{[^}]*\}[^>]*readOnly=\{!canEdit\} \/>/,
    "🔴 документи не тим самим блоком або перегляд може додавати файли");
  assert.match(utb, /downloadBaUtbXlsx\(filter\)/, "🔴 Excel не з тими самими фільтрами, що таблиця");
  assert.match(utb, /fetchBaUtb\(filter\)/);
  const shared = FE("pages/dashboard/sections/BaShared.tsx");
  assert.match(shared, /\{!readOnly && <>[\s\S]*Додати документ/, "🔴 блок документів не вміє бути лише для перегляду");
});

/**
 * #1860e — ПЕРЕВІЗНИК: ВИБІР / ТЕКСТ (ТЗ). Підказки — з CRM (назва перевізника в заявках на оплату, `deals.carrier_name`)
 * і з уже внесених у реєстр; частіші вище; пошук — входження без регістру; порожні назви не підказуються; не більше 20.
 * ⚠️ На ПРОД-сервері бінарів PostgreSQL немає → `skip` через `skipReason()` і `ALLOWED_PROD_SKIPS`.
 * 🧨 Червоніє, якщо брати перевізників не з CRM, загубити внесених у реєстр або зробити пошук чутливим до регістру.
 */
test("#1860e ЖИВИЙ SQL ПЕРЕВІЗНИКІВ: підказки з заявок CRM і реєстру, частіші вище, пошук без регістру", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { utbCarriers, createUtb } = await import("./baUtb.js");
  const { c, db } = s;
  try {
    const deal = (id: number, name: string | null, edrpou: string | null = null) =>
      c.query(`INSERT INTO deals (kommo_id, carrier_name, carrier_edrpou) VALUES ($1, $2, $3)`, [id, name, edrpou]);
    await deal(1, "ТОВ «Еміс Транс»", "12345678"); await deal(2, "ТОВ «Еміс Транс»"); await deal(3, "ТОВ «Еміс Транс»");
    await deal(4, "ФОП Супрунюк"); await deal(5, "   "); await deal(6, null);
    await createUtb(db, 52, { epNumber: "ВП-1", receivedOn: "2026-10-01", carrier: "ФОП Жебрун", fineAmount: 100 });
    const all = await utbCarriers(db, "");
    assert.deepEqual(all.map((x) => x.name), ["ТОВ «Еміс Транс»", "ФОП Жебрун", "ФОП Супрунюк"], "🔴 частіший перевізник не зверху або порожня назва в підказках");
    assert.equal(all[0].edrpou, "12345678", "🔴 ЄДРПОУ з заявки загубився");
    assert.deepEqual((await utbCarriers(db, "жебрун")).map((x) => x.name), ["ФОП Жебрун"], "🔴 внесений у реєстр перевізник не підказується");
    assert.deepEqual((await utbCarriers(db, "ЕМІС")).map((x) => x.name), ["ТОВ «Еміс Транс»"], "🔴 пошук чутливий до регістру");
    assert.deepEqual(await utbCarriers(db, "нема-такого"), []);
    for (let i = 0; i < 30; i++) await deal(100 + i, `ТОВ Перевізник ${String(i)}`);
    assert.equal((await utbCarriers(db, "перевізник")).length, 20, "🔴 підказок більше за 20 — список на сотні рядків");
  } finally { await s.dispose(); }
});

interface UtbNotifyMod {
  UTB_TASK_PREFIX: string;
  isUtbTaskAlert: (t: { id: number; title: string; status: string; assigneeId?: number | null; createdAt?: string | null },
    known: ReadonlyMap<number, { status: string; closeReason: string | null }> | null, me: number | null | undefined, mountedAtMs: number) => boolean;
  utbTaskAlertText: (titles: string[]) => string | null;
  isClientTaskAlert: UtbNotifyMod["isUtbTaskAlert"];
}
/**
 * #1860f — ЗАДАЧА З РЕЄСТРУ ПРИХОДИТЬ ТОСТОМ ЗІ ЗВУКОМ (Роман 21.10.2026: «і звук додай»). Префікс фронту == бекенду
 * (інакше сповіщення замовкне тихо); нова моя — так; відома, чужа, закрита, без префікса — ні; до першого опитування —
 * лише свіжі. Дашборд кличе `notifyEvent` (тост + `playNotifySound` + системне). Підказки перевізника — `datalist`.
 * 🧨 Червоніє, якщо розвести префікси, дзвонити на кожному опитуванні або прибрати виклик із дашборда.
 */
test("#1860f СПОВІЩЕННЯ УТБ: префікс фронту == бекенду, лише нова й своя, тост зі звуком; перевізник з підказками", async () => {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE("pages/dashboard/signalTaskNotify.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const N = await import(`data:text/javascript,${encodeURIComponent(js)}`) as UtbNotifyMod;
  assert.equal(N.UTB_TASK_PREFIX, UTB_TASK_PREFIX, "🔴 префікс фронту розійшовся з бекендом — сповіщення замовкне тихо");
  assert.match(SRC("core/baUtb.ts"), /`\$\{UTB_TASK_PREFIX\} передати заявку і ТТН/, "🔴 задача менеджеру без префікса — тосту не буде");
  assert.match(SRC("core/baUtb.ts"), /`\$\{UTB_TASK_PREFIX\} перевести штраф на перевізника/, "🔴 задача особі без префікса — тосту не буде");
  const MOUNT = Date.parse("2026-10-21T10:00:00Z");
  const t = (id: number, o: Partial<{ title: string; status: string; assigneeId: number; createdAt: string }> = {}) =>
    ({ id, title: `${UTB_TASK_PREFIX} передати заявку і ТТН — ВП № 1`, status: "not_started", assigneeId: 7, createdAt: "2026-10-21T10:05:00Z", ...o });
  const known = new Map([[1, { status: "not_started", closeReason: null }]]);
  assert.equal(N.isUtbTaskAlert(t(9), known, 7, MOUNT), true, "🔴 нова задача з реєстру прийшла мовчки");
  assert.equal(N.isUtbTaskAlert(t(1), known, 7, MOUNT), false, "🔴 відома задача дзвонить на кожному опитуванні");
  assert.equal(N.isUtbTaskAlert(t(9), known, 8, MOUNT), false, "🔴 дзвонить чужому менеджеру");
  assert.equal(N.isUtbTaskAlert(t(9, { status: "done" }), known, 7, MOUNT), false);
  assert.equal(N.isUtbTaskAlert(t(9, { title: "Інша задача" }), known, 7, MOUNT), false, "🔴 дзвонить будь-якою задачею");
  assert.equal(N.isUtbTaskAlert(t(9, { createdAt: "2026-10-20T10:00:00Z" }), null, 7, MOUNT), false, "🔴 до першого опитування дзвонить старими задачами");
  assert.equal(N.isUtbTaskAlert(t(9), null, 7, MOUNT), true);
  assert.equal(N.isClientTaskAlert(t(9), known, 7, MOUNT), false, "🔴 задача УТБ дзвонить як «переданий клієнт»");
  assert.equal(N.utbTaskAlertText([`${UTB_TASK_PREFIX} передати заявку і ТТН — ВП № 7`]), "передати заявку і ТТН — ВП № 7 — задача в Задачнику.");
  assert.equal(N.utbTaskAlertText([]), null);
  const dash = FE("pages/Dashboard.tsx");
  assert.match(dash, /const utbText = utbTaskAlertText\(fresh\.filter\(\(t\) => isUtbTaskAlert\(t, known, auth\?\.managerId, mountedAt\.current\)\)\.map\(\(t\) => t\.title\)\);\s*if \(utbText\) notifyEvent\(\{/,
    "🔴 дашборд не показує задачі з реєстру тостом");
  assert.ok(dash.indexOf("const utbText") < dash.indexOf("signalKnown.current = new Map(fresh"), "🔴 перевірка після оновлення відомих — нова задача вже «відома» і мовчить");
  assert.match(dash, /playNotifySound\(o\.success\);/, "🔴 notifyEvent без звуку");
  const utb = FE("pages/dashboard/sections/BaUtb.tsx");
  assert.match(utb, /list="utb-carriers"/); assert.match(utb, /<datalist id="utb-carriers">/, "🔴 перевізник лише текстом, без вибору");
  assert.match(utb, /fetchBaUtbCarriers\(form\.carrier\)/);
});
