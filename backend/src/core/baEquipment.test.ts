import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  shiftYm, monthBounds, defaultTtnMonth, ttnPct, TTN_NORM_PCT, kommoTtnFilterUrl, isYm,
} from "./baRules.js";
import { parseEquipmentSheet, matchEmployee, dmyToIso } from "./baEquipmentImport.js";

/**
 * 🗂 БІЗНЕС-АСИСТЕНТ, прохід 2 (29.09.2026): Облік техніки й ТТН-моніторинг — гейти `#960`–`#967`.
 * Номери з запасом над `#936` (найвищий у `main` на момент початку); борг 17 — перед мержем перемірити.
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");

/**
 * #960 — МІСЯЦІ Й % ТТН. Місяць за замовчуванням — «два тому» (1 жовтня перевіряють серпень, і
 * на межі року теж); межі місяця — з останнім днем включно; без угод — «—», а не 0%; норма 70.
 * 🧨 Червоніє, якщо зсунути місяць на один, зрізати останній день, або віддати 0% без угод.
 */
test("#960 ТТН: місяць «два тому», межі включно, без угод — «—», норма 70%", () => {
  assert.equal(defaultTtnMonth("2026-10-01"), "2026-08", "🔴 1 жовтня мусить відкриватись серпень");
  assert.equal(defaultTtnMonth("2026-10-31"), "2026-08");
  assert.equal(defaultTtnMonth("2027-01-15"), "2026-11", "🔴 перехід через рік");
  assert.equal(defaultTtnMonth("2027-02-01"), "2026-12");
  assert.equal(shiftYm("2026-01", -1), "2025-12");
  assert.equal(shiftYm("2026-12", 1), "2027-01");
  assert.deepEqual(monthBounds("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(monthBounds("2028-02"), { from: "2028-02-01", to: "2028-02-29" }, "🔴 високосний лютий");
  assert.deepEqual(monthBounds("2026-08"), { from: "2026-08-01", to: "2026-08-31" }, "🔴 зрізано останній день місяця");
  assert.equal(ttnPct(0, 0), null, "🔴 без угод — «—», а не 0%");
  assert.equal(ttnPct(7, 10), 70);
  assert.equal(ttnPct(2, 3), 67);
  assert.equal(ttnPct(0, 5), 0, "угоди є, ТТН немає — це справжній 0%");
  assert.equal(TTN_NORM_PCT, 70);
  assert.ok(isYm("2026-08") && !isYm("2026-13") && !isYm("08.2026"));
});

/**
 * #961 — ПОСИЛАННЯ НА KOMMO == ФІЛЬТР ДАШІ. Параметри — рівно ті, що в її посиланні (29.09.2026):
 * закриття, «Безнал з ПДВ» і «Безнал без ПДВ», воронка 8921932 статус 142, відповідальний, місяць.
 * 🧨 Червоніє, якщо загубити одне із значень форми оплати, статус чи межу місяця.
 */
test("#961 ТТН: посилання на Kommo — рівно фільтр Даші для менеджера й місяця", () => {
  const u = new URL(kommoTtnFilterUrl("https://utsercice.kommo.com/", 3890083, "2024-11"));
  assert.equal(u.origin + u.pathname, "https://utsercice.kommo.com/leads/list/pipeline/8921932/");
  const p = u.searchParams;
  assert.equal(p.get("filter_date_switch"), "closed");
  assert.deepEqual(p.getAll("filter[cf][2097629][]"), ["6342295", "6342297"], "🔴 форма оплати не та");
  assert.equal(p.get("filter_date_from"), "01.11.2024");
  assert.equal(p.get("filter_date_to"), "30.11.2024");
  assert.deepEqual(p.getAll("filter[pipe][8921932][]"), ["142"], "🔴 статус «успішна угода» загублено");
  assert.deepEqual(p.getAll("filter[main_user][]"), ["3890083"]);
  assert.equal(p.get("useFilter"), "y");
});

/** Фікстура: схема з нуля + автор. */
async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  await c.query(`INSERT INTO users (id, email, password_hash, role, is_active) VALUES (901, 'ba@test', 'x', 'admin', true)`);
  return { c, db: c as unknown as import("./baClaims.js").Db, dispose: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #962 — ЖИВИЙ SQL ТТН: підрахунок угод == фільтр Даші, по обидва боки КОЖНОЇ умови. Рахуються
 * лише: воронка 8921932, статус 142, безнал з/без ПДВ, закриття в місяці ЗА КИЄВОМ. Не рахуються:
 * готівка, інша воронка, неуспішна, закрита 31.07 23:30 за Києвом (= 20:30 UTC) і 01.09 00:30 за
 * Києвом (= 31.08 21:30 UTC). Збереження фіксує знімок; наявних більше, ніж угод, — 400.
 * ⚠️ На ПРОД-сервері бінарів PostgreSQL немає → `skip` через `skipReason()` і `ALLOWED_PROD_SKIPS`.
 * 🧨 Червоніє, якщо прибрати будь-яку умову фільтра або межу місяця за Києвом.
 */
test("#962 ЖИВИЙ SQL ТТН: угоди == фільтр Даші, межі місяця за Києвом, знімок при збереженні", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { ttnDealsByManager, saveTtnCheck, ttnMonth } = await import("./baTtn.js");
  const { c, db } = s;
  try {
    await c.query(`INSERT INTO managers (id, name, kommo_user_id) VALUES (11, 'Андрусенко', 3890083), (12, 'Цалко', 3890084)`);
    const deal = (id: number, mgr: number, over: Partial<{ pipe: number; st: number; pay: string; at: string }> = {}) =>
      c.query(`INSERT INTO deals (kommo_id, manager_id, pipeline_id, status_id, payment_type, closed_at_kommo) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, mgr, over.pipe ?? 8921932, over.st ?? 142, over.pay ?? "Безнал с НДС", over.at ?? "2026-08-15 12:00:00+03"]);
    await deal(1, 11);                                              // рахується
    await deal(2, 11, { pay: "Безнал без НДС" });                   // рахується
    await deal(3, 11, { at: "2026-08-31 23:30:00+03" });            // рахується: останній день, пізно ввечері
    await deal(4, 11, { at: "2026-08-01 00:10:00+03" });            // рахується: перший день, одразу після півночі
    await deal(5, 11, { pay: "Наличные" });                         // ні: готівка
    await deal(6, 11, { pay: "ВАЛЮТА" });                           // ні: валюта
    await deal(7, 11, { pipe: 155304 });                            // ні: інша воронка
    await deal(8, 11, { st: 143 });                                 // ні: неуспішна
    await deal(9, 11, { at: "2026-07-31 23:30:00+03" });            // ні: липень за Києвом
    await deal(10, 11, { at: "2026-09-01 00:30:00+03" });           // ні: вересень за Києвом
    await deal(20, 12);                                             // інший менеджер
    const m = await ttnDealsByManager(db, "2026-08");
    assert.equal(m.get(11), 4, `🔴 угод Андрусенка ${m.get(11)} замість 4 — фільтр або межа місяця розійшлись із фільтром Даші`);
    assert.equal(m.get(12), 1);

    await assert.rejects(saveTtnCheck(db, 901, "2026-08", 11, { ttnPresent: 5 }), /більше, ніж угод/, "🔴 наявних більше, ніж угод, прийнято");
    await saveTtnCheck(db, 901, "2026-08", 11, { ttnPresent: 3, note: "маршрут 2 не збігся" });
    await deal(21, 11);                                             // CRM змінилась після перевірки
    const v = await ttnMonth(db, "2026-08", "https://utsercice.kommo.com");
    const a = v.rows.find((r) => r.managerId === 11)!;
    assert.equal(a.saved?.dealsNeeded, 4, "🔴 знімок не зафіксував число угод на момент перевірки");
    assert.equal(a.dealsNow, 5, "поточне число з CRM — поруч, а не замість знімка");
    assert.equal(a.saved?.pct, 75);
    assert.equal(a.history.length, 6);
    assert.ok(a.kommoUrl?.includes("filter%5Bmain_user%5D%5B%5D=3890083"));
    const b = v.rows.find((r) => r.managerId === 12)!;
    assert.equal(b.saved, null, "не перевірений менеджер має бути видимим як «не перевірено», а не зникнути");
  } finally { await s.dispose(); }
});

/**
 * #963 — ЖИВИЙ SQL ТЕХНІКИ: видача → повернення → скасування; одна одиниця не буває на руках у
 * двох; звільненому не видати; «звільнений, не повернено» підсвічується, повернене — ні; договір
 * лягає до видачі, а подія — в історію одиниці. Перенесена видача без дати — «дата невідома».
 * 🧨 Червоніє, якщо прибрати частковий унікальний індекс, перевірку звільнення або CHECK дати.
 */
test("#963 ЖИВИЙ SQL ТЕХНІКИ: одна відкрита видача, повернення й скасування, звільнений не повернено", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const eq = await import("./baEquipment.js");
  const { insertFile } = await import("./baClaims.js");
  const { c, db } = s;
  const status = (e: unknown) => (e as { status?: number }).status;
  try {
    await c.query(`INSERT INTO employees (id, full_name, import_key, status) VALUES
      (1, 'Антипенко Олег Євгенович', 'k1', 'active'), (2, 'Крицька Діана Ігорівна', 'k2', 'active'), (3, 'Звільнений Петро', 'k3', 'dismissed')`);
    const laptop = await eq.createEquipment(db, 901, { kind: "ноутбук", invNo: "#010122-41", model: "Dell 6430u", price: "7 000" });
    const iss = await eq.issueEquipment(db, 901, laptop, { employeeId: 1, issuedOn: "2026-09-01" });
    await assert.rejects(eq.issueEquipment(db, 901, laptop, { employeeId: 2, issuedOn: "2026-09-02" }), (e) => status(e) === 409,
      "🔴 одиниця видана вдруге, поки перша видача відкрита");
    await assert.rejects(c.query(`INSERT INTO ba_equipment_issues (equipment_id, employee_id, holder_name, issued_on) VALUES ($1, 2, 'x', '2026-09-03')`, [laptop]),
      /uq_ba_equipment_open_issue/, "🔴 база пустила другу відкриту видачу");
    await assert.rejects(eq.issueEquipment(db, 901, laptop, { employeeId: 1 }), /Дата видачі/, "🔴 нова видача без дати");

    await insertFile(db, 901, "issue", iss, { docType: "contract", name: "Договір.pdf", storedName: "ba-x.pdf", mime: "application/pdf", size: 10 });
    await assert.rejects(insertFile(db, 901, "issue", iss, { docType: "lawsuit", name: "x", storedName: "ba-y.pdf", mime: "application/pdf", size: 1 }), /тип документа/);

    await assert.rejects(eq.returnIssue(db, 901, iss, { returnedOn: "2026-08-31" }), /раніша за дату видачі/, "🔴 повернення до видачі прийнято");
    await eq.returnIssue(db, 901, iss, { returnedOn: "2026-09-20" });
    const iss2 = await eq.issueEquipment(db, 901, laptop, { employeeId: 2, issuedOn: "2026-09-21" });
    await assert.rejects(eq.undoReturn(db, 901, iss), (e) => status(e) === 409, "🔴 скасування повернення дало двох власників");
    await eq.returnIssue(db, 901, iss2, { returnedOn: "2026-09-22" });
    await eq.undoReturn(db, 901, iss2);
    let card = await eq.equipmentCard(db, laptop);
    assert.equal(card.holder?.name, "Крицька Діана Ігорівна", "🔴 скасування повернення не повернуло одиницю на руки");
    assert.equal(card.issues.length, 2);
    assert.equal(card.issues.find((x) => x.id === iss)!.files.length, 1, "🔴 договір не лягає до своєї видачі");
    assert.ok(card.events.some((e) => /Договір\.pdf/.test(e.what)), "🔴 подія про договір не в історії одиниці");
    assert.equal(card.price, 7000);

    await assert.rejects(eq.issueEquipment(db, 901, await eq.createEquipment(db, 901, { kind: "мишка" }), { employeeId: 3, issuedOn: "2026-09-01" }),
      /звільнено/, "🔴 техніку видано звільненому");
    // Перенесене з таблиці: видача звільненому ДО звільнення, дата невідома — «звільнений, не повернено».
    const phone = await eq.createEquipment(db, 901, { kind: "телефон" });
    await c.query(`INSERT INTO ba_equipment_issues (equipment_id, employee_id, holder_name, issued_on) VALUES ($1, 3, 'Звільнений Петро', NULL)`, [phone]);
    const list = await eq.listEquipment(db);
    const p = list.find((x) => x.id === phone)!;
    assert.equal(p.holder?.dismissed, true, "🔴 звільнений із технікою на руках не підсвічений");
    assert.equal(p.holder?.issuedOn, null, "перенесена видача без дати — «дата невідома», а не вигадана дата");
    const l = list.find((x) => x.id === laptop)!;
    assert.equal(l.holder?.dismissed, false, "🔴 активного підсвічено як звільненого");

    await assert.rejects(eq.setEquipmentArchived(db, 901, laptop, true), /на руках/, "🔴 списано техніку, що на руках");
  } finally { await s.dispose(); }
});

/**
 * #964 — КОМУ ВИДАТИ: з реєстру співробітників розділ отримує РІВНО id, ПІБ і стан. Реєстр містить
 * телефони, дати народження, ІПН — бізнес-асистенту вони не потрібні й не віддаються.
 * 🧨 Червоніє, якщо в SELECT зʼявиться будь-яка інша колонка.
 */
test("#964 КОМУ ВИДАТИ: з реєстру співробітників — рівно id, ПІБ і стан", () => {
  const src = SRC("core/baEquipment.ts");
  const m = /export async function employeesForIssue[\s\S]*?`SELECT ([^`]*?) FROM employees/.exec(src);
  assert.ok(m, "🔴 запит співробітників не знайдено");
  assert.equal(m[1].replace(/\s+/g, " ").trim(), "id, full_name, status", `🔴 з реєстру читається більше: ${m[1]}`);
  const route = SRC("routes/businessAssistant.ts");
  assert.match(route, /baRouter\.get\("\/employees", async \(req, res\) => \{\s*try \{ onlyBa\(req\); res\.json\(\{ employees: await employeesForIssue\(/,
    "🔴 роут співробітників віддає щось інше, ніж ядро, або без межі");
});

/**
 * #965 — ПРЕТЕНЗІЇ ЗА ТЗ: «сортування за замовчуванням — за датою відправки, нові зверху»;
 * невідправлені — внизу (рішення Романа 29.09.2026: «як у ТЗ»). Перевіряється на справжній базі.
 * 🧨 Червоніє, якщо повернути `NULLS FIRST` або сортувати за датою створення.
 */
test("#965 ЖИВИЙ SQL: претензії — за датою відправки, нові зверху, невідправлені внизу", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { createClaim, listClaims } = await import("./baClaims.js");
  try {
    const none = await createClaim(s.db, 901, { company: "Без дати" });
    const old = await createClaim(s.db, 901, { company: "Стара", sentOn: "2026-08-01" });
    const fresh = await createClaim(s.db, 901, { company: "Нова", sentOn: "2026-09-15" });
    assert.deepEqual((await listClaims(s.db)).map((x) => x.id), [fresh, old, none], "🔴 порядок претензій не за ТЗ");
  } finally { await s.dispose(); }
});

/**
 * #966 — КОМУ ВИДАНО ТЕХНІКУ — ЗАКРИТО ВІД МОДЕЛІ на двох рубежах: REVOKE після GRANT і CREATE, і
 * перелік `FORBIDDEN_TABLES`. Імена людей тут — те саме, що реєстр `employees`.
 * 🧨 Червоніє, якщо прибрати REVOKE, поставити його вище GRANT/CREATE або прибрати з переліку.
 */
test("#966 ba_equipment_issues відібрана в ai_readonly після GRANT і CREATE і є в FORBIDDEN_TABLES", () => {
  const sql = SRC("db/schema.sql");
  const grantAt = sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;");
  const createAt = sql.indexOf("CREATE TABLE IF NOT EXISTS ba_equipment_issues (");
  const revokeAt = sql.indexOf("REVOKE ALL ON ba_equipment_issues FROM ai_readonly;");
  assert.ok(grantAt > 0 && createAt > 0, "🔴 не знайдено GRANT чи CREATE");
  assert.ok(revokeAt > grantAt && revokeAt > createAt, "🔴 REVOKE немає або він вище GRANT/CREATE — на міграції доступ повернеться");
  const list = /FORBIDDEN_TABLES\s*=\s*\[([\s\S]*?)\]/.exec(SRC("ai/metricTools.ts"));
  assert.ok(list && list[1].includes(`"ba_equipment_issues"`), "🔴 не в FORBIDDEN_TABLES");
});

/**
 * #967 — ПЕРЕНЕСЕННЯ ТАБЛИЦІ ДАШІ: розбір на фікстурі з РЕАЛЬНИМИ розкладками таблиці (29.09.2026):
 * блок «Розташування», зсунута дата придбання в колонці посилання, «бн»/«-» як «не заповнено»,
 * «вільний» — без видачі, дати з `,` і `/`; зіставлення з реєстром — однозначне або ніяке.
 * 🧨 Червоніє, якщо читати дату лише з її колонки, прийняти «-» за значення чи зіставити двозначне.
 */
test("#967 ПЕРЕНЕСЕННЯ: розкладка таблиці техніки, сентинели, «вільний», зіставлення з реєстром", () => {
  const H = ["Обліковий №", "Тип", "Модель", "Дата придбання", "Де придбано (посилання", "Ціна", "Коментарій", "Розташування", "Відповідальний", "Користувач", "Дата переміщення"];
  const table = [
    ["", "", "", "", "", "", "", "", "", "", ""],
    ["", "", "Розташування", "Київ 201", "", "", "", "", "", "", ""],
    H,
    ["#24SER00", "камера", "A4Tech", "", "https://rozetka.com.ua/x", "1 299", "", "", "Протас Дар’я", "вільний", "01.07.2025"],
    ["#010122-41", "ноутбук", "Dell 6430u", "", "01.01.2022", "", "-", "-", "Протас Дар’я", "Антипенко Олег Євгенович", "13.12.2023"],
    ["бн", "телефон", "Redmi note 9", "", "", "-", "", "201", "Протас Дар’я", "Крицька Діана", "03,07.2026"],
    ["", "", "", "", "", "", "", "", "", "", ""],
    ["", "мишка", "", "", "", "", "", "", "", "Невідомий Хтось", "14/08/2026"],
  ];
  const { items, skipped } = parseEquipmentSheet(table);
  assert.equal(items.length, 4);
  assert.equal(skipped, 0);
  const [cam, lap, ph, mouse] = items;
  assert.equal(cam.holderName, null, "🔴 «вільний» став видачею");
  assert.equal(cam.location, "Київ 201", "🔴 розташування блоку не підставлено");
  assert.equal(cam.price, 1299);
  assert.equal(cam.purchaseUrl, "https://rozetka.com.ua/x");
  assert.equal(lap.purchasedOn, "2022-01-01", "🔴 дату з колонки посилання загублено");
  assert.equal(lap.purchaseUrl, null);
  assert.equal(lap.comment, "", "🔴 «-» прочитано як коментар");
  assert.equal(lap.location, "Київ 201", "🔴 «-» у розташуванні прочитано як значення");
  assert.equal(ph.invNo, "", "🔴 «бн» прочитано як обліковий номер");
  assert.equal(ph.price, null);
  assert.equal(ph.location, "201");
  assert.equal(ph.movedOn, "2026-07-03", "🔴 дата з комою не розпізнана");
  assert.equal(mouse.movedOn, "2026-08-14", "🔴 дата зі скісною не розпізнана");
  assert.equal(dmyToIso("31.02.2026"), null, "🔴 неіснуюча дата прийнята");
  assert.throws(() => parseEquipmentSheet([["Тип"]]), /шапки/, "🔴 без шапки розбір не зупинився");

  const reg = [{ id: 1, fullName: "Антипенко Олег Євгенович" }, { id: 2, fullName: "Крицька Діана Ігорівна" },
    { id: 3, fullName: "Коваль Іван Петрович" }, { id: 4, fullName: "Коваль Іван Олегович" }];
  assert.equal(matchEmployee("Антипенко Олег Євгенович", reg), 1);
  assert.equal(matchEmployee("Крицька Діана", reg), 2, "🔴 прізвище+імʼя без по батькові не зіставлено");
  assert.equal(matchEmployee("Коваль Іван", reg), null, "🔴 двозначне імʼя зіставлено з першою-ліпшою людиною");
  assert.equal(matchEmployee("Невідомий Хтось", reg), null);
});

/**
 * #968 — ФРОНТ ПРОХОДУ 2: вкладки техніки й ТТН — справжні (не «скоро»), підключені статично
 * (гейт #225: один чанк); перегляд документів переїхав у `BaShared.tsx` і там теж без `window.open`
 * (урок 4310); посилання на Kommo — звичайне `<a>` за кліком.
 * 🧨 Червоніє, якщо повернути «скоро», підвантажити вкладку ліниво або повернути `window.open`.
 */
test("#968 ФРОНТ БА-2: техніка й ТТН — справжні вкладки, статичний імпорт, перегляд без window.open", () => {
  const FE = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
  const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const sec = FE("pages/dashboard/sections/BusinessAssistantSection.tsx");
  assert.match(sec, /\["equip", "Облік техніки", false\], \["ttn", "ТТН-моніторинг", false\]/, "🔴 вкладки техніки чи ТТН досі «скоро»");
  assert.match(sec, /^import \{ BaEquipment \} from "\.\/BaEquipment";$/m, "🔴 облік техніки не статичним імпортом");
  assert.match(sec, /^import \{ BaTtn \} from "\.\/BaTtn";$/m, "🔴 ТТН не статичним імпортом");
  assert.match(sec, /tab === "equip" && <BaEquipment /);
  assert.match(sec, /tab === "ttn" && <BaTtn /);
  for (const f of ["BusinessAssistantSection.tsx", "BaShared.tsx", "BaEquipment.tsx", "BaTtn.tsx"])
    assert.doesNotMatch(codeOnly(FE(`pages/dashboard/sections/${f}`)), /window\.open\(/, `🔴 ${f}: window.open — блокувальник гасить вкладку після очікування`);
  assert.match(FE("pages/dashboard/sections/BaTtn.tsx"), /<a className="hr-link" href=\{r\.kommoUrl\} target="_blank" rel="noopener noreferrer">/, "🔴 посилання на Kommo не звичайним <a>");
});
